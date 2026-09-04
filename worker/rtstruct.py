"""DICOM RT Structure Set export, and the derived series it references.

An RTSTRUCT is contours plus a promise: every contour names the image slice it was
drawn on, by SOP Instance UID. A NIfTI upload has no such UIDs, so one is minted --
a *derived* secondary-capture series written alongside the structure set, so the
pair opens together in a planning system and the contours land on the right slices.
A DICOM upload keeps its own UIDs and no derived series is written.

ROI names are capped at 16 characters because **Varian Eclipse silently truncates
longer ones**, and two structures that truncate to the same string become one ROI
on import. `rt_name` does the shortening deliberately and `_check_names` asserts
the result is still unique across the whole taxonomy -- at import time, so a new
structure cannot be added that collides.

The contours come from the same smoothed indicator at the same iso level as the
meshes and the display overlay (`worker/smooth.py`), which is what makes "the curve
on screen is the curve in the file" true rather than aspirational.
"""
from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

import numpy as np

from worker import smooth

log = logging.getLogger(__name__)

# The SOP class an RT Structure Set names in its ReferencedStudySequence.
#
# Written out rather than read off `pydicom.uid`. It used to be
# `pydicom.uid.StudyRootQueryRetrieveInformationModelFind`, and pydicom 3.0 stopped
# exporting that name -- which raised at import-time inside the RTSTRUCT builder, was
# swallowed by its try/except, and left every job silently without a DICOM export while
# reporting success. A UID is a fixed string in the standard; depending on a library to
# spell it is the only part of that which could break.
#
# Value: Study Root Query/Retrieve Information Model - FIND. This is what the module
# emitted before, and it is preserved exactly so an RTSTRUCT this project wrote last
# month and one it writes today are the same file to Eclipse.
STUDY_REF_SOP_CLASS = "1.2.840.10008.5.1.4.1.2.2.1"

MAX_ROI_NAME = 16
IMPLEMENTATION_UID = "1.2.826.0.1.3680043.10.1338"


def rt_name(structure) -> str:
    """A unique ROI name of at most 16 characters."""
    if structure.fdi is not None:
        return f"Tooth_{structure.fdi}"
    short = {
        "maxilla": "Maxilla", "mandible": "Mandible", "canal": "MandCanal",
        "upper_teeth_unnumbered": "UpperTeethUnk", "lower_teeth_unnumbered": "LowerTeethUnk",
        "sinus_max_left": "SinusMaxL", "sinus_max_right": "SinusMaxR",
        "pharynx": "Pharynx", "incisive_canal_left": "IncisCanalL",
        "incisive_canal_right": "IncisCanalR", "lingual_canal": "LingualCanal",
        "bridge": "Bridge", "crown": "Crown", "implant": "Implant", "pulp": "Pulp",
    }.get(structure.id)
    if short is None:
        short = structure.id.replace("_", " ").title().replace(" ", "")[:MAX_ROI_NAME]
    return short[:MAX_ROI_NAME]


def _check_names() -> None:
    from dentistry import labels as L

    seen: dict[str, str] = {}
    for s in L.STRUCTURES:
        n = rt_name(s)
        if len(n) > MAX_ROI_NAME:
            raise ValueError(f"ROI name {n!r} exceeds {MAX_ROI_NAME} characters")
        if n in seen:
            raise ValueError(f"ROI names collide after truncation: {seen[n]} and {s.id} -> {n!r}")
        seen[n] = s.id


_check_names()


def _uid() -> str:
    import pydicom.uid

    return pydicom.uid.generate_uid(prefix=IMPLEMENTATION_UID + ".")


def _index_to_lps(image):
    """`(origin, M)` such that `lps = origin + M @ [x, y, z]` for continuous indices.

    Built once as a matrix rather than calling
    `TransformContinuousIndexToPhysicalPoint` per point -- there are millions of
    contour points on a full head scan.
    """
    origin = np.asarray(image.GetOrigin(), dtype=np.float64)
    d = np.asarray(image.GetDirection(), dtype=np.float64).reshape(3, 3)
    spacing = np.asarray(image.GetSpacing(), dtype=np.float64)
    return origin, d * spacing[np.newaxis, :]


