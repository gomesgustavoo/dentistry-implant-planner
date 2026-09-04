"""Read an upload and put it in the canonical frame. Nothing else.

Every downstream assumption about axes is made once, here, by reorienting to
`worker.orient.CANONICAL` (RPI) from the DIRECTION COSINES -- never from array
order, never from a filename, never from a modality guess.

A DICOM series and a NIfTI arrive by different routes and leave identical: one
`Volume` carrying the canonical image, its original orientation code so a download
can be written back the way the upload came, and everything measurable about the
geometry for the report.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from worker import orient

log = logging.getLogger(__name__)

NIFTI_SUFFIXES = (".nii", ".nii.gz", ".nrrd", ".mha", ".mhd", ".gipl", ".gipl.gz")


@dataclass
class Volume:
    image: object
    original_code: str
    spacing_xyz: tuple
    orientation: dict
    kind: str = "volume"
    series_description: str | None = None
    n_files: int = 1
    warnings: list = field(default_factory=list)
    acquisition: dict | None = None
    dicom_reference: dict | None = None
    slice_uids: list = field(default_factory=list)
    frame_uid: str | None = None
    study_uid: str | None = None
    patient: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "size_xyz": [int(x) for x in self.image.GetSize()],
            "spacing_xyz": [round(float(x), 5) for x in self.spacing_xyz],
            "kind": self.kind,
            "orientation": self.orientation,
            "series_description": self.series_description,
            "n_files": self.n_files,
            "warnings": list(self.warnings),
            "acquisition": self.acquisition,
            "dicom_reference": self.dicom_reference,
        }


def _describe(image, original_code: str) -> dict:
    return {
        "original": original_code,
        "canonical": orient.CANONICAL,
        "reoriented": original_code != orient.CANONICAL,
        "unverified": False,
        "tilt_degrees": round(orient.tilt_degrees(image), 2),
        "direction_cosines": [round(float(x), 6) for x in image.GetDirection()],
        "ambiguous": False,
    }


def _load_dicom(src: Path, work: Path) -> Volume:
    import SimpleITK as sitk

    reader = sitk.ImageSeriesReader()
    ids = reader.GetGDCMSeriesIDs(str(src))
    if not ids:
        raise ValueError("no DICOM series found in the upload")
    warnings = []
    if len(ids) > 1:
        warnings.append(f"{len(ids)} series in the upload; the largest was used")
    best, files = None, []
    for sid in ids:
        f = reader.GetGDCMSeriesFileNames(str(src), sid)
        if best is None or len(f) > len(files):
            best, files = sid, f
    reader.SetFileNames(files)
    reader.MetaDataDictionaryArrayUpdateOn()
    reader.LoadPrivateTagsOn()
    raw = reader.Execute()

    def tag(i, key):
        try:
            return reader.GetMetaData(i, key).strip()
        except Exception:
            return None

    acq = {
        "manufacturer": tag(0, "0008|0070"), "model": tag(0, "0008|1090"),
        "kvp": tag(0, "0018|0060"), "tube_current_ma": tag(0, "0018|1151"),
        "exposure_mas": tag(0, "0018|1152"), "exposure_time_ms": tag(0, "0018|1150"),
        "reconstruction_diameter_mm": tag(0, "0018|1100"), "study_date": tag(0, "0008|0020"),
    }
    img, code = orient.to_canonical(raw)
    return Volume(
        image=img, original_code=code, spacing_xyz=tuple(raw.GetSpacing()),
        orientation=_describe(raw, code), kind="dicom",
        series_description=tag(0, "0008|103e"), n_files=len(files), warnings=warnings,
        acquisition={k: v for k, v in acq.items() if v},
        dicom_reference={"series_uid": best, "n_files": len(files)},
        slice_uids=[tag(i, "0008|0018") for i in range(len(files))],
        frame_uid=tag(0, "0020|0052"), study_uid=tag(0, "0020|000d"),
        patient={"id": tag(0, "0010|0020"), "name": tag(0, "0010|0010")},
    )


def load(src: Path, work: Path) -> Volume:
    """A DICOM directory or a single volume file, canonicalised."""
    import SimpleITK as sitk

    src = Path(src)
    if src.is_dir():
        return _load_dicom(src, work)
    raw = sitk.ReadImage(str(src))
    if raw.GetNumberOfComponentsPerPixel() != 1:
        raise ValueError("multi-component volumes are not supported")
    img, code = orient.to_canonical(raw)
    return Volume(image=img, original_code=code, spacing_xyz=tuple(raw.GetSpacing()),
                  orientation=_describe(raw, code), kind="volume",
                  series_description=src.name)
