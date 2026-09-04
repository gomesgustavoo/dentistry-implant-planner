"""The GPU worker: ingest, segment, export.

Rebuilt 2026-09-01 after the package was destroyed by a `shutil.rmtree` on the
project root (`scripts/pmcanalseg_build_ppc_dataset.py --link-into ""` resolved to
`Path(".")`). `dentistry/`, `api/`, `web/` and `landing/` came back from the running
0.10.0 container images; this package was in no image, because the worker runs on
the host precisely so a ~4 GB CUDA image never has to be built.

Every module here is reconstructed against the surviving `dentistry/` contracts,
which is what makes the reconstruction checkable rather than a guess: the label
space, the crosswalk, the quality checks and the orientation rules all still exist
and all still assert. Where a constant was measured rather than chosen, the
measurement is quoted in the docstring so it is not silently re-guessed later.
"""
