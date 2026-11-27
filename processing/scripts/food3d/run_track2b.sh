#!/usr/bin/env bash
# PeekaPlate Food3D Track 2B local pipeline driver:
#   2DGS (gsplat) -> Open3D TSDF -> Blender bake (150k/35k) ->
#   Multi-view photo UV projection -> PBR author -> WebP+Meshopt pack ->
#   Held-out evaluation (13 views) + Turntable contact sheet + QA Gate.
#
# Private R&D; every output carries publication_eligible: false (ADR 0004).
#
# Usage:
#   run_track2b.sh <dish> [dataset_dir] [out_root] [diameter_cm] [steps] [--pose-refine]
set -euo pipefail

POSE_REFINE="${T2B_POSE_REFINE:-0}"
POS_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--pose-refine" ]]; then
    POSE_REFINE=1
  else
    POS_ARGS+=("$arg")
  fi
done
set -- "${POS_ARGS[@]}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <dish> [dataset_dir] [out_root] [diameter_cm] [steps] [--pose-refine]" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)

T2B_DATASET_ROOT=${T2B_DATASET_ROOT:-/home/yacine105/kaggle-evals/track2-multiview-20261125/datasets}
T2B_OUT_ROOT_BASE=${T2B_OUT_ROOT_BASE:-/home/yacine105/kaggle-evals}
default_out_root="$T2B_OUT_ROOT_BASE/track2b-mesh-$(date +%Y%m%d-%H%M%S)"

dish="$1"
dataset_dir="${2:-$T2B_DATASET_ROOT/$dish}"
out_root="${3:-$default_out_root}"
diameter_cm="${4:-}"
steps="${5:-6000}"

if [[ -z "$diameter_cm" ]]; then
  case "$dish" in
    co3d_sandwich) diameter_cm="22.0" ;;
    co3d_pizza)    diameter_cm="28.0" ;;
    co3d_hotdog)   diameter_cm="20.0" ;;
    *)             diameter_cm="24.0" ;;
  esac
fi

T2B_PY=${T2B_PY:-/home/yacine105/tools/track2b-venv/bin/python}
REPO_PY=${REPO_PY:-$repo/processing/.venv/bin/python}
BLENDER=${BLENDER:-/home/yacine105/tools/blender-4.5.17-linux-x64/blender}
GLTF_TRANSFORM_NODE_MODULES=${GLTF_TRANSFORM_NODE_MODULES:-/home/yacine105/tools/gltf-transform/node_modules}
export GLTF_TRANSFORM=${GLTF_TRANSFORM:-$GLTF_TRANSFORM_NODE_MODULES/.bin/gltf-transform}
export NODE_PATH="${NODE_PATH:+$NODE_PATH:}$GLTF_TRANSFORM_NODE_MODULES"
if [[ -z "${THREE_DIR:-}" ]]; then
  THREE_DIR=$(ls -d "$repo/frontend/diner/node_modules/three" "$repo/node_modules/three" "$repo"/node_modules/.pnpm/three@*/node_modules/three 2>/dev/null | head -n 1 || true)
fi
if [[ -z "${PLAYWRIGHT_MODULE:-}" ]]; then
  PLAYWRIGHT_MODULE=$(ls -d "$repo/node_modules/playwright/index.mjs" "$repo"/node_modules/.pnpm/playwright@*/node_modules/playwright/index.mjs 2>/dev/null | head -n 1 || true)
fi
if [[ -z "${SHARP_PATH:-}" ]]; then
  SHARP_PATH=$(ls -d "$repo/node_modules/sharp" "$repo"/node_modules/.pnpm/sharp@*/node_modules/sharp 2>/dev/null | head -n 1 || true)
fi
export THREE_DIR PLAYWRIGHT_MODULE SHARP_PATH
export CHROMIUM_PATH=${CHROMIUM_PATH:-/home/yacine105/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell}