def structure_contours(merged: np.ndarray, index: int, image, sigma_mm: float | None = None):
    """`[(z_index, [(x, y, z) LPS mm, ...]), ...]` for one structure."""
    from skimage import measure

    mask = merged == index
    if not mask.any():
        return []
    origin, m = _index_to_lps(image)
    zs = np.flatnonzero(mask.any(axis=(1, 2)))
    out = []
    for z in zs:
        sl = mask[z]
        # In the plane, and in VOXELS -- this contour is built on the index grid and
        # mapped to LPS afterwards, so a unit spacing is the right one here. What was
        # wrong was the dummy z axis: a length-1 axis under `mode="constant"` bleeds the
        # slice into zero padding and pulls every ring inward. Measured at 0.061 mm on
        # `worker/contours.py`'s identical call, which is a real distance on an exported
        # RTSTRUCT.
        field = smooth.indicator(sl, (1.0, 1.0), sigma_mm)
        if field.max() < smooth.ISO:
            field = sl.astype(np.float32)
        for c in measure.find_contours(field, smooth.ISO):
            c = measure.approximate_polygon(c, tolerance=0.25)
            if len(c) < 3:
                continue
            ijk = np.stack([c[:, 1], c[:, 0], np.full(len(c), float(z))], axis=1)
            out.append((int(z), origin[None, :] + ijk @ m.T))
    return out


def _derived_series(grey: np.ndarray, image, out_dir: Path, patient: dict,
                    study_uid: str, window) -> tuple[list, str, str]:
    """Write a secondary-capture series so NIfTI contours have slices to name."""
    import pydicom
    from pydicom.dataset import Dataset, FileDataset

    series_uid, frame_uid = _uid(), _uid()
    out_dir.mkdir(parents=True, exist_ok=True)
    origin, m = _index_to_lps(image)
    d = np.asarray(image.GetDirection(), dtype=np.float64).reshape(3, 3)
    spacing = np.asarray(image.GetSpacing(), dtype=np.float64)
    width, level = window
    lo = level - width / 2

    uids = []
    now = dt.datetime.now()
    for z in range(grey.shape[0]):
        sop = _uid()
        fm = Dataset()
        fm.MediaStorageSOPClassUID = pydicom.uid.CTImageStorage
        fm.MediaStorageSOPInstanceUID = sop
        fm.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
        ds = FileDataset(str(out_dir / f"{z:04d}.dcm"), {}, file_meta=fm, preamble=b"\0" * 128)
        ds.SOPClassUID = pydicom.uid.CTImageStorage
        ds.SOPInstanceUID = sop
        ds.PatientName = patient.get("name") or "ANONYMOUS"
        ds.PatientID = patient.get("id") or "ANONYMOUS"
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = frame_uid
        ds.Modality = "CT"
        ds.SeriesDescription = "Derived from upload (segmentation reference)"
        ds.ImageType = ["DERIVED", "SECONDARY"]
        ds.StudyDate = ds.SeriesDate = ds.ContentDate = now.strftime("%Y%m%d")
        ds.StudyTime = ds.SeriesTime = ds.ContentTime = now.strftime("%H%M%S")
        ds.InstanceNumber = z + 1
        ds.Rows, ds.Columns = int(grey.shape[1]), int(grey.shape[2])
        ds.PixelSpacing = [float(spacing[1]), float(spacing[0])]
        ds.SliceThickness = float(spacing[2])
        pos = origin + m @ np.array([0.0, 0.0, float(z)])
        ds.ImagePositionPatient = [float(v) for v in pos]
        ds.ImageOrientationPatient = [float(v) for v in np.concatenate([d[:, 0], d[:, 1]])]
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 1
        ds.RescaleIntercept = 0.0
        ds.RescaleSlope = 1.0
        ds.WindowWidth = float(width)
        ds.WindowCenter = float(level)
        ds.PixelData = np.clip(grey[z], -32768, 32767).astype(np.int16).tobytes()
        ds.save_as(out_dir / f"{z:04d}.dcm", enforce_file_format=True)
        uids.append(sop)
    return uids, series_uid, frame_uid


