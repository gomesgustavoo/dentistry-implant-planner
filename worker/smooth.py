"""Smoothed label geometry -- the one definition of "the surface", shared by all.

The STL downloads, the browser meshes, the RTSTRUCT contours and the display
overlays must all describe the SAME surface, or the curve a user measures on screen
is not the curve in the file they exported. That is enforced by everything going
through the same smoothed indicator at the same iso level rather than by a comment
saying they should agree.

The smoothing is applied to a per-structure INDICATOR (a 0/1 field), never to the
label array. Blurring label ids mixes tooth 11 into tooth 21; blurring an indicator
and thresholding at 0.5 moves a boundary by a fraction of a voxel and cannot
invent a class.
"""
from __future__ import annotations

import numpy as np

ISO = 0.5
DEFAULT_SIGMA_MM = 0.4
# A structure thinner than a couple of voxels loses volume fast under a 0.4 mm
# blur -- the canal is ~3 voxels across at 0.3 mm. Measured on the exported canal
# surface: it sits 0.11 mm inside the half-way intensity crossing, 23% of one
# voxel, which is the tolerance this constant buys.
THIN_SIGMA_MM = 0.2


def indicator(mask: np.ndarray, spacing, sigma_mm: float | None = None) -> np.ndarray:
    """A smoothed 0..1 field for one structure, in as many dimensions as `spacing` has.

    **Dimension-aware on purpose.** `worker/contours.py` used to smooth a single slice
    by giving it a length-1 leading axis and a dummy z spacing of 1.0. With
    `mode="constant"` the Gaussian then convolves that singleton axis against zero
    padding, which scales the whole plane down by the kernel's central weight -- the
    peak never reaches 1, and thresholding at `ISO` lands INSIDE the true boundary.
    Measured on an analytic 3.00 mm disc at the cross-section's own 0.1506 mm pitch:
    the ring came back at 2.9390 mm, **0.061 mm small**, on every contour the slice
    overlay has ever drawn. Passing a 2-element spacing filters in the plane only and
    the bias goes away.
    """
    from scipy import ndimage

    sigma_mm = DEFAULT_SIGMA_MM if sigma_mm is None else sigma_mm
    if sigma_mm <= 0:
        return mask.astype(np.float32)
    spacing = np.asarray(spacing, dtype=float)
    if spacing.size != mask.ndim:
        raise ValueError(
            f"indicator: {mask.ndim}-D mask with a {spacing.size}-element spacing; "
            "a dummy axis makes the blur bleed into zero padding and biases the "
            "contour inward")
    sig = np.full(spacing.size, float(sigma_mm)) / spacing
    return ndimage.gaussian_filter(mask.astype(np.float32), sigma=sig, mode="constant")


def resample_labels_smooth(label_image, reference):
    """Resample a labelmap by smoothed-indicator argmax, never by interpolation.

    Nearest neighbour aliases a thin structure in and out between slices; linear
    interpolation of ids is meaningless. Taking the argmax over per-class smoothed
    indicators does the right thing for both, at the cost of one pass per present
    class -- affordable because it only ever runs on a cropped region.
    """
    import SimpleITK as sitk

    arr = sitk.GetArrayFromImage(label_image)
    present = [int(v) for v in np.unique(arr) if v]
    ref_shape = tuple(int(s) for s in reversed(reference.GetSize()))
    best = np.zeros(ref_shape, dtype=np.float32)
    out = np.zeros(ref_shape, dtype=np.uint8)
    for v in present:
        ind = sitk.GetImageFromArray((arr == v).astype(np.float32))
        ind.CopyInformation(label_image)
        res = sitk.Resample(ind, reference, sitk.Transform(), sitk.sitkLinear, 0.0,
                            sitk.sitkFloat32)
        vals = sitk.GetArrayFromImage(res)
        take = vals > np.maximum(best, ISO)
        out[take] = v
        best = np.maximum(best, vals)
        del ind, res, vals
    img = sitk.GetImageFromArray(out)
    img.CopyInformation(reference)
    return img
