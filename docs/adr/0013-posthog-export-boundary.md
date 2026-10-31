# 0013 — Private PostHog export copy

Status: Accepted · 2026-10-19 · Owner: platform

## Context

The requested integration copies optional PostHog observations into the existing Supabase database. It does not replace the durable evidence pipeline in ADR 0003 or change restaurant authorization in ADR 0005.

## Decision

Use PostHog's scheduled **Events** batch export into `analytics_private.posthog_events`. Precreate its documented columns through a forward migration. A dedicated export login inherits only schema `USAGE` and landing-table `SELECT, INSERT`; it is separate from the application and migration accounts.

The landing schema must remain outside Supabase's exposed API schemas. This table uses schema/table permissions rather than RLS because PostgreSQL `COPY FROM` does not support RLS for the restricted writer. This narrow exception does not change RLS on any application table, grant `BYPASSRLS`, or permit owner access to raw data.

The exporter may repeat rows. Preserve raw copies without a unique constraint. `posthog_events_deduplicated` collapses identical copies by their complete stored values and excludes missing identities and conflicting copies sharing `(team_id, uuid)`. Inspect conflicts before using counts. `team_id` identifies the PostHog project, never a restaurant. No frontend or application runtime grants are added.

Use verified TLS and the staging project with an `environment=staging` filter. Start hourly and restrict the event names to implemented capture contracts. A scheduled export is delayed, optional analytics; it is not a durable application receipt. No persons, sessions, replay export or additional application runtime is needed.

## Consequences

Supabase holds an internal analytics copy alongside application data, with separate permissions. Export loss, consent refusal, quota limits and client spoofing remain possible. These rows cannot establish venue authority, actual orders, complete diner counts or causal results. Owner-facing metrics still require the accepted evidence and authorization contracts.

Copies add storage and deletion responsibilities. Deleting a PostHog record does not automatically delete an earlier Supabase export. Pause export/backfill during deletion and reconcile both systems under an approved policy before real diner collection.

## Verification

`tests/db/posthog.sql` tests restricted COPY, duplicate collapse, conflict exclusion and denied access. Hosted acceptance additionally requires a successful export, matching synthetic IDs in Supabase and a repeated interval without inflated deduplicated counts. A local migration passing does not establish hosted activation.

References: [PostHog destination](https://posthog.com/docs/cdp/batch-exports/postgres), [inspected exporter revision](https://github.com/PostHog/posthog/blob/05051783bce6ed97982a0bd1174ef4081d126975/products/batch_exports/backend/temporal/destinations/postgres_batch_export.py), [PostgreSQL COPY](https://www.postgresql.org/docs/current/sql-copy.html).
