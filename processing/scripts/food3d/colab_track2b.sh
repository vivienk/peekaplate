#!/usr/bin/env bash
# Track 2B with a Colab GPU reconstruction stage (high-res 2DGS + TSDF), then the usual local
# Blender/PBR/pack/eval/QA stages resumed through T2B_RECON_DIR.
#
#   colab_track2b.sh <dish> <dataset_dir> <out_root> [options]
#     --dry-run            print the plan, cap and commands; never provision or upload
#     --cap-units N        total compute-unit cap across every dish sharing <out_root> (default 25)
#     --gpu NAME           Colab accelerator (default L4)
#     --diameter-cm X      dish diameter passed to reconstruct and run_track2b.sh
#     --remote-only        stop after downloading the reconstruction (skip local stages)
#
# Remote knobs (env): COLAB_STEPS (30000), COLAB_MAX_SPLATS (600000), COLAB_REFINE_STOP (15000),
# COLAB_VOXEL ("auto": largest of 1024/896/768/640 that fits the VM's RAM).
# Spend safeguard: colab_budget.py turns the cap into a wall-clock limit (rate = max(reported,
# measured, floor 4/h); 8/h assumed until a runtime reports one). The runtime is always stopped
# on exit, error, interrupt or timeout. Spend is logged to <out_root>/colab_spend.jsonl.
# Every output is private R&D: publication_eligible: false (ADR 0004).
set -euo pipefail

if [[ $# -lt 3 ]]; then
  sed -n 2,18p "$0" >&2
  exit 2
fi
dish="$1"; dataset_dir=$(realpath "$2"); out_root="$3"; shift 3
dry_run=0; cap=25; gpu=L4; diameter_cm=""; remote_only=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --cap-units) cap="$2"; shift ;;
    --gpu) gpu="$2"; shift ;;
    --diameter-cm) diameter_cm="$2"; shift ;;
    --remote-only) remote_only=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
PY=${REPO_PY:-$repo/processing/.venv/bin/python}
COLAB=${COLAB_BIN:-$HOME/.local/bin/colab}
# shellcheck source=t2b_v7_recipe.sh
source "$here/t2b_v7_recipe.sh"
COLAB_STEPS=${COLAB_STEPS:-30000}
COLAB_MAX_SPLATS=${COLAB_MAX_SPLATS:-600000}
COLAB_REFINE_STOP=${COLAB_REFINE_STOP:-15000}
COLAB_VOXEL=${COLAB_VOXEL:-auto}
COLAB_EXEC_IDLE_TIMEOUT=${COLAB_EXEC_IDLE_TIMEOUT:-0}

if [[ -z "$diameter_cm" ]]; then
  case "$dish" in
    co3d_sandwich) diameter_cm="22.0" ;;
    co3d_pizza)    diameter_cm="28.0" ;;
    co3d_hotdog)   diameter_cm="20.0" ;;
    *)             diameter_cm="24.0" ;;
  esac
fi

T2B_SOLID_COMPLETE=${T2B_SOLID_COMPLETE:-0}
T2B_POISSON_DEPTH=${T2B_POISSON_DEPTH:-9}
T2B_KEEP_MULTI_COMPONENTS=${T2B_KEEP_MULTI_COMPONENTS:-0}

recon_flags=""
[[ "$T2B_TRIM_DRIPS" == "1" ]] && recon_flags+=" --trim-drips"
[[ "$T2B_REPAIR_PITS" == "1" ]] && recon_flags+=" --repair-pits"
[[ "$T2B_MASK_CARVE" == "1" ]] && recon_flags+=" --mask-carve"
[[ "$T2B_SOLID_COMPLETE" == "1" ]] && recon_flags+=" --solid-complete --poisson-depth $T2B_POISSON_DEPTH"
[[ "$T2B_KEEP_MULTI_COMPONENTS" == "1" ]] && recon_flags+=" --keep-multi-components"

mkdir -p "$out_root"
out_root=$(realpath "$out_root")
work="$out_root/colab/$dish"
mkdir -p "$work"
spend_log="$out_root/colab_spend.jsonl"
job_tar="$work/job.tar.gz"

echo "=== [colab 0] packing train-only job for $dish ==="
pack_json=$("$PY" "$here/colab_job.py" pack --dataset-dir "$dataset_dir" --out-tar "$job_tar")
echo "$pack_json"

