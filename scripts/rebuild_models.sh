#!/usr/bin/env bash
# Reinstall the first-party serving models from the training runs on /mnt/mldata.
#
# 2026-09-01: `models/` was destroyed with the project tree. The CHECKPOINTS were
# not -- they live on the separate data disk, which the deletion never touched. So
# every model we trained ourselves is fully recoverable; only the installed copies
# (trainer rewritten, optimizer stripped) had to be rebuilt, which is what this does.
set -euo pipefail
cd "$(dirname "$0")/.."
R=/mnt/mldata/tf3/nnUNet_results

install() {  # <run-dir> <fold> <slug>
  echo "=== $3"
  venv/bin/python scripts/tf3_install_model.py --run "$1" --fold "$2" \
    --checkpoint checkpoint_final.pth --out "models/$3" --force
}

install "$R/Dataset119_ToothFairy3/nnUNetTrainer_TF3_Task1_1000ep_accum2_shared__nnUNetResEncUNetLPlans_torchres__3d_fullres_torchres_mambabot2_ps96x192x256_bs1" \
        all toothfairy3
install "$R/Dataset119_ToothFairy3/nnUNetTrainer_TF3_Task1_cont_intensity_shared__nnUNetResEncUNetLPlans_torchres__3d_fullres_torchres_mambabot2_ps96x192x256_bs1" \
        all toothfairy3_cont_intensity
install "$R/Dataset120_TF3CanalROI/nnUNetTrainerCanalROI__nnUNetResEncUNetMPlans__3d_fullres" \
        all canal_specialist
install "$R/Dataset120_TF3CanalROI/nnUNetTrainerCanalROI_SRL__nnUNetResEncUNetMPlans__3d_fullres" \
        all canal_specialist_srl
echo
echo "installed:"; ls -1 models/
