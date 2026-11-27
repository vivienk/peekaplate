#!/usr/bin/env bash
# Exp0 pipeline driver (2026-11-24): cleanup/LOD -> compression -> turntables -> fidelity.
# Private R&D; every output stays publication_eligible: false.
#
#   run_dish.sh <exp0_dir> <dish> [--main-object-only]
#
# <exp0_dir> holds viewer.html, _three (three@0.182.0) and _src/<dish>/{trellis2_4b_hires.glb,
# cutout_rgba.png}. Tool locations can be overridden with BLENDER, GLTF_TRANSFORM, CHROMIUM_PATH.
set -euo pipefail

root=$(realpath "$1"); dish=$2; shift 2
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
BLENDER=${BLENDER:-$HOME/tools/blender-4.5.17-linux-x64/blender}
GLTF_TRANSFORM=${GLTF_TRANSFORM:-$HOME/tools/gltf-transform/node_modules/.bin/gltf-transform}
export CHROMIUM_PATH=${CHROMIUM_PATH:-$HOME/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell}
py="$repo/processing/.venv/bin/python"

mkdir -p "$root/$dish"
cp "$here/viewer.html" "$root/viewer.html"

echo "[1/4] cleanup + LOD bake (CPU, ulimit -v 12 GB)"
( ulimit -v 12000000
  "$BLENDER" -b --factory-startup -P "$here/food_lod_bake.py" -- \
    --input "$root/_src/$dish/trellis2_4b_hires.glb" --outdir "$root/$dish" "$@" \
    > "$root/$dish/blender.log" 2>&1 )

echo "[2/4] meshopt compression (systemd MemoryMax 4G; wasm cannot run under ulimit -v)"
for lod in lod_150k_2048 lod_35k_1024; do
  systemd-run --user --scope -q -p MemoryMax=4G \
    "$GLTF_TRANSFORM" meshopt "$root/$dish/$lod.glb" "$root/$dish/$lod.meshopt.glb" --level medium > /dev/null
done

echo "[3/4] turntables + contact sheet"
node "$here/render_turntables.mjs" "$root" "$dish" > "$root/$dish/render.log"
"$py" -I "$here/contact_sheet.py" "$root" "$dish"

echo "[4/4] fidelity against the source cutout"
rm -rf "$root/fidelity/$dish/clean"
node "$here/fidelity_renders.mjs" "$root" "fidelity/$dish/clean" "$dish/lod_35k_1024.meshopt.glb" > /dev/null
"$py" -I "$here/fidelity.py" "$root/_src/$dish/cutout_rgba.png" "$root/fidelity/$dish/clean" \
  --out "$root/fidelity/$dish/clean.json"
ls -l "$root/$dish"/*.glb
