# Kaggle: HF token travels as a private dataset

On 2026-11-23 (docs/CONTEXT.md handoff): `UserSecretsClient` raised ConnectionError inside API-pushed kernels, and no API attaches a notebook secret. The token is shipped as the private dataset `yacine105/peekaplate-hf-token`, resolved by `secret_source()` in the notebook baseline. The healthy log prints `HF token source: dataset:peekaplate-hf-token/hf_token.txt` and `DINOv3 preflight: ok=True`; `missing_hf_token` means the dataset is broken, which is a blocker, not a retry.
Confirmed working on 2026-11-23: hero-batch-b/6 completed TRELLIS stages 1-6 for several dishes ([trellis-run-profile](trellis-run-profile.md)).