def build(merged: np.ndarray, image, slice_uids: list, frame_uid: str, study_uid: str,
          patient: dict, sop_class: str):
    """The RTSTRUCT dataset itself."""
    import pydicom
    from pydicom.dataset import Dataset, FileDataset

    from dentistry import labels as L

    sop = _uid()
    fm = Dataset()
    fm.MediaStorageSOPClassUID = pydicom.uid.RTStructureSetStorage
    fm.MediaStorageSOPInstanceUID = sop
    fm.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
    ds = FileDataset("rtstruct.dcm", {}, file_meta=fm, preamble=b"\0" * 128)
    now = dt.datetime.now()
    ds.SOPClassUID = pydicom.uid.RTStructureSetStorage
    ds.SOPInstanceUID = sop
    ds.Modality = "RTSTRUCT"
    ds.PatientName = patient.get("name") or "ANONYMOUS"
    ds.PatientID = patient.get("id") or "ANONYMOUS"
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = _uid()
    ds.StructureSetLabel = "Dentistry"
    ds.StructureSetName = "Automatic segmentation"
    ds.StructureSetDate = now.strftime("%Y%m%d")
    ds.StructureSetTime = now.strftime("%H%M%S")

    ref = Dataset()
    ref.FrameOfReferenceUID = frame_uid
    study = Dataset()
    study.ReferencedSOPClassUID = STUDY_REF_SOP_CLASS
    study.ReferencedSOPInstanceUID = study_uid
    series = Dataset()
    series.SeriesInstanceUID = _uid()
    series.ContourImageSequence = []
    for u in slice_uids:
        ci = Dataset()
        ci.ReferencedSOPClassUID = sop_class
        ci.ReferencedSOPInstanceUID = u
        series.ContourImageSequence.append(ci)
    study.RTReferencedSeriesSequence = [series]
    ref.RTReferencedStudySequence = [study]
    ds.ReferencedFrameOfReferenceSequence = [ref]

    ds.StructureSetROISequence = []
    ds.ROIContourSequence = []
    ds.RTROIObservationsSequence = []
    skipped, total_points, n_roi = [], 0, 0

    for s in L.STRUCTURES:
        sigma = smooth.THIN_SIGMA_MM if s.index in L.NO_COMPONENT_FILTER else None
        polys = structure_contours(merged, s.index, image, sigma)
        if not polys:
            if (merged == s.index).any():
                skipped.append(s.id)
            continue
        n_roi += 1
        roi = Dataset()
        roi.ROINumber = n_roi
        roi.ReferencedFrameOfReferenceUID = frame_uid
        roi.ROIName = rt_name(s)
        roi.ROIGenerationAlgorithm = "AUTOMATIC"
        ds.StructureSetROISequence.append(roi)

        rc = Dataset()
        rc.ReferencedROINumber = n_roi
        rc.ROIDisplayColor = list(bytes.fromhex(s.color.lstrip("#")))
        rc.ContourSequence = []
        for z, pts in polys:
            c = Dataset()
            c.ContourGeometricType = "CLOSED_PLANAR"
            c.NumberOfContourPoints = len(pts)
            c.ContourData = [float(v) for v in pts.flatten()]
            if 0 <= z < len(slice_uids):
                ci = Dataset()
                ci.ReferencedSOPClassUID = sop_class
                ci.ReferencedSOPInstanceUID = slice_uids[z]
                c.ContourImageSequence = [ci]
            rc.ContourSequence.append(c)
            total_points += len(pts)
        ds.ROIContourSequence.append(rc)

        obs = Dataset()
        obs.ObservationNumber = n_roi
        obs.ReferencedROINumber = n_roi
        obs.ROIObservationLabel = rt_name(s)
        obs.RTROIInterpretedType = "ORGAN"
        obs.ROIInterpreter = ""
        ds.RTROIObservationsSequence.append(obs)

    return ds, {"roi_count": n_roi, "total_points": total_points, "skipped": skipped}


def export(merged: np.ndarray, image, grey, dicom_ref, out_dir: Path, vol, window) -> dict:
    """Write `rtstruct.dcm`, plus a derived series when the upload was not DICOM."""
    import pydicom

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    derived = None
    if dicom_ref and vol.slice_uids and all(vol.slice_uids):
        uids = list(vol.slice_uids)
        frame_uid = vol.frame_uid or _uid()
        study_uid = vol.study_uid or _uid()
        sop_class = pydicom.uid.CTImageStorage
    else:
        uids, series_uid, frame_uid = _derived_series(
            grey, image, out_dir / "derived", vol.patient, _uid(), window)
        study_uid = _uid()
        sop_class = pydicom.uid.CTImageStorage
        derived = {"series": series_uid, "slices": len(uids)}

    ds, info = build(merged, image, uids, frame_uid, study_uid, vol.patient, sop_class)
    path = out_dir / "rtstruct.dcm"
    ds.save_as(path, enforce_file_format=True)
    return {"file": "rtstruct/rtstruct.dcm", "bytes": path.stat().st_size,
            "rois": info["roi_count"], "total_points": info["total_points"],
            "skipped": info["skipped"], "derived_series": (derived or {}).get("series"),
            "derived_slices": (derived or {}).get("slices"),
            "note": ("contours reference the uploaded DICOM slices" if derived is None
                     else "a derived secondary-capture series was written so the "
                          "contours have slices to reference")}