T2B_SMOOTH_ITERS=${T2B_SMOOTH_ITERS:-2}
T2B_FINE_DETAIL=${T2B_FINE_DETAIL:-0}
if [[ "$T2B_FINE_DETAIL" == "1" ]]; then
  T2B_MICRO_NORMAL_STRENGTH=${T2B_MICRO_NORMAL_STRENGTH:-0.0}
  T2B_OCCLUSION_STRENGTH=${T2B_OCCLUSION_STRENGTH:-0.70}
  T2B_DETAIL_NORMAL_STRENGTH=${T2B_DETAIL_NORMAL_STRENGTH:-18.0}
  T2B_CAVITY_STRENGTH=${T2B_CAVITY_STRENGTH:-0.75}
  T2B_ORM_MAX_SIZE=${T2B_ORM_MAX_SIZE:-1024}
  T2B_NORMAL_WEBP_QUALITY=${T2B_NORMAL_WEBP_QUALITY:-90}
else
  T2B_MICRO_NORMAL_STRENGTH=${T2B_MICRO_NORMAL_STRENGTH:-0.25}
  T2B_OCCLUSION_STRENGTH=${T2B_OCCLUSION_STRENGTH:-0.25}
  T2B_DETAIL_NORMAL_STRENGTH=${T2B_DETAIL_NORMAL_STRENGTH:-0.0}
  T2B_CAVITY_STRENGTH=${T2B_CAVITY_STRENGTH:-0.0}
  T2B_ORM_MAX_SIZE=${T2B_ORM_MAX_SIZE:-512}
  T2B_NORMAL_WEBP_QUALITY=${T2B_NORMAL_WEBP_QUALITY:-88}
fi
T2B_REUSE_DIR=${T2B_REUSE_DIR:-}
T2B_RECON_DIR=${T2B_RECON_DIR:-}
# With T2B_REUSE_DIR set, T2B_REPROJECT=1 reuses the geometry + baked maps but still
# re-runs stage 3 (photo UV projection) instead of reusing the projected basecolor too.
T2B_REPROJECT=${T2B_REPROJECT:-0}
T2B_WET_CAP=${T2B_WET_CAP:-0.04}
T2B_WET_FOOD=${T2B_WET_FOOD:-0}
T2B_WET_OIL_CAP=${T2B_WET_OIL_CAP:-0.35}
T2B_OIL_ROUGHNESS_MIN=${T2B_OIL_ROUGHNESS_MIN:-0.25}
T2B_OIL_ROUGHNESS_MAX=${T2B_OIL_ROUGHNESS_MAX:-0.40}
T2B_OIL_ROUGHNESS_MID=${T2B_OIL_ROUGHNESS_MID:-0.50}
T2B_OIL_ROUGHNESS_SPAN=${T2B_OIL_ROUGHNESS_SPAN:-0.15}
T2B_OIL_CLEARCOAT_MAX=${T2B_OIL_CLEARCOAT_MAX:-0.15}
T2B_OIL_CLEARCOAT_ROUGHNESS=${T2B_OIL_CLEARCOAT_ROUGHNESS:-0.12}
T2B_OIL_ALBEDO_REMOVAL=${T2B_OIL_ALBEDO_REMOVAL:-0.18}
T2B_SPECULAR_GLOSS_MAP=${T2B_SPECULAR_GLOSS_MAP:-}
T2B_SPECULAR_GLOSS_MAP_35K=${T2B_SPECULAR_GLOSS_MAP_35K:-}
T2B_TEXTURE_MODE=${T2B_TEXTURE_MODE:-blend}
T2B_SEAM_WIDTH_PX=${T2B_SEAM_WIDTH_PX:-3.0}
T2B_POTTS_WEIGHT=${T2B_POTTS_WEIGHT:-0.75}
T2B_VOXEL_DIVISIONS=${T2B_VOXEL_DIVISIONS:-320}
T2B_TSDF_CUBE_PADDING=${T2B_TSDF_CUBE_PADDING:-1.5}
T2B_TSDF_TRUNC_VOXELS=${T2B_TSDF_TRUNC_VOXELS:-6.0}
T2B_TSDF_DEPTH_SOURCE=${T2B_TSDF_DEPTH_SOURCE:-expected}
T2B_TSDF_ALPHA_THRESH=${T2B_TSDF_ALPHA_THRESH:-0.10}
T2B_HERO_FACES=${T2B_HERO_FACES:-150000}
T2B_HERO_TEX_SIZE=${T2B_HERO_TEX_SIZE:-2048}
T2B_HERO_DOWNSAMPLE_SIZE=${T2B_HERO_DOWNSAMPLE_SIZE:-}
T2B_MASK_CARVE=${T2B_MASK_CARVE:-0}
T2B_MASK_CARVE_TOL_PX=${T2B_MASK_CARVE_TOL_PX:-2.0}
T2B_MASK_CARVE_MAX_OUT_FRAC=${T2B_MASK_CARVE_MAX_OUT_FRAC:-0.38}
T2B_TRIM_DRIPS=${T2B_TRIM_DRIPS:-0}
T2B_REPAIR_PITS=${T2B_REPAIR_PITS:-0}
T2B_COLOR_FIELD=${T2B_COLOR_FIELD:-0}
T2B_INPAINT_UNPROJECTED=${T2B_INPAINT_UNPROJECTED:-0}
T2B_BRIGHT_CONCAVE=${T2B_BRIGHT_CONCAVE:-0}
T2B_BRIGHT_CONCAVE_Q_LO=${T2B_BRIGHT_CONCAVE_Q_LO:-0.60}
T2B_BRIGHT_CONCAVE_Q_HI=${T2B_BRIGHT_CONCAVE_Q_HI:-0.92}
T2B_SOLID_COMPLETE=${T2B_SOLID_COMPLETE:-0}
T2B_POISSON_DEPTH=${T2B_POISSON_DEPTH:-9}
T2B_KEEP_MULTI_COMPONENTS=${T2B_KEEP_MULTI_COMPONENTS:-0}
hero_tag="lod_$((T2B_HERO_FACES / 1000))k_${T2B_HERO_TEX_SIZE}"

