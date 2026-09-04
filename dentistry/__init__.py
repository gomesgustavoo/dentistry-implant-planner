"""Shared, torch-free code for the dentistry CBCT segmentation service.

Nothing in this package may import torch: the API pod installs it and must stay
small, while only the GPU worker pulls the deep-learning stack. Same split the
VoxTell control plane uses, and for the same reason.
"""

__version__ = "0.1.0"