plan() {  # $1 = usage text, $2 = optional reported rate
  local args=(plan --log "$spend_log" --dish "$dish" --cap "$cap" --usage-text "$1"
    --overhead-s "${COLAB_OVERHEAD_S:-600}" --min-s "${COLAB_MIN_S:-1200}")
  [[ -n "${2:-}" ]] && args+=(--reported-rate "$2")
  eval "$("$PY" "$here/colab_budget.py" "${args[@]}")"
}

usage_text=$("$COLAB" usage)
plan "$usage_text"
echo "=== [colab 1] budget: balance=$PLAN_BALANCE remaining=$PLAN_REMAINING/$cap rate=$PLAN_RATE/h ($PLAN_RATE_SOURCE) max_seconds=$PLAN_MAX_SECONDS run=$PLAN_RUN ($PLAN_REASON) ==="

session="food3d-${dish//_/-}-$(date +%s)"
remote_env=(--env "T2B_DISH=$dish" --env "T2B_STEPS=$COLAB_STEPS" --env "T2B_MAX_SPLATS=$COLAB_MAX_SPLATS"
  --env "T2B_REFINE_STOP_ITER=$COLAB_REFINE_STOP" --env "T2B_VOXEL_DIVISIONS=$COLAB_VOXEL"
  --env "T2B_TSDF_TRUNC_VOXELS=$T2B_TSDF_TRUNC_VOXELS" --env "T2B_TSDF_CUBE_PADDING=$T2B_TSDF_CUBE_PADDING"
  --env "T2B_DIAMETER_CM=$diameter_cm" --env "T2B_RECON_FLAGS=${recon_flags# }")

if [[ "$dry_run" == "1" ]]; then
  cat <<EOF
=== DRY RUN (no runtime provisioned, nothing uploaded) ===
dish=$dish gpu=$gpu cap=$cap units, remaining=$PLAN_REMAINING, would_run=$PLAN_RUN
remote: steps=$COLAB_STEPS max_splats=$COLAB_MAX_SPLATS refine_stop=$COLAB_REFINE_STOP voxel=$COLAB_VOXEL flags='${recon_flags# }'
upload: $job_tar ($(stat -c %s "$job_tar") bytes)
commands:
  $COLAB new -s $session --gpu $gpu
  $COLAB usage   # re-plan with the runtime's reported rate
  $COLAB upload -s $session $job_tar /content/t2b_job.tar.gz
  $COLAB upload -s $session $here/colab_remote_recon.py /content/t2b_remote.py
  $COLAB exec -s $session -f $here/colab_remote_launch.py --timeout 120 ${remote_env[*]}   # detached start
  every \${COLAB_POLL_S:-60}s until DONE/FAILED or <=$PLAN_MAX_SECONDS s: $COLAB exec -s $session -f $here/colab_remote_poll.py
  $COLAB download -s $session /content/t2b_result.tar.gz $work/result.tar.gz
  $COLAB stop -s $session   # also on any exit/error/timeout
then: T2B_RECON_DIR=$work/recon run_track2b.sh $dish $dataset_dir $out_root $diameter_cm
EOF
  exit 0
fi

if [[ "$PLAN_RUN" != "1" ]]; then
  echo "SKIP $dish: $PLAN_REASON" >&2
  exit 3
fi