dish_dir="$out_root/$dish"
if [[ -n "$T2B_RECON_DIR" ]]; then
  if [[ -n "$T2B_REUSE_DIR" || "$POSE_REFINE" == "1" ]]; then
    echo "ERROR: T2B_RECON_DIR cannot be combined with T2B_REUSE_DIR or pose refinement" >&2
    exit 1
  fi
  for required in dense_clean.glb track2b_recon_meta.json; do
    if [[ ! -s "$T2B_RECON_DIR/$required" ]]; then
      echo "ERROR: missing reconstruction artifact: $T2B_RECON_DIR/$required" >&2
      exit 1
    fi
  done
fi
mkdir -p "$dish_dir"
# Clear stale LODs, pose grids, and pack scratch directories on re-run.
rm -rf "$dish_dir"/lod_* "$dish_dir/eval/poses" "$dish_dir/eval_aligned" "$dish_dir"/.tmp-pack-*
if [[ "$POSE_REFINE" != "1" ]]; then
  rm -f "$dish_dir/refined_train_poses.json" "$dish_dir/heldout_cameras_aligned.json"
fi

reused_stages_1_to_3=0
if [[ -n "$T2B_REUSE_DIR" ]]; then
  reuse_src="$T2B_REUSE_DIR"
  if [[ -d "$T2B_REUSE_DIR/$dish" && -f "$T2B_REUSE_DIR/$dish/bake_report.json" ]]; then
    reuse_src="$T2B_REUSE_DIR/$dish"
  fi
  if [[ ! -f "$reuse_src/track2b_recon_meta.json" || ! -f "$reuse_src/bake_report.json" || ! -d "$reuse_src/${hero_tag}_maps" || ! -d "$reuse_src/lod_35k_1024_maps" ]]; then
    echo "ERROR: T2B_REUSE_DIR=$T2B_REUSE_DIR missing required v7 geometry/maps in $reuse_src" >&2
    exit 1
  fi
  echo "=== [1-3/8] Reusing geometry, baked maps & projected UV textures from $reuse_src ==="
  cp -f "$reuse_src/track2b_recon_meta.json" "$reuse_src/bake_report.json" "$dish_dir/"
  if [[ -f "$reuse_src/refined_train_poses.json" ]]; then
    cp -f "$reuse_src/refined_train_poses.json" "$dish_dir/"
  fi
  cp -f "$reuse_src/${hero_tag}_geom.glb" "$reuse_src/lod_35k_1024_geom.glb" "$dish_dir/"
  cp -a "$reuse_src/${hero_tag}_maps" "$reuse_src/lod_35k_1024_maps" "$dish_dir/"
  reused_stages_1_to_3=1
