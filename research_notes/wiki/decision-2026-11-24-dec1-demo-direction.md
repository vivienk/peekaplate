# Decision proposal, 2026-11-24: direction for the Dec 1 demo

Source: the teammate's brief, pasted by the user on 2026-11-24. Next PR: Screen 9 owner photo → backend prepares the reference image → Meshy/Tripo → owner previews the GLB → approves → publishes. Diner View Portion shows the approved GLB, or falls back to the 2.5D view from PR #162. They also want the same photo in both workflows, to compare plate rim and food shape.

Facts checked 2026-11-24:
- PR #162 (vivienk/peekaplate, "integrate 2.5D camera portions and owner plate calibration") was MERGED into develop on 2026-11-15.
- origin/develop head is 5b87c8a4.
- Present in the working tree: processing/src/peekaplate_processing/tripo.py, provider_budget.py, docs/tripo-cutout-to-3d.md, docs/screen9-portion-publish.md and backend/src/bundle-producer/approved-portions.ts.
- No Meshy adapter exists, and packages/contracts/src/portion.ts has no GLB/model field.

Recommendation (Claude, 2026-11-24, awaiting the user's choice):
- Neither an LLM-driven Blender runtime nor fine-tuning before Dec 1.
  - Fine-tuning a 3D generator needs paired data and multi-GPU days, and does not fit 7 days.
  - An LLM driving Blender adds nondeterminism to what should be fixed geometry steps.
- Do the brief's PR: a provider-agnostic GLB slot (Tripo live first, Meshy second) through contract → backend job → console S09 preview/approve → publication → diner View Portion with the 2.5D fallback.
- Mesh cleanup is deterministic code in processing, using trimesh (no Blender, no LLM):
  - drop the ground slab and stray shells
  - scale to the plate calibration in cm
  - decimate to ~35k faces with a 1024 px texture
- TRELLIS enters as precomputed GLBs for the comparison dish, because there is no always-on GPU. Colab and Kaggle are batch-only.
Related: [colab-trellis-hires-run-2026-11-24-resume](colab-trellis-hires-run-2026-11-24-resume.md), [trellis-run-profile](trellis-run-profile.md), [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md).

Amended later on 2026-11-24, after reading ClickUp ([clickup-s7-vis-06-ownership-2026-11-24](clickup-s7-vis-06-ownership-2026-11-24.md)):
- The user owns processing and storage on S7-VIS-06, not all six layers.
- The provider choice and the versioned model-asset contract must be agreed with Vivien and Marwan first.
- The `model` field must NOT go into PublicPortion v1.
