# 0014 — Individual team access to staging analytics

Status: Accepted · 2026-10-21 · Owner: platform

## Context

Contributors need to inspect the PostHog copy in Supabase without sharing integration or database credentials. The maintainer explicitly requested a common Cloudflare API with individual permissions. ADR 0013 forbids direct application-runtime analytics access and owner use of these raw observations.

## Decision

Keep the existing Supabase staff Auth verifier unchanged and reuse the restricted Hyperdrive binding. Add staging/local-only GET endpoints for safe event fields and technical event counts. Authenticate internal API callers with individual GitHub user tokens; verify identity through GitHub /user and current collaboration on the fixed vivienk/peekaplate repository on every request. Use a separate server-only, repository-scoped Metadata-read checker token. No manual person allowlist or Supabase account is required. The configured server project and staging filter are authoritative; A public viewer or PostHog member alone has no access.

Narrowly extend ADR 0013: the application runtime may execute a fixed security-definer function in a separate private schema, but gets no analytics-schema usage, raw table/view SELECT or access to the project-scope table. The function's non-login owner can read only the required staging project scope/view, has no restaurant access, cannot create objects and uses a fixed search path. It filters the authorized project/environment, caps date windows/results and constructs an allowlisted response. Keep Hyperdrive query caching disabled. Collaborator/scope changes apply to subsequent requests, not an already-running snapshot.

The API returns no visitor identity, IP, person data, free text or arbitrary properties. It is internal diagnostic access over staging observations, not restaurant-authorized owner reporting. No provider administration proxy, arbitrary query endpoint, shared privileged API key, new service or separate database is introduced. Existing domain commands and the accepted durable diner-evidence pipeline remain unchanged. Routine CI uses synthetic local fixtures; deployment credentials belong in protected GitHub environment secrets and provider bindings.

## Consequences

Every accepted repository collaborator is eligible after deployment and checker-secret configuration. GitHub errors, expiry and rate limits fail closed; removing collaboration blocks subsequent checks. PostHog project membership remains useful for inspecting capture before hourly export. Current API data is delayed and incomplete optional analytics; diagnostic event counts do not establish visits, orders or business metrics. Owner API authorization and metric thresholds remain separate decisions/work.

## Verification

HTTP tests reject unauthenticated sessions, client-selected authority, duplicate parameters, broad ranges and production routes. PostgreSQL and real local Worker tests cover staging project isolation, duplicates, field redaction, bounded results, denied direct access and revocation. Hosted activation requires migration/deployment and synthetic positive/negative tests; local results alone do not prove it. See [team data access](../team-data-access.md).
