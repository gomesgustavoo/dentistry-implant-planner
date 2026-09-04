"""One canonical frame, and the two functions that get in and out of it.

Everything downstream -- the model, `canal_box`, `dental_box`, the quality checks,
the arch fit -- assumes a single voxel frame, and says so. That frame is **RPI**:

    numpy axis 0 increases toward INFERIOR
    numpy axis 1 increases toward POSTERIOR
    numpy axis 2 increases toward the patient's RIGHT

It is not an arbitrary choice. `dentistry/toothfairy3.py` documents that the
ToothFairy3 volumes the model trained on are stored in RPI (their headers say LPS
and lie), and nnU-Net does not reorient -- `SimpleITKIO` reads the array as stored
and `transpose_forward` is [0, 1, 2]. So RPI is what the network saw and RPI is
what it must be fed.

`to_canonical` reads the direction cosines and reorients; it never trusts array
order. `from_canonical` puts a result back on the frame the case arrived in, so a
download opens the way the upload did.
"""
from __future__ import annotations

import numpy as np

CANONICAL = "RPI"


def orientation_code(image) -> str:
    """The three-letter code the image's direction cosines describe."""
    import SimpleITK as sitk

    return sitk.DICOMOrientImageFilter_GetOrientationFromDirectionCosines(
        image.GetDirection())


def to_canonical(image):
    """`(image_in_RPI, original_code)`. A no-op when it is already canonical."""
    import SimpleITK as sitk

    code = orientation_code(image)
    if code == CANONICAL:
        return image, code
    return sitk.DICOMOrient(image, CANONICAL), code


def from_canonical(image, code: str):
    """Put a canonical image back on the frame `code` describes."""
    import SimpleITK as sitk

    if not code or code == CANONICAL:
        return image
    return sitk.DICOMOrient(image, code)


def label_image_like(array: np.ndarray, reference):
    """A label image carrying `reference`'s geometry.

    `CopyInformation` rather than setting the three fields by hand: it fails loudly
    on a shape mismatch, which is the error worth catching here -- a label volume
    that is a different shape from its image is a bug that would otherwise surface
    as a silent half-volume shift in the export.
    """
    import SimpleITK as sitk

    img = sitk.GetImageFromArray(np.ascontiguousarray(array.astype(np.uint8, copy=False)))
    img.CopyInformation(reference)
    return img


def tilt_degrees(image) -> float:
    """How far the volume's axes sit from the world axes, in degrees.

    Reported rather than corrected. A gantry-tilted or head-tilted acquisition is
    still a valid scan; the number belongs in the report so a reader can judge it.
    """
    d = np.asarray(image.GetDirection(), dtype=float).reshape(3, 3)
    # The rotation angle of the nearest rotation, from its trace.
    cos = (np.trace(d) - 1.0) / 2.0
    return float(np.degrees(np.arccos(np.clip(abs(cos), -1.0, 1.0))))
