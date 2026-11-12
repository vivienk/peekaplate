# Security

Do not report customer data, credentials or exploitable details in a public issue. Use GitHub private vulnerability reporting when enabled, or contact a repository owner privately. Do not claim a reporting channel exists until verified in repository settings.

The Worker exposes staff-authorized dish/review/publication commands, signed public menus and canonical observation ingestion. Commands verify signed staff identity, current restaurant membership and restricted database access with transaction-local context and row-level security. Dated hosted synthetic acceptance covers bounded staff/publication/observation behavior, isolation and recovery; it does not certify the complete product or production. Production remains unconfigured.

The owner menu workspace keeps uploaded originals/photos private, verifies source ownership and bytes, fences cancellation and preserves unknown/proposed food fields until reviewed. Manual content uses explicit origin and versioned commands, never fabricated OCR evidence. Its new migration and deployment require their own acceptance record; older hosted results cannot establish those additions. See [the workspace handoff](docs/owner-menu-workspace.md).

Revocation boundaries differ: removing restaurant membership blocks subsequent commands and retries immediately. Supabase sign-out invalidates the session's refresh token, but an already-issued access JWT can remain valid until expiry. The hosted check observed this remaining lifetime at about one hour. The Worker validates the JWT and current membership; it does not query `auth.sessions` on each request. Do not promise immediate session-level revocation. Before production staff access, explicitly accept an appropriate token lifetime or implement and test a session-status check for sensitive actions. See [Supabase session guidance](https://supabase.com/docs/guides/auth/sessions#how-to-ensure-an-access-token-jwt-cannot-be-used-after-a-user-signs-out).

Security-sensitive changes need a reviewer independent of the author, a threat/failure description and negative tests with restricted roles. Check tenant separation, actor authorization, schema validation, replay effects, secret handling and CI trust boundaries. Never run untrusted PR code with deployment secrets or `pull_request_target` privileges.

Secrets belong in vendor/GitHub environment stores; `.env` and `.dev.vars` are ignored. All browser environment values are public. No raw POS exports or session records in this public repository. Retention/deletion must include archives and restore paths.