session_up=0
balance_before="$PLAN_BALANCE"
t_start=$(date +%s)
status="error"
cleanup() {
  local rc=$?
  if [[ "$session_up" == "1" ]]; then
    echo "=== [colab] stopping runtime $session ===" >&2
    "$COLAB" stop -s "$session" >&2 || echo "WARNING: colab stop failed for $session; check 'colab usage'" >&2
    session_up=0
    local after
    after=$("$COLAB" usage 2>/dev/null || true)
    if [[ -n "$after" ]]; then
      "$PY" "$here/colab_budget.py" done --log "$spend_log" --dish "$dish" --before "$balance_before" \
        --usage-text "$after" --elapsed-s "$(( $(date +%s) - t_start ))" --status "$status" >&2 || true
    fi
  fi
  return $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --gpu accepts a comma list tried in order (e.g. L4,T4); each is retried COLAB_NEW_RETRIES times.
session_up=1
provisioned=""
IFS=',' read -r -a gpu_choices <<<"$gpu"
for g in "${gpu_choices[@]}"; do
  for attempt in $(seq 1 "${COLAB_NEW_RETRIES:-3}"); do
    echo "=== [colab 2] provisioning $g runtime $session (attempt $attempt) ==="
    if "$COLAB" new -s "$session" --gpu "$g"; then provisioned="$g"; break 2; fi
    "$COLAB" stop -s "$session" >/dev/null 2>&1 || true
    sleep "${COLAB_NEW_BACKOFF_S:-60}"
  done
done
if [[ -z "$provisioned" ]]; then
  status="no_capacity"; echo "ERROR: no capacity for any of: $gpu" >&2; exit 7
fi
gpu="$provisioned"

usage_live=$("$COLAB" usage)
live_rate=$(sed -nE 's/.*[Rr]ate:[[:space:]]*([0-9.]+).*/\1/p' <<<"$usage_live" | head -n1)
plan "$usage_live" "${live_rate:-}"
echo "=== [colab 2b] live rate=$PLAN_RATE/h ($PLAN_RATE_SOURCE) max_seconds=$PLAN_MAX_SECONDS run=$PLAN_RUN ==="
if [[ "$PLAN_RUN" != "1" ]]; then
  echo "SKIP $dish after provisioning: $PLAN_REASON" >&2
  status="skipped"
  exit 3
fi

echo "=== [colab 3] uploading job ==="
"$COLAB" upload -s "$session" "$job_tar" /content/t2b_job.tar.gz
"$COLAB" upload -s "$session" "$here/colab_remote_recon.py" /content/t2b_remote.py

echo "=== [colab 4] remote reconstruct, detached (limit ${PLAN_MAX_SECONDS}s) ==="
if ! timeout "${COLAB_LAUNCH_TIMEOUT_S:-300}" "$COLAB" exec -s "$session" -f "$here/colab_remote_launch.py" --timeout 120 "${remote_env[@]}" 2>&1 \
  | tee "$work/remote_exec.log"; then
  status="launch_failed"; echo "ERROR: remote launch failed or timed out" >&2; exit 5
fi
grep -q "LAUNCHED" "$work/remote_exec.log" || { status="launch_failed"; echo "ERROR: remote launch failed" >&2; exit 5; }
deadline=$(( $(date +%s) + PLAN_MAX_SECONDS ))
poll_failures=0
remote_state="running"
while :; do
  if (( $(date +%s) >= deadline )); then
    status="timeout"; echo "ERROR: remote stage hit the budget time limit" >&2; exit 4
  fi
  sleep "${COLAB_POLL_S:-60}"
  if poll_out=$(timeout 300 "$COLAB" exec -s "$session" -f "$here/colab_remote_poll.py" --timeout 120 2>&1); then
    poll_failures=0
    { grep '^REMOTE|' <<<"$poll_out" || true; } | tail -n 2 | tee -a "$work/remote_exec.log"
    remote_state=$(sed -nE 's/^STATUS=([a-z]+).*/\1/p' <<<"$poll_out" | tail -n1)
    [[ "$remote_state" == "done" || "$remote_state" == "failed" ]] && break
  else
    poll_failures=$((poll_failures + 1))
    echo "WARNING: poll failed ($poll_failures/${COLAB_POLL_MAX_FAILURES:-10})" >&2
    if (( poll_failures >= ${COLAB_POLL_MAX_FAILURES:-10} )); then
      status="lost_connection"; echo "ERROR: lost contact with the runtime" >&2; exit 5
    fi
  fi
done
if [[ "$remote_state" != "done" ]]; then
  status="remote_failed"; echo "ERROR: remote stage failed" >&2; exit 5
fi

echo "=== [colab 5] downloading reconstruction ==="
rm -f "$work/result.tar.gz"
"$COLAB" download -s "$session" /content/t2b_result.tar.gz "$work/result.tar.gz"
if [[ ! -s "$work/result.tar.gz" ]]; then
  status="download_failed"; echo "ERROR: result download failed" >&2; exit 6
fi
status="ok"
cleanup
trap - EXIT

"$PY" "$here/colab_job.py" unpack --result-tar "$work/result.tar.gz" --recon-dir "$work/recon" --dataset-dir "$dataset_dir"

if [[ "$remote_only" == "1" ]]; then
  echo "Reconstruction ready: $work/recon"
  exit 0
fi

echo "=== [local] resuming Track 2B stages from the Colab reconstruction ==="
T2B_RECON_DIR="$work/recon" T2B_KEEP_MULTI_COMPONENTS="$T2B_KEEP_MULTI_COMPONENTS" \
  "$here/run_track2b.sh" "$dish" "$dataset_dir" "$out_root" "$diameter_cm" "$COLAB_STEPS" \
  | tee "$out_root/$dish.run.log"
echo "Hero GLB:   $out_root/$dish/lod_150k_2048.pbr.glb"
echo "Mobile GLB: $out_root/$dish/lod_35k_1024.pbr.glb"
echo "(publication_eligible: false)"
