# Production HTTPS Enforcement & Security Headers

**Branch:** `fix/production-https-security-headers`  
**Base:** `origin/develop` (`11aaf3d4`)  
**Reference Audit:** `docs/production-hardening-audit-2026-11-27.md`

---

## 1. Root Cause

Live production checks on 2026-11-27 confirmed two transport and framing gaps:

1. **API Plain-HTTP Responses (`api.peekaplate.app`):**
   - `http://api.peekaplate.app/health` returned `HTTP/1.1 200 OK` directly over plain HTTP without redirecting to HTTPS, and `http://api.peekaplate.app/staff/venues` returned `HTTP/1.1 401 Unauthorized` over plain HTTP.
   - Neither `http://` nor `https://api.peekaplate.app/health` returned `Strict-Transport-Security`.
   - Cloudflare Worker configuration in `backend/wrangler.production.jsonc` does not manage Cloudflare Zone SSL/TLS "Always Use HTTPS" or Zone Redirect Rules, and the Hono application in `backend/src/index.ts` had no HTTPS enforcement or HSTS middleware.

2. **Owner Console Framing & HSTS Gaps (`peekaplate.app`):**
   - `https://peekaplate.app/owner-auth`, `/auth-confirm`, `/auth-reset`, and `/owner-dashboard` returned `HTTP/2 200` with neither `X-Frame-Options` nor `Content-Security-Policy` (`frame-ancestors`), nor `Strict-Transport-Security`.
   - `frontend/console/vite.config.ts` emitted `_redirects` for production Cloudflare Pages builds but did not emit a `_headers` file.

---

## 2. Architecture and Enforcement Layer

### 2.1 API (`api.peekaplate.app` — Cloudflare Worker)

- **Edge Layer (Primary — Cloudflare Dashboard, outside repo):** Cloudflare Zone SSL/TLS ("Always Use HTTPS" or a Zone Redirect Rule for `http://api.peekaplate.app/*` → `308`) is the primary edge enforcement point so unencrypted requests are redirected before reaching the Worker.
- **Application Layer (Defense-in-Depth — `backend/src/index.ts`):**
  - Added `isHttpsRequest()` and a top-level `app.use('*', ...)` middleware in `createApp()` before CORS, authentication, and route handlers.
  - When `APP_ENV === 'production'` and the request is not HTTPS (checking `X-Forwarded-Proto` first to prevent redirect loops behind TLS-terminating proxies, then `URL.protocol`, while allowing `localhost`/`127.0.0.1` for local test harnesses), the Worker immediately returns `308 Permanent Redirect` to the equivalent `https://` URL preserving path, query string, HTTP method, and request body, without processing credentials or running route handlers.
  - On HTTPS responses in `APP_ENV === 'production'`, sets `Strict-Transport-Security: max-age=2592000` (30 days; no `includeSubDomains`, no `preload`).
  - Sets `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` via Hono `c.header(...)` without duplicating headers.

### 2.2 Owner Console (`peekaplate.app` — Cloudflare Pages)

- `frontend/console/vite.config.ts` (`ownerRoutes(production)`) now emits `dist/_headers` alongside `dist/_redirects` when `production` is `true` (`VITE_PUBLIC_API_URL === 'https://api.peekaplate.app'`).
- Preview builds (`PEEKAPLATE_PREVIEW_DEMOS=true` or non-production API URLs) continue to omit `_headers` so `scripts/preview.mjs` `sanitize()` remains unaffected.

---

## 3. Files Changed

- `backend/src/index.ts` — Production HTTP → HTTPS `308` redirect middleware, `Strict-Transport-Security`, and `X-Content-Type-Options: nosniff`.
- `backend/src/index.test.ts` — Unit tests for `308` redirect, path/query/method preservation, no-auth-over-HTTP, HSTS, `X-Forwarded-Proto` loop prevention, local/staging exemption, and CORS compatibility.
- `frontend/console/vite.config.ts` — Emit Cloudflare Pages `_headers` in production builds.
- `frontend/console/src/owner/security-headers.test.ts` — Build test verifying `_headers` and `_redirects` in production vs non-production builds.
- `docs/production-https-security-headers.md` — This remediation document.

---

## 4. Security Headers Introduced