fi

if [[ "$reused_stages_1_to_3" != "1" ]]; then
if [[ -n "$T2B_RECON_DIR" ]]; then
  echo "=== [1/8] Using existing reconstruction from $T2B_RECON_DIR ==="
  cp -f "$T2B_RECON_DIR/dense_clean.glb" "$T2B_RECON_DIR/track2b_recon_meta.json" "$dish_dir/"
else
echo "=== [1/8] 2DGS + Open3D TSDF Reconstruction ($dish, steps=$steps, res=$T2B_VOXEL_DIVISIONS, pad=$T2B_TSDF_CUBE_PADDING, tex=$T2B_TEXTURE_MODE, diam=${diameter_cm}cm, pose_refine=$POSE_REFINE) ==="
recon_extra_args=()
if [[ "$POSE_REFINE" == "1" ]]; then
  recon_extra_args+=(--pose-refine)
fi
if [[ -n "${T2B_REFINE_STOP_ITER:-}" ]]; then
  recon_extra_args+=(--refine-stop-iter "$T2B_REFINE_STOP_ITER")
fi
if [[ "$T2B_MASK_CARVE" == "1" ]]; then
  recon_extra_args+=(--mask-carve --mask-carve-tol-px "$T2B_MASK_CARVE_TOL_PX" --mask-carve-max-out-frac "$T2B_MASK_CARVE_MAX_OUT_FRAC")
fi
if [[ "$T2B_TRIM_DRIPS" == "1" ]]; then
  recon_extra_args+=(--trim-drips)
fi
if [[ "$T2B_REPAIR_PITS" == "1" ]]; then
  recon_extra_args+=(--repair-pits)
fi
if [[ "$T2B_SOLID_COMPLETE" == "1" ]]; then
  recon_extra_args+=(--solid-complete --poisson-depth "$T2B_POISSON_DEPTH")
fi
if [[ "$T2B_KEEP_MULTI_COMPONENTS" == "1" ]]; then
  recon_extra_args+=(--keep-multi-components)
fi
systemd-run --user --scope -q -p MemoryMax=10G \
  "$T2B_PY" "$here/track2b_mesh.py" reconstruct \
    --dish "$dish" \
    --dataset-dir "$dataset_dir" \
    --out-dir "$dish_dir" \
    --diameter-cm "$diameter_cm" \
    --steps "$steps" \
    --voxel-divisions "$T2B_VOXEL_DIVISIONS" \
    --tsdf-alpha-thresh "$T2B_TSDF_ALPHA_THRESH" \
    --tsdf-depth-source "$T2B_TSDF_DEPTH_SOURCE" \
    --tsdf-trunc-voxels "$T2B_TSDF_TRUNC_VOXELS" \
    --tsdf-cube-padding "$T2B_TSDF_CUBE_PADDING" \
    --smooth-iterations "$T2B_SMOOTH_ITERS" \
    "${recon_extra_args[@]}"
fi

