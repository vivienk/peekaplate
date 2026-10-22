# OCR and T0 delivery slices

Current scope: [S3-VIS-02: OCR extraction/evaluation](https://app.clickup.com/t/86bcnfw5g)
and Mohammad's image-extraction contribution to
[S3-VIS-03: approved T0 assets and optional 2.5D](https://app.clickup.com/t/86bcnfw7r).
Mohammad owns OCR; Marwan owns asset delivery. Sources:
[Visual PRD controlling revision](https://app.clickup.com/90141746115/docs/2kydvry3-94/2kydvry3-1434)
and [Sprint 3 task index](https://app.clickup.com/90141746115/docs/2kydvry3-2574/2kydvry3-1394).

The October 20 Visual PRD revision sets November 10 feature freeze and November 15
delivery, 2026. October 20–27 is an initial interval. The assigned tickets carry
October 22 checkpoints; distinguish those from final acceptance and confirm
estimates/reviewer time with the PM.

| Work | Timing and owner | Handoff |
| --- | --- | --- |
| OCR extraction/evaluation | Start now; Mohammad | Reuse Python ingestion, preserve source regions, evaluate reviewed PDF/photo cases, export outputs and errors. |
| Ground truth/criteria | Parallel dependency; Uneeza/Zhiliang | Permitted sources, reviewed alignment, held-out cases and approved thresholds. |
| Three coherent T0 captures | Start now with Marwan | Actual photos, rights, source/dish revision hashes, explicit missing states; target five after review. |
| Review/publication integration | After contracts; Teeyansh/Nifemi/Abubakar | Ingestion → human correction/review → authorized publication. Local exports do not publish. |
| Optional 2.5D | Later, after approved T0/device budget; Marwan/Harshita | One real dish, measured mobile behavior, approved photo fallback. Failure must not delay T0. |
| Full 3D/AR | Deferred | Outside these tasks and the November critical path. |

## Repository and PR order

Use [vivienk/peekaplate](https://github.com/vivienk/peekaplate), branch from current
`develop`, and target `develop`. `peekaplate_staging` contains historical work.
Follow [CONTRIBUTING](../CONTRIBUTING.md); release PRs to `main`, deployment and
human acceptance are separate actions.

1. Port bounded Python ingestion from preserved source commit `28b91d0`, retaining
   credit, frozen dependencies and tests. Add overlay evidence and offline
   field evaluation. This processing PR does not integrate APIs or a database.
2. Add the image-preparation/review-bundle contribution with source hashes, exact
   dish references, create-only outputs and explicit missing states. Build on
   the processing PR. Marwan owns delivery integration; Harshita owns the diner
   consumer. No self-approval or generation pipeline.
3. Configure the OCR.space key privately and run representative inputs. Retain
   source bytes, settings, output hashes and environment. Fix errors and repeat
   evaluation; hand results to Uneeza, obtain Zhiliang's criteria and Sai's
   independent validation before acceptance.

The existing [OCR PR](https://github.com/vivienk/peekaplate_staging/pull/16) is
draft/unmerged and already covers text/PDF/photo/static website ingestion with
OCR.space Engine 3. Mocked tests and observed live text extraction do not establish
menu field accuracy. Port that work for review; do not merge its divergent old
application branch wholesale.

## Dependencies and scope

The full path is acquisition → evidence-linked candidates → human correction →
exact approval → publication → diner. These tasks contribute OCR/evaluation and
captured images. Backend tenant authority, revision commands, approval and
publication stay with their existing tickets and ADRs.

S3-ARC-01 and S3-VIS-01 must agree the TypeScript/Python handoff; the inherited
Python draft is not the staff command payload. Approved representative sources
and capture rights precede real evaluation/delivery. A menu photo supports text,
not ingredient inference or verification of the actual plated dish.

The [pipeline v3 specification](https://app.clickup.com/90141746115/docs/2kydvry3-94/2kydvry3-1034)
retains open incomplete-data and approval-authority decisions. OCR confidence
cannot resolve them. Frontend review, publication, orchestration, analytics and
spatial rendering remain outside these PRs.

## Verification boundary

Standard-library evaluator/region tests run without providers. Full processing
tests need frozen uv dependencies; application checks need Node/pnpm, with
browser/DB checks selected by CI. Record exact results per PR. The repository
contains no approved real sample set or credential. Passing fixtures does not
complete these tasks, authorize publication, establish production behavior or
provide PM/human acceptance.
