# ClickUp: S7-VIS-06 ownership and constraints (read 2026-11-24)

Source: a read-only ClickUp lookup by a Claude child on 2026-11-24, workspace 90141746115. Ticket: [S7-VIS-06](https://app.clickup.com/t/86bd5m6q0), "Complete and accurately label the photo-to-portion 3D flow". It is Open (high priority), starts Nov 24, is due Fri Nov 27, and is assigned to Vivien Kong, Mohammad (the user) and Marwan Ammar.

Ownership, per the Nov 21–27 staging-tickets doc as read on 2026-11-24:
- Mohammad (the user): processing and storage.
- Vivien: S09 console, publication and device checks (PM).
- Marwan: bundle producer, and proposed 3D engineering DRI.
- Harshita: diner 3D viewer (S7-FE15 [86bd5pmc7](https://app.clickup.com/t/86bd5pmc7)), with Rania on design.
- Zhiliang: publication API (S3-RES-02).
- Sai: independent technical and security review, and staging secrets.
- Jeffin: dish editor.
- Uneeza: final owner→diner check. Rehearsal Wed Nov 25, handoff Fri Nov 27.
- The physical-phone demonstration is targeted for Nov 25.

Constraints from the Sprint 5 PRD and the ticket that change the 2026-11-24 plan ([decision-2026-11-24-dec1-demo-direction](decision-2026-11-24-dec1-demo-direction.md)):
- No provider has been selected (Meshy vs Tripo). Vivien and the engineering DRI must decide, together with budget, retry and timeout caps, before any provider call.
- Model fields need a new **versioned model-asset contract**. They must not be added to Bundle v1 / PublicPortion v1. Publication must be atomic, with the fallback photo.
- Validate the GLB before review: decode, geometry, textures, bounds/orientation, resource references.
- Owner review needs photo and model side by side, all sides visible, and an approve/reject record of reviewer, time, source revision and model hash. A source or model change invalidates the approval.
- "A PNG or 2.5D demo does not pass" the 3D gate. A 2.5D-only outcome must be labelled as not generated 3D. Record the first failing stage.

On 2026-11-24, with the user's approval, five question comments were posted on S7-VIS-06 (86bd5m6q0), each @-mentioning one person.

| Person | User id | Topics |
|---|---|---|
| Vivien | 246160218 | provider, keys, budget, demo scope, Meshy account |
| Sai | 124264612 | production enableInternet=false, standard-1 memory vs 2 GB cap, secret placement, Dockerfile extra, migration, security review |
| Marwan | 216211271 | PortionModel v1 shape, mobile size, approval record, atomic publication, orientation |
| Harshita | 308495656 | viewer GLB support, fallback timeout, labels |
| Zhiliang | 124283991 | publication API |

Uneeza was not found as a ClickUp member. The user pings everyone on Discord.

Replies on 2026-11-24:
- Vivien: the Nov 27 / Dec 1 demos need the 2.5D portion preview end to end. The flow is onboarding photo → approve 2.5D → publish → diner View Portion. No 3D GLB is needed on the diner side.
- Zhiliang: S13 Publish already takes an approval ID and activates the approved publication. A separate PortionModel v1 can reuse that request alongside Bundle v1. The backend must verify the GLB hash and the source photo revision, and make the model and its fallback photo available together under the same publication and dish revision. Zhiliang will review the publication wiring once the user and Marwan agree where the descriptor lives and how the diner finds it.
- Sai: (1) 3D after Dec 1 goes in a separate 3D job service/Worker with Tripo-only egress, standard-1 (2 GB cap), separate Docker target, app_private RLS migration, PRs to develop; (2) for Nov 27 / Dec 1 2.5D QA, use peekaplate.app (notes 2.5D code is currently bugged), send Gmail for Cloudflare read access, and pointed to Supabase API status / collaborator read path (verified on develop to be staging-only /team/analytics). See [decision-2026-11-24-sai-3d-infra](decision-2026-11-24-sai-3d-infra.md).
- Marwan and Harshita had not replied when checked.