echo "=== [2/8] Blender 4.5 Cleanup, Seating & Cycles Bake (${T2B_HERO_FACES}:${T2B_HERO_TEX_SIZE}, 35k:1024) ==="
blender_extra_args=()
if [[ "$T2B_KEEP_MULTI_COMPONENTS" != "1" ]]; then
  blender_extra_args+=(--main-object-only)
fi
(
  ulimit -v 12000000
  "$BLENDER" -b --factory-startup --python-exit-code 1 -P "$here/blender_bake.py" -- \
    --input "$dish_dir/dense_clean.glb" \
    --outdir "$dish_dir" \
    --lods "${T2B_HERO_FACES}:${T2B_HERO_TEX_SIZE},35000:1024" \
    --diameter-cm "$diameter_cm" \
    "${blender_extra_args[@]}" \
    > "$dish_dir/blender.log" 2>&1
)
if grep -q "Circular dependency" "$dish_dir/blender.log"; then
  echo "ERROR: Circular dependency detected in $dish_dir/blender.log" >&2
  exit 1
fi
fi

if [[ "$reused_stages_1_to_3" != "1" || "$T2B_REPROJECT" == "1" ]]; then

echo "=== [3/8] Multi-View Train Photo UV Projection (150k + 35k, mode=$T2B_TEXTURE_MODE) ==="
proj_extra_args=()
if [[ "$T2B_COLOR_FIELD" == "1" ]]; then
  proj_extra_args+=(--color-field)
fi
if [[ "$T2B_INPAINT_UNPROJECTED" == "1" ]]; then
  proj_extra_args+=(--inpaint-unprojected)
fi
if [[ "$T2B_BRIGHT_CONCAVE" == "1" ]]; then
  proj_extra_args+=(--bright-concave --bright-concave-q-lo "$T2B_BRIGHT_CONCAVE_Q_LO" --bright-concave-q-hi "$T2B_BRIGHT_CONCAVE_Q_HI")
fi
systemd-run --user --scope -q -p MemoryMax=10G \
  "$T2B_PY" "$here/track2b_mesh.py" project-uv \
    --geom-glb "$dish_dir/${hero_tag}_geom.glb" \
    --maps-dir "$dish_dir/${hero_tag}_maps" \
    --dataset-dir "$dataset_dir" \
    --recon-meta "$dish_dir/track2b_recon_meta.json" \
    --bake-report "$dish_dir/bake_report.json" \
    --texture-mode "$T2B_TEXTURE_MODE" \
    --seam-width-px "$T2B_SEAM_WIDTH_PX" \
    --potts-weight "$T2B_POTTS_WEIGHT" \
    "${proj_extra_args[@]}"

if [[ -n "$T2B_HERO_DOWNSAMPLE_SIZE" && "$T2B_HERO_DOWNSAMPLE_SIZE" != "$T2B_HERO_TEX_SIZE" ]]; then
  echo "=== [3b/8] Downsampling hero maps ${T2B_HERO_TEX_SIZE} -> ${T2B_HERO_DOWNSAMPLE_SIZE} with sharpening ==="
  "$REPO_PY" - "$here" "$dish_dir/${hero_tag}_maps" "$T2B_HERO_DOWNSAMPLE_SIZE" <<'PY'
import sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, sys.argv[1])
import track2b_mesh as t2b
maps_dir = Path(sys.argv[2])
sz = int(sys.argv[3])
t2b.downsample_texture_sharpened(maps_dir / "basecolor.png", sz)
for name, mode in (("normal.png", Image.Resampling.LANCZOS), ("ao.png", Image.Resampling.LANCZOS), ("geom_features.png", Image.Resampling.LANCZOS), ("uv_mask.png", Image.Resampling.NEAREST)):
    p = maps_dir / name
    if p.is_file():
        with Image.open(p) as im:
            im.resize((sz, sz), mode).save(p, format="PNG")
PY
fi

