#!/usr/bin/env bash
# PeekaPlate Food3D V1 end-to-end local pipeline driver (Stages 1-5).
# Private R&D; every output carries publication_eligible: false (ADR 0004).
#
# Usage:
#   run_pipeline.sh <out_dir> <dish> <input_image> <hires_glb> \
#     [--exp0-dir <dir>] [--main-object-only] [--drop-shadow-disc] \
#     [--diameter-cm 24] [--calibrated]
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "Usage: $0 <out_dir> <dish> <input_image> <hires_glb> [--exp0-dir <dir>] [--main-object-only] [--drop-shadow-disc] [--diameter-cm 24] [--calibrated]" >&2
  exit 2
fi

out_dir=$(realpath -m "$1")
dish="$2"
if [[ -z "$dish" || "$dish" == */* || "$dish" == "." || "$dish" == ".." ]]; then
  echo "Dish must be a single directory name" >&2
  exit 2
fi
input_image=$(realpath "$3")
hires_glb=$(realpath "$4")
shift 4

exp0_dir=""
blender_extra_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --exp0-dir)
      exp0_dir=$(realpath "$2")
      shift 2
      ;;
    --main-object-only|--drop-shadow-disc|--calibrated)
      blender_extra_args+=("$1")
      shift
      ;;
    --diameter-cm)
      blender_extra_args+=("$1" "$2")
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)

BLENDER=${BLENDER:-/home/yacine105/tools/blender-4.5.17-linux-x64/blender}
GLTF_TRANSFORM=${GLTF_TRANSFORM:-/home/yacine105/tools/gltf-transform/node_modules/.bin/gltf-transform}
THREE_DIR=${THREE_DIR:-/home/yacine105/t3-code-handoff/peekaplate/node_modules/.pnpm/three@0.182.0/node_modules/three}
export CHROMIUM_PATH=${CHROMIUM_PATH:-/home/yacine105/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell}
export GLTF_TRANSFORM
py="$repo/processing/.venv/bin/python"

dish_dir="$out_dir/$dish"
if [[ -L "$dish_dir" ]]; then
  echo "Dish output directory must not be a symlink: $dish_dir" >&2
  exit 2
fi
mkdir -p "$dish_dir" "$out_dir/_raw/$dish"

cleanup_pack_temps() {
  rm -rf -- "$dish_dir"/.tmp-pack-*
}
trap cleanup_pack_temps EXIT
cleanup_pack_temps
rm -rf -- "$dish_dir"/lod_* "$dish_dir"/pbr_* "$dish_dir/frames" "$dish_dir/poses"
rm -f -- "$dish_dir/qa_report.json" "$dish_dir/bake_report.json"

# Prepare viewer & Three.js mount inside out_dir so studio.html and render_ab.mjs load relative URLs cleanly
if [[ ! -e "$out_dir/_three" ]]; then
  ln -s "$THREE_DIR" "$out_dir/_three"
fi
cp "$here/viewer.html" "$out_dir/viewer.html"

# Copy source photo & raw mobile GLB reference
img_ext="${input_image##*.}"
cp -f "$input_image" "$dish_dir/source_photo.${img_ext}"

hires_dir=$(dirname "$hires_glb")
hires_stem=$(basename "$hires_glb" .glb)
raw_mobile_src=""
if [[ -f "$hires_dir/${hires_stem}_mobile.glb" ]]; then
  raw_mobile_src="$hires_dir/${hires_stem}_mobile.glb"
elif [[ -f "$hires_dir/trellis2_4b_hires_mobile.glb" ]]; then
  raw_mobile_src="$hires_dir/trellis2_4b_hires_mobile.glb"
else
  raw_mobile_src="$hires_glb"
fi
raw_mobile_dest="$out_dir/_raw/$dish/raw_mobile.glb"
if [[ "$raw_mobile_src" != "$raw_mobile_dest" ]]; then
  cp -f --remove-destination -- "$raw_mobile_src" "$raw_mobile_dest"
fi

exp0_render_args=()
exp0_studio_args=()
if [[ -n "$exp0_dir" ]]; then
  exp0_glb=""
  if [[ -f "$exp0_dir/$dish/lod_150k_2048.meshopt.glb" ]]; then
    exp0_glb="$exp0_dir/$dish/lod_150k_2048.meshopt.glb"
  elif [[ -f "$exp0_dir/$dish/lod_150k_2048.glb" ]]; then
    exp0_glb="$exp0_dir/$dish/lod_150k_2048.glb"
  fi
  if [[ -n "$exp0_glb" ]]; then
    mkdir -p "$out_dir/_exp0/$dish"
    exp0_dest="$out_dir/_exp0/$dish/lod_150k_2048.meshopt.glb"
    if [[ "$exp0_glb" != "$exp0_dest" ]]; then
      cp -f --remove-destination -- "$exp0_glb" "$exp0_dest"
    fi
    exp0_render_args=(--exp0-150k "_exp0/$dish/lod_150k_2048.meshopt.glb")
    exp0_studio_args=(--exp0-dir "$out_dir/_exp0")
  fi
fi

input_qa_args=()
cutout_extra_args=()
existing_cutout="$(dirname "$input_image")/cutout_rgba.png"
if [[ -f "$existing_cutout" ]]; then
  input_qa_args+=(--cutout "$existing_cutout")
  cutout_extra_args+=(--existing-cutout "$existing_cutout")
fi

echo "[1/8] Input QA ($dish)"
"$py" "$here/input_qa.py" "$input_image" "${input_qa_args[@]}" --out "$dish_dir/input_qa.json"

echo "[2/8] Cutout Clean (MemoryMax=4G)"
systemd-run --user --scope -q -p MemoryMax=4G \
  "$py" "$here/cutout_clean.py" "$input_image" "$dish_dir/cutout_clean.png" \
    "${cutout_extra_args[@]}" \
    --report "$dish_dir/cutout_report.json"

echo "[3/8] Blender 4.5 Cleanup, Seating & Cycles Bake (ulimit -v 12 GB)"
(
  ulimit -v 12000000
  "$BLENDER" -b --factory-startup --python-exit-code 1 -P "$here/blender_bake.py" -- \
    --input "$hires_glb" \
    --outdir "$dish_dir" \
    --lods 150000:2048,35000:1024 \
    "${blender_extra_args[@]}" \
    > "$dish_dir/blender.log" 2>&1
)
if grep -q "Circular dependency" "$dish_dir/blender.log"; then
  echo "ERROR: Circular dependency detected in $dish_dir/blender.log" >&2
  exit 1
fi

echo "[4/8] Deterministic Food PBR Authoring (150k + 35k)"
"$py" "$here/pbr_author.py" \
  "$dish_dir/lod_150k_2048_maps" \
  "$dish_dir/pbr_150k" \
  --report "$dish_dir/pbr_150k/pbr_report.json"
"$py" "$here/pbr_author.py" \
  "$dish_dir/lod_35k_1024_maps" \
  "$dish_dir/pbr_35k" \
  --report "$dish_dir/pbr_35k/pbr_report.json"

echo "[5/8] Pack WebP + Clearcoat/Sheen + Meshopt GLBs (MemoryMax=4G)"
systemd-run --user --scope -q -p MemoryMax=4G \
  node "$here/pack_pbr_glb.mjs" \
    "$dish_dir/lod_150k_2048_geom.glb" \
    "$dish_dir/pbr_150k" \
    "$dish_dir/lod_150k_2048.pbr.glb"
systemd-run --user --scope -q -p MemoryMax=4G \
  node "$here/pack_pbr_glb.mjs" \
    "$dish_dir/lod_35k_1024_geom.glb" \
    "$dish_dir/pbr_35k" \
    "$dish_dir/lod_35k_1024.pbr.glb"

echo "[6/8] Headless Studio A/B, Relighting & 216-Pose Renders (MemoryMax=4G)"
systemd-run --user --scope -q -p MemoryMax=4G \
  node "$here/render_ab.mjs" "$out_dir" "$dish" \
    --v1-150k "$dish/lod_150k_2048.pbr.glb" \
    --v1-35k "$dish/lod_35k_1024.pbr.glb" \
    --raw-mobile "_raw/$dish/raw_mobile.glb" \
    "${exp0_render_args[@]}" \
    > "$dish_dir/render.log" 2>&1

echo "[7/8] Automated QA Gate"
"$py" "$here/qa_gate.py" \
  --glb "$dish_dir/lod_150k_2048.pbr.glb" \
  --geom-glb "$dish_dir/lod_150k_2048_geom.glb" \
  --cutout "$dish_dir/cutout_clean.png" \
  --poses-dir "$dish_dir/poses" \
  --relit-a "$dish_dir/relit_0.png" \
  --relit-b "$dish_dir/relit_120.png" \
  --bake-report "$dish_dir/bake_report.json" \
  --uv-mask "$dish_dir/lod_150k_2048_maps/uv_mask.png" \
  --pbr-report "$dish_dir/pbr_150k/pbr_report.json" \
  --diag-img "$dish_dir/fidelity_diag.png" \
  --out "$dish_dir/qa_report.json"

echo "[8/8] Build Comparison Sheet & Interactive Studio"
"$py" "$here/build_studio.py" "$out_dir" --dishes "$dish" "${exp0_studio_args[@]}"

"$py" - "$dish_dir/qa_report.json" <<'PYTHON'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
print(f"QA verdict: {report['verdict']}")
for label, key in [('Reasons', 'reasons'), ('Warnings', 'warnings')]:
    print(f"{label}:")
    for item in report[key] or ['(none)']:
        print(f"  - {item}")
PYTHON

echo "Done ($dish): $dish_dir/qa_report.json | $out_dir/studio.html (publication_eligible: false)"
