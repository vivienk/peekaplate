# Hi3DGen skip: root cause and fix, 2026-11-23

On 2026-11-23 a Claude subagent found the real cause. It was **neither** a missing GPU nor a missing cu128 wheel; that misdiagnosis is superseded. pccm's `project_is_editable()` mistakes a wheel install for a source checkout because the Kaggle image has `dist-packages/.gitignore`, so cumm/spconv attempt a JIT rebuild and fail on a header the wheel doesn't ship.
Fix (uncommitted, `processing/scripts/build_multi_model_notebooks.py`): `CUMM_DISABLE_JIT=1`, `SPCONV_DISABLE_JIT=1`, plus a bounded child-process sparse-conv smoke test that still falls back to one skip per shard. It was confirmed on a private CPU probe kernel `yacine105/peekaplate-spconv-probe`. GPU inference past spconv is unproven as of 2026-11-23. Ledger entry: errors.md ERR-20261123-004 (correction of -002).
The staged fast-41 notebook was regenerated with this fix (sha256 b3baa8a0e6ae…), and the canonical bench-a/bench-b notebooks were regenerated too. This supersedes the Hi3DGen line in [sweep-preflight-2026-11-23](sweep-preflight-2026-11-23.md).
Estimated extra runtime: +1–2.5 h for 41 dishes (estimate).
