# Source me. Do not run me.
#
#   . scripts/tf3_env.sh
#
# Everything nnU-Net needs lives on the dedicated data disk (/dev/sdb, ext4, mounted
# at /mnt/mldata), not on the root filesystem: buffered writes to / run at about
# 7 MB/s on this box, and preprocessing writes tens of gigabytes.
export DENTISTRY_ROOT=/home/tavulha/dentistry
export TF3_DATA=/mnt/mldata/tf3
export nnUNet_raw="$TF3_DATA/nnUNet_raw"
export nnUNet_preprocessed="$TF3_DATA/nnUNet_preprocessed"
export nnUNet_results="$TF3_DATA/nnUNet_results"
export PYTHONPATH="$DENTISTRY_ROOT"
export nnUNet_n_proc_DA=8
export OMP_NUM_THREADS=1
mkdir -p "$nnUNet_raw" "$nnUNet_preprocessed" "$nnUNet_results"

# The shared GPU mutex. Without it `_GpuLeaseMixin` is inert and a training run
# holds the whole card -- which is what blocked every measurement on 2026-08-27.
# Read the ONE key rather than sourcing .worker.env, so a trainer does not end up
# holding database and object-store credentials it has no use for.
[ -f "$DENTISTRY_ROOT/.worker.env" ] && \
  export GPU_LOCK_DSN="$(grep -m1 '^GPU_LOCK_DSN=' "$DENTISTRY_ROOT/.worker.env" | cut -d= -f2-)"

export PATH="$DENTISTRY_ROOT/venv-umamba/bin:$PATH"
echo "nnUNet_raw          $nnUNet_raw"
echo "nnUNet_preprocessed $nnUNet_preprocessed"
echo "nnUNet_results      $nnUNet_results"
echo "GPU_LOCK_DSN        ${GPU_LOCK_DSN:+<set>}${GPU_LOCK_DSN:-<UNSET -- the lease will refuse>}"
