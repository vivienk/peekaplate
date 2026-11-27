# Decision 2026-11-23: Kaggle and Colab hybrid

On 2026-11-23 the user, who has about 200 Colab credits, agreed to a hybrid setup. Kaggle (free, CLI-automated) keeps the routine sweeps. Colab credits go only to the runs that a T4 blocks:
- TRELLIS.2 at high resolution, on an L4
- full Hunyuan3D-2.1 PBR (paint needs about 21 GB), on an A100

Estimates as of 2026-11-23 (rates from memory, no timings yet): about 15–20 credits for TRELLIS, about 25–35 for Hunyuan3D-2.1, and 10–30 for debugging. Each GPU gets a 1-dish test before the full run.

Control: Google's official Colab MCP server drives the notebook open in the user's browser. The user picks the GPU. Outputs are saved per dish to Google Drive and then synced to this machine with rclone, which the user approves once in their browser. See [colab-mcp-setup](colab-mcp-setup.md) once it exists.

Related: [hunyuan3d21-feasibility](hunyuan3d-21-feasibility.md), [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md).

## Setup progress, 2026-11-23
- rclone v1.76.0 is installed at ~/.local/bin/rclone, checked against the official SHA256SUMS. Remote `gdrive` uses scope=drive. rclone warns that its shared client_id is being retired during 2026, so a personal client_id will be needed eventually.
- The 41-dish dataset (76 files, 16.9 MiB) is uploaded to `gdrive:peekaplate/dish-menu-41/`.
- The user supplied an HF token in chat and plans to revoke it after the runs. It is stored only at `gdrive:peekaplate/secrets/hf_token.txt`, never in the repo, wiki or memory. Account `moosalah`, role read.
- Download checks with that token: TRELLIS.2-4B 200, DINOv3 200, **SPAR3D 403** (gated; the user must accept the terms on HF).
- Pending: the Colab notebooks must also read the token from `/content/drive/MyDrive/peekaplate/secrets/hf_token.txt` when the Colab Secret is missing, without printing it.
- 2026-11-23 later: the user accepted the SPAR3D terms on HF; recheck below. User wants the token kept and used until the feature ships, then revoked; delete gdrive:peekaplate/secrets/hf_token.txt at that time.