systemd-run --user --scope -q -p MemoryMax=10G \
  "$T2B_PY" "$here/track2b_mesh.py" project-uv \
    --geom-glb "$dish_dir/lod_35k_1024_geom.glb" \
    --maps-dir "$dish_dir/lod_35k_1024_maps" \
    --dataset-dir "$dataset_dir" \
    --recon-meta "$dish_dir/track2b_recon_meta.json" \
    --bake-report "$dish_dir/bake_report.json" \
    --texture-mode "$T2B_TEXTURE_MODE" \
    --seam-width-px "$T2B_SEAM_WIDTH_PX" \
    --potts-weight "$T2B_POTTS_WEIGHT" \
    "${proj_extra_args[@]}"
fi

echo "=== [4/8] Deterministic Food PBR Authoring (150k + 35k, fine_detail=$T2B_FINE_DETAIL, wet_food=$T2B_WET_FOOD) ==="
pbr_extra_args=()
if [[ "$T2B_WET_FOOD" == "1" ]]; then
  pbr_extra_args+=(
    --wet-food
    --wet-oil-cap "$T2B_WET_OIL_CAP"
    --oil-roughness-min "$T2B_OIL_ROUGHNESS_MIN"
    --oil-roughness-max "$T2B_OIL_ROUGHNESS_MAX"
    --oil-roughness-mid "$T2B_OIL_ROUGHNESS_MID"
    --oil-roughness-span "$T2B_OIL_ROUGHNESS_SPAN"
    --oil-clearcoat-max "$T2B_OIL_CLEARCOAT_MAX"
    --oil-clearcoat-roughness "$T2B_OIL_CLEARCOAT_ROUGHNESS"
    --oil-albedo-removal "$T2B_OIL_ALBEDO_REMOVAL"
  )
fi
pbr_extra_args_150k=("${pbr_extra_args[@]}")
pbr_extra_args_35k=("${pbr_extra_args[@]}")
# The 150k and 35k LODs use different UV atlases, so each needs its own gloss map.
if [[ -n "$T2B_SPECULAR_GLOSS_MAP" ]]; then
  pbr_extra_args_150k+=(--specular-gloss-map "$T2B_SPECULAR_GLOSS_MAP")
fi
if [[ -n "$T2B_SPECULAR_GLOSS_MAP_35K" ]]; then
  pbr_extra_args_35k+=(--specular-gloss-map "$T2B_SPECULAR_GLOSS_MAP_35K")
fi
"$REPO_PY" "$here/pbr_author.py" \
  "$dish_dir/${hero_tag}_maps" \
  "$dish_dir/pbr_150k" \
  --micro-normal-strength "$T2B_MICRO_NORMAL_STRENGTH" \
  --detail-normal-strength "$T2B_DETAIL_NORMAL_STRENGTH" \
  --cavity-strength "$T2B_CAVITY_STRENGTH" \
  --occlusion-strength "$T2B_OCCLUSION_STRENGTH" \
  --wet-cap "$T2B_WET_CAP" \
  --report "$dish_dir/pbr_150k/pbr_report.json" \
  "${pbr_extra_args_150k[@]}"
"$REPO_PY" "$here/pbr_author.py" \
  "$dish_dir/lod_35k_1024_maps" \
  "$dish_dir/pbr_35k" \
  --micro-normal-strength "$T2B_MICRO_NORMAL_STRENGTH" \
  --detail-normal-strength "$T2B_DETAIL_NORMAL_STRENGTH" \
  --cavity-strength "$T2B_CAVITY_STRENGTH" \
  --occlusion-strength "$T2B_OCCLUSION_STRENGTH" \
  --wet-cap "$T2B_WET_CAP" \
  --report "$dish_dir/pbr_35k/pbr_report.json" \
  "${pbr_extra_args_35k[@]}"