| Surface | Header | Value | Notes |
|---|---|---|---|
| API (`api.peekaplate.app`, HTTPS in `production`) | `Strict-Transport-Security` | `max-age=2592000` | 30-day initial max-age; no `includeSubDomains` or `preload` until all subdomains are verified HTTPS-only |
| API (`api.peekaplate.app`, all responses) | `X-Content-Type-Options` | `nosniff` | Prevents MIME sniffing; set without duplication |
| Console (`peekaplate.app`, all routes via `_headers`) | `X-Frame-Options` | `DENY` | Legacy clickjacking protection |
| Console (`peekaplate.app`, all routes via `_headers`) | `Content-Security-Policy` | `frame-ancestors 'none'` | Modern framing protection without restricting scripts/styles/API/auth |
| Console (`peekaplate.app`, all routes via `_headers`) | `Strict-Transport-Security` | `max-age=2592000` | 30-day initial max-age; no `includeSubDomains` or `preload` |

---

## 5. Cloudflare Configuration Requirements (Operator Action Required)

Application-level redirects in the Worker do **not** replace Cloudflare edge-level HTTPS enforcement. An authorized operator must verify/apply in the Cloudflare Dashboard (not modified by this PR):

1. **Zone SSL/TLS → Edge Certificates:** Ensure **Always Use HTTPS** is enabled for `peekaplate.app` (or add a **Single Redirect Rule** matching `http.host eq "api.peekaplate.app" and not ssl` → Dynamic `concat("https://api.peekaplate.app", http.request.uri.path)` with status `308` and **Preserve query string** enabled).
2. **Minimum TLS Version:** Confirm `TLS 1.2` or higher is enforced on the `peekaplate.app` zone.
3. **Cloudflare Pages (`peekaplate-console`):** Confirm no conflicting Transform Rules override `_headers` on `peekaplate.app`.

---

## 6. Test Results

- `vitest run backend/src/index.test.ts frontend/console/src/owner/security-headers.test.ts`: **103 passed** (102 in `backend/src/index.test.ts`, 1 in `frontend/console/src/owner/security-headers.test.ts`).
- `pnpm typecheck`: Passed across all workspace packages.
- `pnpm --filter @peekaplate/console build`: Passed.
- `pnpm lint` (`biome check .`): Passed (see `pnpm check` run below).

---

## 7. Production Validation Procedure

After merging to `develop`/`main`, deploying the Worker and Console, and applying the Cloudflare edge rule:

```bash
# 1. API HTTP -> HTTPS 308 redirect (must NOT return 200 or 401)
curl -sS -D - -o /dev/null "http://api.peekaplate.app/health?probe=1"
curl -sS -D - -o /dev/null "http://api.peekaplate.app/staff/venues"

# 2. API HTTPS 200 + HSTS + nosniff
curl -sS -D - -o /dev/null "https://api.peekaplate.app/health"

# 3. Owner Console framing + HSTS headers
for path in /owner-auth /auth-confirm /auth-reset /owner-dashboard; do
  echo "=== $path ==="
  curl -sS -D - -o /dev/null "https://peekaplate.app${path}"
done
```

Expected:
- Both `http://api.peekaplate.app/...` requests return `308` with `Location: https://api.peekaplate.app/...` and **no** `Strict-Transport-Security`.
- `https://api.peekaplate.app/health` returns `200` with `strict-transport-security: max-age=2592000` and `x-content-type-options: nosniff`.
- All four `https://peekaplate.app/...` routes return `200` with `x-frame-options: DENY`, `content-security-policy: frame-ancestors 'none'`, and `strict-transport-security: max-age=2592000`.

---

## 8. Rollback Instructions

- **Code Rollback:** Revert this PR commit on `develop` and redeploy the Cloudflare Worker (`backend`) and Cloudflare Pages (`frontend/console`).
- **Edge Rollback:** Disable the `api.peekaplate.app` Redirect Rule in the Cloudflare Dashboard if needed.

---

## 9. Remaining Risks

- **Cloudflare Edge Rule Pending:** Until the Cloudflare Dashboard edge redirect is enabled and this PR is deployed, `http://api.peekaplate.app/*` continues to reach the origin over plain HTTP.
- **HSTS Scope:** `includeSubDomains` and `preload` are intentionally omitted until all `*.peekaplate.app` hostnames (including `diner.peekaplate.app` and `extraction.peekaplate.app`) are verified HTTPS-only.
- **Integration / Live DB Tests:** Live Postgres/Playwright e2e tests were not executed in this PR; production validation remains pending post-deploy.
