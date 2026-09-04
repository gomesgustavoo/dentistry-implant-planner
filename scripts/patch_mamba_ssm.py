#!/usr/bin/env python
"""Make `mamba_ssm` importable without its nvcc-built extensions.

`worker/nets/umamba2.py` needs exactly one class from this package,
`Mamba2Simple`, whose selective scan is a **Triton** kernel -- JIT-compiled at
runtime, no CUDA toolchain required -- and whose optional `causal_conv1d`
dependency already has a `torch` fallback built in (`causal_conv1d_fn = None` ->
`F.conv1d`).

What blocks it is the package's own `__init__.py`, which eagerly imports the
Mamba **v1** interface and through it `selective_scan_cuda`, a compiled extension
that needs `nvcc`. This box has no CUDA toolchain, so that import fails and takes
the whole package with it -- including the parts that would have worked.

This makes those v1 imports optional and leaves everything else alone. Idempotent,
and it re-runs after any `pip install mamba-ssm`, so it belongs in the environment
rebuild rather than in someone's shell history.
"""
from __future__ import annotations

import sys
from pathlib import Path

MARK = "# patched by scripts/patch_mamba_ssm.py"

TEMPLATE = '''__version__ = {version}

{mark}: the v1 interface pulls in `selective_scan_cuda`, an nvcc-built extension.
# We use only `Mamba2Simple`, whose scan is a Triton kernel and needs no toolchain.
# Failing softly here keeps the working half of the package usable; anything that
# actually wants v1 gets a clear AttributeError instead of an import-time crash.
try:
    from mamba_ssm.ops.selective_scan_interface import selective_scan_fn, mamba_inner_fn
    from mamba_ssm.modules.mamba_simple import Mamba
    from mamba_ssm.models.mixer_seq_simple import MambaLMHeadModel
except ImportError as _exc:  # no CUDA extensions built
    selective_scan_fn = mamba_inner_fn = Mamba = MambaLMHeadModel = None
    _MAMBA_V1_IMPORT_ERROR = _exc

try:
    from mamba_ssm.modules.mamba2 import Mamba2
except ImportError:
    Mamba2 = None

from mamba_ssm.modules.mamba2_simple import Mamba2Simple
'''


def _find_init() -> Path:
    """Locate the package WITHOUT importing it -- importing is what fails."""
    import importlib.util

    spec = importlib.util.find_spec("mamba_ssm")
    if spec is None or not spec.origin:
        raise SystemExit("mamba_ssm is not installed")
    return Path(spec.origin)


def main() -> int:
    init = _find_init()
    text = init.read_text()
    if MARK in text:
        print(f"already patched: {init}")
        return 0
    version = next((ln.split("=", 1)[1].strip() for ln in text.splitlines()
                    if ln.startswith("__version__")), '"unknown"')
    init.with_suffix(".py.orig").write_text(text)
    init.write_text(TEMPLATE.format(version=version, mark=MARK))
    print(f"patched {init} (original kept as {init.name}.orig)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
