# PeekaPlate P0 v2 Owner Synthetic Dataset Guide

## Purpose

This folder contains fictional synthetic event data, expected metrics, negative cases, and validation tests for the PeekaPlate P0 evaluation work.

The data is synthetic and is not production or real diner evidence.

## Setup

From this dataset folder, install the required dependency:

    python -m pip install -r requirements.txt

## Run automated tests

    python -B -m unittest discover -s tests -v

Latest local verification: 76 tests passed, including 22 validator integration tests. Independent re-review pending.

## Validate the full dataset

    python -B validate_full_dataset.py

## Validate the starter dataset

    python -B validate_full_dataset.py events/two_session_story.jsonl --dataset starter

Both validators passed on October 27, 2026.

## Review evidence

- README.md: Dataset overview and scope
- manifest.json: Dataset metadata and expected counts
- test_results.txt: Automated test results
- validation_results.txt: Full dataset validation results
- starter_validation_results.txt: Starter dataset validation results
- review_log.md: Review history and pending decisions
- failure_ledger.csv: Recorded evaluation findings

## Limitations

- Application AI evaluation: NOT RUN
- Production API integration: NOT VERIFIED
- Hosted privacy checks: NOT VERIFIED
- Unresolved product decisions: PENDING

Keep expected answers and private evaluation data separate from AI-facing inputs.
