"""`UMambaBot2` -- the architecture our ToothFairy3 checkpoints were trained with.

The plans file names this class by its import path:

    "network_class_name": "worker.nets.umamba2.UMambaBot2"

so nnU-Net imports it here at load time. It is a thin wrapper, deliberately: a
`ResidualEncoderUNet` with one Mamba block applied to the bottleneck feature map
between the encoder and the decoder. That is the "Bot" variant of U-Mamba
(Ma et al.), and it is what the ToothFairy3 challenge winners used (U-Mamba2,
arXiv:2509.12069, Apache-2.0).

Subclassing `ResidualEncoderUNet` rather than reimplementing it is not a shortcut,
it is the correctness argument: the checkpoint's parameter names are
`encoder.*`, `decoder.*` and `mamba_layer.*`, and only inheriting the real encoder
and decoder reproduces the first two exactly. A hand-rolled equivalent would load
with `strict=False` and quietly leave half the network at its initialisation.

**This file was reconstructed on 2026-09-01** after the project tree was deleted,
from the checkpoint's own parameter names -- 544 encoder tensors, 616 decoder,
and these ten:

    mamba_layer.norm.{weight,bias}          LayerNorm over the channel dim
    mamba_layer.mamba.{A_log,D,dt_bias}     Mamba2 state parameters
    mamba_layer.mamba.conv1d.{weight,bias}
    mamba_layer.mamba.in_proj.weight
    mamba_layer.mamba.out_proj.weight
    mamba_layer.mamba.norm.weight           RMSNorm inside Mamba2Simple

`load_state_dict(strict=True)` is what proves the reconstruction, and
`scripts/verify_checkpoint.py` runs exactly that.
"""
from __future__ import annotations

import torch
import torch.nn as nn
from dynamic_network_architectures.architectures.unet import ResidualEncoderUNet


class MambaLayer(nn.Module):
    """LayerNorm -> Mamba2 -> restore shape, over a 3D feature map's voxels.

    The feature map is flattened to a sequence of `D*H*W` tokens of `dim` channels,
    which is what makes this a *global* mixing step: at the bottleneck of a 7-stage
    encoder that is a 3x6x8 grid on our patch, so the sequence is short and the
    state-space scan is cheap next to the convolutions around it.

    `Mamba2Simple`'s selective scan is a Triton kernel with **no PyTorch fallback**,
    so this layer requires CUDA. That is why the worker cannot fall back to CPU
    inference for the ToothFairy3 path, and why `tf3.build_predictor` does not offer
    it as an option -- a CPU "fallback" here is an import error forty seconds into a
    job, not a slow result.
    """

    # Solved from the checkpoint's own tensor shapes on 2026-09-01, because the
    # training code that chose them was lost with the project tree. Mamba2Simple's
    # parameter shapes determine them uniquely for d_model = 320:
    #
    #     A_log / D / dt_bias  [8]           -> nheads    = 8
    #     conv1d.weight  [704, 1, 4]         -> conv_dim  = 704 = d_inner + 2*g*d_state
    #     in_proj.weight [1352, 320]         -> d_in_proj = 1352
    #                                           = 2*d_inner + 2*g*d_state + nheads
    #
    # giving d_inner 640 (expand 2), headdim 80, ngroups 1, d_state 32. Guessing any
    # of these wrong is caught immediately -- `load_state_dict` is strict, and it is
    # what turned this from a plausible reconstruction into a verified one.
    D_STATE = 32
    D_CONV = 4
    EXPAND = 2
    HEADDIM = 80

    def __init__(self, dim: int, d_state: int = D_STATE, d_conv: int = D_CONV,
                 expand: int = EXPAND, headdim: int = HEADDIM):
        super().__init__()
        from mamba_ssm.modules.mamba2_simple import Mamba2Simple

        self.dim = dim
        self.norm = nn.LayerNorm(dim)
        # `use_mem_eff_path=False` takes the UNFUSED forward. The fused one calls
        # `causal_conv1d_fwd_function`, an nvcc-built extension this box has no
        # toolchain for; the unfused path uses `F.conv1d` plus the same Triton scan
        # and is mathematically the same operation on the same weights. It is a
        # forward-path choice, not an architecture change, so the checkpoint loads
        # and scores identically.
        self.mamba = Mamba2Simple(d_model=dim, d_state=d_state, d_conv=d_conv,
                                  expand=expand, headdim=headdim,
                                  use_mem_eff_path=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, c = x.shape[:2]
        spatial = x.shape[2:]
        n = int(torch.tensor(spatial).prod())
        seq = x.reshape(b, c, n).transpose(-1, -2)       # (B, N, C)
        out = self.mamba(self.norm(seq))
        return out.transpose(-1, -2).reshape(b, c, *spatial)


class UMambaBot2(ResidualEncoderUNet):
    """A residual-encoder U-Net with a Mamba2 block on the bottleneck.

    Every constructor argument is passed straight through, so the plans file's
    `arch_kwargs` mean exactly what they mean for a stock `ResidualEncoderUNet`
    and nnU-Net's `_kw_requires_import` handling is unchanged.
    """

    def __init__(self, *args, mamba_d_state: int = MambaLayer.D_STATE,
                 mamba_d_conv: int = MambaLayer.D_CONV,
                 mamba_expand: int = MambaLayer.EXPAND,
                 mamba_headdim: int = MambaLayer.HEADDIM, **kwargs):
        super().__init__(*args, **kwargs)
        bottleneck = self.encoder.output_channels[-1]
        self.mamba_layer = MambaLayer(bottleneck, d_state=mamba_d_state,
                                      d_conv=mamba_d_conv, expand=mamba_expand,
                                      headdim=mamba_headdim)

    def forward(self, x: torch.Tensor):
        skips = self.encoder(x)
        # Only the deepest feature map is mixed. Applying it at every stage is the
        # "Enc" variant and a different (much more expensive) network; this one has
        # ten extra tensors, which is what the checkpoint carries.
        skips[-1] = self.mamba_layer(skips[-1])
        return self.decoder(skips)
