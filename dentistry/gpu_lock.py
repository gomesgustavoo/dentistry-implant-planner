"""Cross-service GPU mutex: one Postgres advisory lock that every GPU service on a
host takes before it loads a model.

Time-slicing a GPU between pods partitions **compute, not VRAM**, so when several
services share one card (this worker, other inference services, a training run), the
only thing stopping two 3-D models being resident at once is this mutex. A worker
that has the GPU to itself skips it with `DENT_GPU_LOCK=off` (see `worker/tf3.py`).

A Postgres **session-level advisory lock** is the right primitive: it belongs to a
connection, so a crash releases it with no stale-lock reaper to get wrong;
`pg_advisory_lock` blocks and queues rather than failing, which is what a background
job wants. Advisory locks are per-database, so the lock lives on its own empty
database (`GPU_LOCK_DSN`) that every sharing service connects to with nothing but
CONNECT rights.

Every service sharing the card MUST use the same `GPU_LOCK_KEY`. Changing it here
silently un-shares the lock and lets two models onto the card.

`chunked_lease` is the one addition: a long training run cannot hold the mutex
for two days, and cannot poll with `pg_try_advisory_lock` either, because `try`
does not respect the wait queue and would let the trainer barge ahead of a
production job forever.
"""

from __future__ import annotations

import contextlib
import logging
import os
import threading
import time
from typing import Callable, Iterator

from sqlalchemy import create_engine, text

log = logging.getLogger("dentistry.gpulock")

# "vx_gpu" -- must match every other service that shares the GPU. Do not change.
GPU_LOCK_KEY = 0x76785F677075

_engine = None
_engine_lock = threading.Lock()


def _dsn() -> str:
    return os.environ.get("GPU_LOCK_DSN", "")


def _get_engine():
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                # One dedicated connection: a session-level advisory lock belongs to
                # the connection that took it, so the same one must release it.
                _engine = create_engine(
                    _dsn(), pool_pre_ping=True, pool_size=1, max_overflow=0, echo=False
                )
    return _engine


@contextlib.contextmanager
def gpu_lock(on_wait: Callable[[], None] | None = None) -> Iterator[None]:
    """Hold the GPU for the duration of the block.

    `on_wait()` fires once if the GPU is busy, so the caller can surface
    "waiting for GPU" instead of leaving a job looking stalled.
    """
    if not _dsn():
        log.info("GPU mutex disabled (GPU_LOCK_DSN unset)")
        yield
        return

    conn = _get_engine().connect()
    try:
        started = time.monotonic()
        # Try without blocking first, so the common case (free GPU) costs nothing
        # and we only report a wait when there really is one.
        got = conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": GPU_LOCK_KEY}).scalar()
        if not got:
            if on_wait is not None:
                on_wait()
            log.info("waiting for the GPU (held by another service)")
            conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": GPU_LOCK_KEY})
        waited = time.monotonic() - started
        if waited > 1.0:
            log.info("acquired the GPU after %.1fs", waited)
        try:
            yield
        finally:
            conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": GPU_LOCK_KEY})
    finally:
        conn.close()


class ChunkedLease:
    """A GPU lease held in short chunks, for work measured in days not minutes.

    Training cannot take `gpu_lock` once and keep it: that would starve both
    production services for the length of the run. It also must not re-acquire
    with `pg_try_advisory_lock`, because `try` ignores Postgres's wait queue —
    a tight try-loop would let the trainer jump ahead of a job that has been
    waiting, indefinitely.

    So: hold the lock, and every `chunk_seconds` release it and immediately
    re-acquire with the **blocking** call, which joins the back of the queue.
    When nobody is waiting the round trip is about a millisecond and training
    keeps effectively the whole GPU; when a job is waiting it is served at the
    next boundary instead of in two days. `on_release` is where the caller frees
    cached VRAM (`torch.cuda.empty_cache()`), so yielding actually hands over
    room and not just scheduler time.
    """

    def __init__(
        self,
        chunk_seconds: float = 60.0,
        on_release: Callable[[], None] | None = None,
        on_wait: Callable[[float], None] | None = None,
    ) -> None:
        self.chunk_seconds = chunk_seconds
        self._on_release = on_release
        self._on_wait = on_wait
        self._conn = None
        self._held_since = 0.0
        self.total_waited = 0.0
        self.yields = 0

    @property
    def enabled(self) -> bool:
        return bool(_dsn())

    def acquire(self) -> None:
        if not self.enabled:
            return
        if self._conn is None:
            self._conn = _get_engine().connect()
        t0 = time.monotonic()
        self._conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": GPU_LOCK_KEY})
        waited = time.monotonic() - t0
        self.total_waited += waited
        if waited > 1.0:
            log.info("acquired the GPU after %.1fs of waiting", waited)
            if self._on_wait is not None:
                self._on_wait(waited)
        self._held_since = time.monotonic()

    def release(self) -> None:
        if not self.enabled or self._conn is None:
            return
        if self._on_release is not None:
            self._on_release()
        self._conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": GPU_LOCK_KEY})
        self._held_since = 0.0

    def maybe_yield(self) -> bool:
        """Call between units of work. Returns True if the lock was handed over."""
        if not self.enabled:
            return False
        if self._held_since and (time.monotonic() - self._held_since) < self.chunk_seconds:
            return False
        self.release()
        self.yields += 1
        self.acquire()
        return True

    def close(self) -> None:
        try:
            self.release()
        finally:
            if self._conn is not None:
                self._conn.close()
                self._conn = None


def check() -> bool:
    """Startup probe: is the lock database reachable at all?"""
    if not _dsn():
        log.info("GPU mutex disabled (GPU_LOCK_DSN unset)")
        return True
    try:
        with _get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        log.info("GPU mutex ready (key=%s)", hex(GPU_LOCK_KEY))
        return True
    except Exception as exc:
        log.error("GPU mutex unreachable: %s", exc)
        return False
