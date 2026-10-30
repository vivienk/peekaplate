# PeekaPlate P0 v2 — Review Log

**Last updated:** October 30, 2026  

**Status:** 75 local Python tests passed; full and starter standalone validators passed on October 30, 2026. Saved evidence files still require refreshing. Awaiting independent re-review and product decisions. Not production-approved.  

**Dataset version:** `p0-v2-synthetic-1.0`

## 1. Scope and data provenance

This package contains fictional test data and an internal metric oracle, not real diner observations or production evidence.

| Dataset | Sessions | Delivery lines | Unique observations | Duplicate deliveries |

|---|---:|---:|---:|---:|

| Starter story (`events/two_session_story.jsonl`) | 2 | 21 | 20 | 1 |

| Full repeated fixture (`events/full_dataset.jsonl`) | 300 | 3,150 | 3,000 | 150 |

The full fixture repeats the same two-session story 150 times. Its sessions are **not independent real customers**, and the fixture cannot establish customer trends. The synthetic observation window is October 20, 2026, 10:00:00–11:00:07 (UTC+05:00), inclusive. The starter story's retry is an identical redelivery of a successful Undo restoration.

## 2. Local verification — latest October 30, 2026, and historical evidence

**Historical environment:** Python 3.12.10; `jsonschema` 4.26.0.

**Commands:**

```powershell

python generate_full_dataset.py

python -m unittest discover -s tests -p "test_*.py" -v

python validate_full_dataset.py

```

**Historical October 25 baseline (preserved for audit):**

- Historical baseline automated tests: **55 passed** (`Ran 55 tests`, `OK` reported).

- Full dataset validator: **PASS** for all implemented checks, including `schema.json` enforcement, timezone-aware timestamps, sequence uniqueness, identical retry deliveries, valid opening/checkpoint/comparison links, Save/Unsave/Undo transitions, shortlist sizes, and expected metrics.

- Generated dataset: 3,150 delivery lines, 3,000 unique observations, 300 sessions.

**Historical validator detail:** 300 detail openings, 450 checkpoints, 150 displayed comparison flows (300 displayed pair events reported in later revision), 450 direct Saves, 150 Undo restorations, 450 successful Unsaves, 1,050 shortlist-size validations; 150 openings at 10 seconds and 150 at 5 seconds; average active time 7.5 seconds. Exposure sessions: A=300, B=300, C=150. Opening sessions: A=150, B=150, C=0. Linked opening rates: A=50%, B=50%, C=0%. Save adoption: 300/300 sessions.

`test_results.txt` and `validation_results.txt` are intended evidence artifacts; **their contents must be refreshed from the latest run before handoff**. Historical 55- and 62-test results are not current submission evidence; refresh these files using the latest verified commands before handoff.

**Latest local verification — October 30, 2026:** Running `python -m unittest discover -s test-data/owner-synthetic-p0-v2/tests -v` from the repository root returned **Ran 75 tests in 31.913s — OK**, including **22 real-validator integration tests**. The tests cover comparison events without `opening_id` and agreement between engagement helpers for a 10-second nonfinal checkpoint. Both standalone validators were subsequently rerun successfully using `--dataset full` (default) and `--dataset starter`. Saved evidence files still require refreshing.

These are local synthetic-fixture checks, not production integration or privacy certification.

## 3. Validator regression coverage

`tests/test_validator_integration.py` currently includes 22 real-validator integration tests, including a passing baseline and rejection of invalid inputs. Coverage includes acceptance of comparison rows with omitted `opening_id` (optional comparison metadata) and rejection of Replace-before-Start; checkpoint rows still require a valid linked `opening_id`. Covered defects include invalid schema version, malformed or timezone-less timestamps, unknown event type, empty event ID, zero local sequence, duplicate sequence, incorrect checkpoint-to-dish link, invalid Undo restoration, Undo without matching Unsave, and missing expected retry delivery.

### October 26, 2026 — Independent Re-review Corrections

- Updated the unfinished-session retention example and its JSON-backed tests.

- Added event-type-specific schema requirements and checkpoint timestamp checks.

