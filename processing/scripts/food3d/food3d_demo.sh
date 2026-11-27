#!/usr/bin/env bash
# Food3D demo: phone orbit video of one dish -> textured PBR GLBs (hero 150k + mobile 35k).
#
#   food3d_demo.sh <video.mp4> <dish_name> <diameter_cm> [out_root]
#
# Stages:
#   1. video_to_dataset.py (CPU): sharp frames, BiRefNet masks, pycolmap camera poses,
#      frozen every-8th held-out split, train-only visual hull.
#   2. run_track2b.sh (RTX 3060, $0): 2DGS -> TSDF -> Blender bake -> photo projection ->
#      PBR -> WebP+meshopt GLBs -> held-out eval -> turntable sheet -> QA gate (--strict).
# Capture tips: walk a slow full circle around the dish at about 30-45 degrees elevation,
# 20-30 s, soft even light, dish fully in frame, no hands in shot.
# Diameter is the dish's horizontal size in cm (uncalibrated scale assumption).
# Every output is private R&D: publication_eligible: false (ADR 0004).
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <video.mp4> <dish_name> <diameter_cm> [out_root]" >&2
  exit 2
fi
video=$(realpath "$1"); dish="$2"; diameter_cm="$3"
out_root="${4:-$HOME/kaggle-evals/food3d-demo-$(date +%Y%m%d-%H%M%S)}"
here=$(cd "$(dirname "$0")" && pwd)
T2B_PY=${T2B_PY:-$HOME/tools/track2b-venv/bin/python}
# shellcheck source=t2b_v7_recipe.sh
source "$here/t2b_v7_recipe.sh"
dataset="$out_root/datasets/$dish"
mkdir -p "$out_root"

echo "=== [demo 1/2] video -> dataset ($dish, max_dim=$V2D_MAX_DIM) ==="
CUDA_VISIBLE_DEVICES="" systemd-run --user --scope -q -p MemoryMax=8G \
  "$T2B_PY" "$here/video_to_dataset.py" "$video" "$dataset" --max-dim "$V2D_MAX_DIM" | tee "$out_root/$dish.dataset.log"

echo "=== [demo 2/2] dataset -> PBR GLBs ($dish, texture_mode=$T2B_TEXTURE_MODE) ==="
"$here/run_track2b.sh" "$dish" "$dataset" "$out_root" "$diameter_cm" "$T2B_STEPS" | tee "$out_root/$dish.run.log"

echo "Hero GLB:   $out_root/$dish/lod_150k_2048.pbr.glb"
echo "Mobile GLB: $out_root/$dish/lod_35k_1024.pbr.glb"
echo "Turntable:  $out_root/$dish/eval/turntable_contact_sheet.png"
echo "(publication_eligible: false)"
