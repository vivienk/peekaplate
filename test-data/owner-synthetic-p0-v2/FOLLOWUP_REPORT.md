# P0 v2 Follow-up Fixture Report — November 3, 2026

## Scope
Add regression coverage for the product clarifications relayed by Adam and Zhiliang.

## Locally verified
- Comparison ordering: Soup opened before a displayed Soup/Salad comparison qualifies; Salad opened only afterward does not retroactively qualify under the current metric helper.
- Privacy boundary: 9 eligible sessions are SUPPRESSED, while 10 and 11 are ELIGIBLE, evaluated independently per publication revision.
- Soup and Salad: both previously opened dishes count once when included in a qualifying displayed comparison, even when Salad has only 5 seconds of active time.
- Late arrival: an event received after a newer visit remains in its original visit when grouped by occurrence timestamp.
- Publication revisions: each revision is evaluated separately against the 10 eligible-session privacy threshold.
- Existing tests cover 29-minute and 30-minute inactivity boundaries.

## Test results
- Python unittest discovery: 81 tests passed, 0 failures (November 4, 2026).
- Application staging execution: NOT RUN.
- Independent validation by Sai: PENDING.

## Limitations
- Revision privacy test uses synthetic eligible-session counts; it does not verify authorization or complementary suppression.
- Late-arrival test verifies the local visit-splitting helper, not production ingestion.
- Application AI evaluation and production integration remain NOT RUN.

## Pending decisions
- Louis: DATA-02 metric definitions, including unequal active-time and final-watermark handling.
- Nifemi: new/duplicate tab behavior.
- Adam and Shirley: remaining product confirmations.
- Sai: independent review.

## Related work
- Original P0 v2 dataset: PR #52 (merged).
- QA-02.2 staging cases: PR #101 (separate review).