echo "=== [5/8] Pack WebP + Clearcoat/Sheen + Meshopt GLBs (MemoryMax=8G) ==="
systemd-run --user --scope -q -p MemoryMax=8G \
  node "$here/pack_pbr_glb.mjs" \
    "$dish_dir/${hero_tag}_geom.glb" \
    "$dish_dir/pbr_150k" \
    "$dish_dir/${hero_tag}.pbr.glb" \
    --pbr-report "$dish_dir/pbr_150k/pbr_report.json" \
    --occlusion-strength "$T2B_OCCLUSION_STRENGTH" \
    --orm-max-size "$T2B_ORM_MAX_SIZE" \
    --normal-webp-quality "$T2B_NORMAL_WEBP_QUALITY"
if [[ "${hero_tag}" != "lod_150k_2048" ]]; then
  cp -f "$dish_dir/${hero_tag}.pbr.glb" "$dish_dir/lod_150k_2048.pbr.glb"
fi
systemd-run --user --scope -q -p MemoryMax=8G \
  node "$here/pack_pbr_glb.mjs" \
    "$dish_dir/lod_35k_1024_geom.glb" \
    "$dish_dir/pbr_35k" \
    "$dish_dir/lod_35k_1024.pbr.glb" \
    --pbr-report "$dish_dir/pbr_35k/pbr_report.json" \
    --occlusion-strength "$T2B_OCCLUSION_STRENGTH" \
    --orm-max-size "$T2B_ORM_MAX_SIZE" \
    --normal-webp-quality "$T2B_NORMAL_WEBP_QUALITY"

if [[ -f "$dataset_dir/transforms_val.json" ]]; then
  echo "=== [6/8] Held-Out Camera Renders + Turntable + Relit + Poses ==="
  "$REPO_PY" "$here/track2b_mesh.py" prep-eval-cameras \
    --dataset-dir "$dataset_dir" \
    --recon-meta "$dish_dir/track2b_recon_meta.json" \
    --bake-report "$dish_dir/bake_report.json" \
    --out-json "$dish_dir/heldout_cameras.json"

  systemd-run --user --scope -q -p MemoryMax=4G \
    node "$here/render_track2b_eval.mjs" \
      --glb "$dish_dir/${hero_tag}.pbr.glb" \
      --cameras "$dish_dir/heldout_cameras.json" \
      --out-dir "$dish_dir/eval" \
      --modes albedo,lit \
      --render-poses

  echo "=== [7/8] Held-Out Evaluation Metrics & Turntable Contact Sheet ==="
  "$REPO_PY" "$here/track2b_mesh.py" score-heldout \
    --dish "$dish" \
    --dataset-dir "$dataset_dir" \
    --eval-dir "$dish_dir/eval" \
    --out-dir "$dish_dir/eval" \
    --modes albedo,lit

  "$REPO_PY" "$here/track2b_mesh.py" texture-sharpness \
    --tex "$dish_dir/${hero_tag}_maps/basecolor.png" \
    --uv-mask "$dish_dir/${hero_tag}_maps/uv_mask.png" \
    --out-json "$dish_dir/eval/texture_sharpness_150k.json"

  if [[ "$POSE_REFINE" == "1" ]]; then
    echo "=== [7b/8] Test-Time Held-Out Pose Alignment & Aligned Eval (mesh/texture frozen; held-out images for pose only) ==="
    systemd-run --user --scope -q -p MemoryMax=10G \
      "$T2B_PY" "$here/track2b_mesh.py" align-heldout-cameras \
        --geom-glb "$dish_dir/${hero_tag}_geom.glb" \
        --basecolor "$dish_dir/pbr_150k/basecolor_delit.png" \
        --cameras "$dish_dir/heldout_cameras.json" \
        --dataset-dir "$dataset_dir" \
        --out-json "$dish_dir/heldout_cameras_aligned.json" \
        --report-out "$dish_dir/eval_aligned/heldout_pose_alignment_report.json"

    systemd-run --user --scope -q -p MemoryMax=4G \
      node "$here/render_track2b_eval.mjs" \
        --glb "$dish_dir/${hero_tag}.pbr.glb" \
        --cameras "$dish_dir/heldout_cameras_aligned.json" \
        --out-dir "$dish_dir/eval_aligned" \
        --modes albedo,lit \
        --skip-turntable

    "$REPO_PY" "$here/track2b_mesh.py" score-heldout \
      --dish "$dish" \
      --dataset-dir "$dataset_dir" \
      --eval-dir "$dish_dir/eval_aligned" \
      --out-dir "$dish_dir/eval_aligned" \
      --modes albedo,lit
  fi