- Confirmed that both starter and full datasets pass the real validator.

- Updated AI permitted-input descriptions and explicitly suppressed the Save-rate metric.

- Documented the AI model/evaluator input boundary.

- Created `negative_case_test_mapping.json`: 10 cases have partial local coverage; 15 remain unconfirmed.

- Recorded inclusive observation-window endpoints.

- Marked preparation-guide and taxonomy revisions as pending source-owner confirmation.

- Full local test suite: 62 tests passed.

- Full dataset validation: PASSED.

- Starter dataset validation: PASSED.

- Application AI evaluation: NOT RUN.

- Production API mapping, hosted privacy checks, and application behavior remain unverified.

The validator checks the declared dataset counts without depending on the original filename and validates delivery rows against `schema.json`. Invalid cases are expected to fail with a useful reason. These checks do not establish production event/API contract compliance.

`negative_cases.json` documents 25 scenarios. The negative-case catalog is **not** equivalent to 25 executed production tests. Automated helper tests, validator integration tests, and application-level negative tests must be tracked separately; the remaining application scenarios are not claimed as run.

## 4. Internal metric oracle and engagement

For the **two-session starter story**, internal expectations include A/B card exposure in 2 sessions each, C exposure in 1; one detail opening each for A and B; zero for C; 50% linked detail-open rate for A and B; one displayed comparison flow (two displayed pair events reported in the later revision; verify against refreshed fixture); three direct Saves; one Undo restoration; three successful Unsaves; and an average completed active opening time of 7.5 seconds.

Six event-derived examples in `metric_examples.json`, checked by `tests/test_metric_examples.py`, cover active-only qualification, a linked displayed comparison, a short opening, Save-only activity, the exact 10-second boundary, and a comparison without a linked opening. Timing derives from event rows and cumulative active-time checkpoints, which must not be summed.

**Unresolved:** Whether a displayed A/B comparison qualifies both dishes or only the dish linked to its opening. The current provisional Dish B considered-engagement result (0/150 opening sessions) is **not an approved metric**. Metric units, eligible cohorts, denominator rules, and comparison attribution still require owner confirmation.

## 5. Story-end Saved state versus observed Save retention

The starter story ends with Dish A saved in Session X and no dishes saved in Session Y. These are **story-end Saved-state assertions**, not evidence of checkout, purchase, or order completion.

The current standalone helper `observed_save_retention(sessions, dish_id)` is **descriptive observed-visit Save retention**, not finalized completed-session retention:

- **Denominator:** Observed sessions/visits that directly saved the specified dish (`directly_saved_dishes`).
- **Numerator:** Those directly saving sessions/visits where the dish remains in `saved_dishes` at the observed end.
- **Zero denominator:** Returns `None` (`null` in JSON).

The helper does not require a checkout or order-completion event. Inactivity-based visit splitting is tested separately, including 29-minute and 30-minute gaps; the product policy for session/visit completion remains pending approval. The main fixture does not establish actual completed orders or production retention. The existing file `tests/test_session_completion.py` contains these **observed-visit** examples despite its historical filename; a clearer filename can be considered after references are checked.

## 6. Privacy, tenant isolation, and AI evaluation

The proposed reporting threshold is 10 eligible sessions. The two-session starter fixture is below this threshold; owner-facing behavioral metrics must be suppressed. A suppressed AI-facing metric must have `status: SUPPRESSED` and `value: null`, without hidden counts, denominators, event histories, session IDs, or diner Saved lists. Complementary suppression and production tenant isolation still require application-level validation.

`ai_evaluation_cases.json` contains **20 specified cases** with questions, permitted inputs, expected behavior/facts, forbidden claims, and links to fictional report inputs in `ai_report_inputs/`. Local tests check all 20 fixture references, readable JSON, suppression of metric values, prohibited private-field names, and unexecuted statuses. Test oracles are separate from AI-facing reports.

**Execution against actual PeekaPlate AI:** `NOT_RUN_AGAINST_APPLICATION_AI` for all 20 cases.  

**Application-AI response scores:** NOT AVAILABLE.  

