# Kaggle: attached token dataset sometimes missing at runtime

On 2026-11-23, sweep-trellis-a v1 and sweep-trellis-b v1 had **identical** pulled metadata: `dataset_sources [peekaplate-dish-menu-41, peekaplate-hf-token]`, NvidiaTeslaT4.
- A printed `HF token source: dataset:peekaplate-hf-token/hf_token.txt` and got TRELLIS 19/20 success (18 skipped on the plate guard).
- B printed `HF token source: missing`, then `DINOv3 preflight: ok=False (missing_hf_token)`, and skipped TRELLIS on all 20 dishes (22–41) while still running MoGe-2. That burned a GPU session for nothing.
- Cause: not code. It looks like an intermittent Kaggle dataset mount; unconfirmed, because the log does not list /kaggle/input.
- Action, 2026-11-23: re-pushed B as v2.
- Environment improvement queued: when TRELLIS is enabled and the token is missing, the generator should print the /kaggle/input tree and **abort the kernel** instead of running hours of non-TRELLIS work.
Related: [kaggle-hf-token-via-dataset](kaggle-hf-token-via-dataset.md), [trellis-retry-plan-2026-11-23](trellis-retry-plan-2026-11-23.md).