else
  echo "=== [6/8] Skipping held-out renders (transforms_val.json absent); rendering Turntable + Relit + Poses ==="
  rm -rf "$dish_dir/heldout_cameras.json" "$dish_dir/eval/heldout_"* "$dish_dir/eval/heldout_metrics_"* "$dish_dir/eval/heldout_eval_sheet_"*
  systemd-run --user --scope -q -p MemoryMax=4G \
    node "$here/render_track2b_eval.mjs" \
      --glb "$dish_dir/${hero_tag}.pbr.glb" \
      --out-dir "$dish_dir/eval" \
      --render-poses

  echo "=== [7/8] Skipping held-out scoring (transforms_val.json absent); building Turntable Contact Sheet ==="
  "$REPO_PY" "$here/track2b_mesh.py" score-heldout \
    --dish "$dish" \
    --dataset-dir "$dataset_dir" \
    --eval-dir "$dish_dir/eval" \
    --out-dir "$dish_dir/eval" \
    --modes albedo,lit
fi

echo "=== [8/8] Automated QA Gate (150k Hero + 35k Mobile Budget/PBR, strict) ==="
ref_cutout=$("$REPO_PY" "$here/track2b_mesh.py" prep-qa-cutout \
  --dataset-dir "$dataset_dir" \
  --out-cutout "$dish_dir/eval/ref_cutout.png")
qa_extra_args=()
if [[ -f "$dish_dir/eval/score_summary.json" ]]; then
  qa_extra_args+=(--score-summary "$dish_dir/eval/score_summary.json")
fi
"$REPO_PY" "$here/qa_gate.py" \
  --glb "$dish_dir/${hero_tag}.pbr.glb" \
  --geom-glb "$dish_dir/${hero_tag}_geom.glb" \
  --cutout "$ref_cutout" \
  --poses-dir "$dish_dir/eval/poses" \
  --relit-a "$dish_dir/eval/relit_0.png" \
  --relit-b "$dish_dir/eval/relit_120.png" \
  --bake-report "$dish_dir/bake_report.json" \
  --uv-mask "$dish_dir/${hero_tag}_maps/uv_mask.png" \
  --pbr-report "$dish_dir/pbr_150k/pbr_report.json" \
  --diag-img "$dish_dir/eval/fidelity_diag.png" \
  --out "$dish_dir/qa_report_150k.json" \
  "${qa_extra_args[@]}" \
  --strict

"$REPO_PY" - "$here" "$dish_dir/lod_35k_1024.pbr.glb" "$dish_dir/lod_35k_1024_geom.glb" "$dish_dir/lod_35k_1024_maps/uv_mask.png" "$dish_dir/qa_report_35k.json" <<'PY'
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import qa_gate
glb, geom, uvm, out = Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]), Path(sys.argv[5])
checks = {
    "gltf_budget": qa_gate.check_gltf_budget(glb, max_bytes=5_242_880, max_tris=40_000),
    "geometry": qa_gate.check_geometry(geom_glb=geom),
    "pbr_material": qa_gate.audit_glb_pbr(glb, uv_mask_path=uvm),
}
verdict, reasons, warnings = qa_gate.compute_overall_verdict(checks)
report = {"schema_version": 1, "publication_eligible": False, "verdict": verdict, "reasons": reasons, "warnings": warnings, "checks": checks}
out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(f"35k QA verdict: {verdict}")
if verdict == "FAIL":
    sys.exit(1)
PY

echo "Done ($dish): $dish_dir (publication_eligible: false)"