The local checks are structural and do not prove the assistant's grounding or privacy behavior.

Orders, revenue, waste, and customer motivation must not be inferred from Save or opening events without separate evidence.

## 7. Event/API contract gap

The fixture uses proposed event types: `menu_viewed`, `dish_viewed`, `dish_detail_opened`, `dish_activity_checkpoint`, `dish_compared`, `dish_saved`, and `dish_unsaved`. These are **not approved production API events**. Earlier repository inspection found `DishIntentEventSchema` with `dish_open` and `portion_compare` and different required fields. Engineering owners must approve mapping before any production integration; do not submit this fictional data to a hosted database or production endpoint.

## 8. Sai's independent review and follow-up

**Initial independent review:** October 24, 2026. Sai confirmed the earlier baseline dataset and identified issues in validator enforcement, event-derived engagement, retention definitions, AI input fixtures, and documentation. At that historical stage, the revised package incorporated local fixes and had 55 passing tests plus a passing full validator run; this is **not** the current test count.

**Current review state:** Revised package awaiting Sai's independent **re-review**. The initial review is not final approval. No production release approval is claimed.

**Outstanding items:**

- Confirm comparison attribution and engagement metric definitions with metric/product owners.

- Confirm observed-visit inactivity boundary and any distinct order/session-completion policy; do not conflate the two.

- Approve event taxonomy and production ingestion/API mapping.

- Validate privacy suppression, complementary suppression, and tenant isolation in the actual application.

- Execute the 20 AI cases against authorized application outputs and record raw responses, scores, and failures.

- Reconcile the negative-case catalog with exactly which scenarios have been locally tested versus not run.

- Obtain product-owner decisions and Sai's re-review of this revision.

**Related ClickUp ticket:** https://app.clickup.com/t/90141746115/86bcng0d7

## 9. Handoff checklist

- [x] Prepare starter and full fictional datasets.

- [x] Validate generated full dataset locally.

- [x] Run 75 automated Python tests successfully (October 30, 2026).

- [x] Add validator regression tests and event-derived engagement examples.

- [x] Separate story-end Saved state from observed-visit Save retention; no order completion claimed.

- [x] Prepare privacy-filtered inputs for 20 AI evaluation specifications.

- [x] Rerun standalone full and starter validators after October 30 edits — both passed.
- [ ] Refresh `test_results.txt`, `validation_results.txt`, and `starter_validation_results.txt` with the latest verified outputs.

- [ ] Verify `manifest.json`, negative-case metadata, and documentation agree on executed versus unexecuted scenarios.
- [ ] Verify Adam's fixture checklist: same-session earlier opening; per-visit `session_id`/`producer_id`; placeholder and Portion controls; storage-blocked Save/Unsave/Undo; no attribution of later Saves to comparisons.

- [ ] Package the revised files and send to Sai for re-review.

- [ ] Resolve pending metric, privacy, completion, and event/API decisions.

- [ ] Execute application-level AI and production integration checks when available.

- [ ] Obtain independent re-review and required approvals.

**Handoff status:** Locally validated synthetic package; **not** a production certification, AI evaluation pass, privacy compliance certification, or release approval.

## 10. October 29–30 change record (current revision)

- **October 29:** Prior post-merge local Python run reported 73/73 passing tests. Historical result only.
- **October 30:** Made `opening_id` optional in `schema.json` for `dish_compared` events; retained required opening links for checkpoints. Added real-validator regression for comparisons with no `opening_id`.
- **October 30:** Updated `engagement_status()` to accept nonfinal activity checkpoints and added a 10-second regression checking agreement with `considered_dishes()`.
- **October 30:** Full Python suite **75/75 PASS** (31.913 seconds), including 22 validator integration tests. No fresh standalone full/starter validator output has yet been supplied after these edits.
- **Pending:** Confirm product interpretation with Adam, Shirley, and Zhiliang; complete fixture checklist, regenerate evidence, obtain Sai's independent re-review, and update PR #52. Application AI evaluation remains **NOT RUN**; hosted privacy and production mapping remain **unverified**.
