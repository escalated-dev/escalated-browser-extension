# Staff API contract and conformance suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write the staff API v1 contract down once (prose + OpenAPI) and ship a black-box conformance suite any backend's CI can run against a live install.

**Architecture:** Everything lives in `escalated-dev/escalated-developer-context` (public, local clone `C:\Users\work\escalated-developer-context`). Laravel's `support/api/v1` at v1.9.20 is the reference for paths and shapes; the contract adds the new extension endpoints (`/meta`, `/auth/exchange`, `/auth/revoke`, `updated_since`, `last_customer_reply_at`). The suite only talks HTTP.

**Tech Stack:** Markdown, OpenAPI 3.1 YAML, Node 22+/TypeScript, Vitest, `@redocly/cli` for linting.

**Spec:** `docs/superpowers/specs/2026-11-26-escalated-browser-extension-design.md` (this repo). Plan 2 (Laravel) and plan 3 (extension) depend on this plan's OpenAPI file.

## Global Constraints

- Paths, request fields and response shapes match Laravel's `routes/api.php`, `src/Http/Controllers/Api/*` and `src/Http/Resources/*` at escalated-laravel v1.9.20, except where this plan adds or corrects something.
- Pagination: `{data: [...], meta: {current_page, last_page, per_page, total}}`; `page` and `per_page` (max 100) query params.
- Errors: `{message}`; validation `{message, errors: {field: [msg]}}`. Statuses 401 (no/invalid/expired token), 403 (ability or permission), 404, 422, 429 with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`.
- Auth: `Authorization: Bearer <token>`. Abilities `agent`, `admin`, `*`.
- Statuses and priorities are strings at the boundary; tickets are addressed by `reference` in paths.
- No "Claude", "Filament" or AI mentions in commits or PRs. No em dashes in prose copy.
- Contract version string: `api_version: "1.0"` for this release of the contract.

## Review Focus

- A backend that serves the old routes but not `/meta`: suite must report "not contract v1" on the first test and skip the rest, not fail 40 times.
- Rate limiting during the suite run itself (Laravel default 60/min): the suite must stay under it or honour `Retry-After`.
- Tokens with only `agent` ability hitting admin endpoints: expect 403, never 401.
- A seeded install with zero canned responses or macros: list endpoints still return `{data: []}`; tests that need one skip with a clear reason.
- `updated_since` with a timezone offset (`2026-11-26T10:00:00-05:00`) and with `Z`: both parse; a malformed value is 422, not 500.

---

### Task 1: Contract document

**Files:**
- Create: `contracts/staff-api-v1.md`
- Modify: `README.md` (one line under the index pointing at `contracts/`)

- [ ] **Step 1: Write `contracts/staff-api-v1.md`** with these sections: Scope; Base path and discovery (default prefix `support/api/v1`, WordPress `/wp-json/escalated/v1`, discovery via `GET {prefix}/meta`); Authentication (Bearer, abilities, the extension connect flow in Task 1a below); Conventions (pagination, errors, rate limit headers, string enums, ISO 8601 UTC timestamps); Endpoint table (every endpoint in Laravel `routes/api.php` plus the new ones, columns: method, path, ability, request, response, required-for-extension yes/no); Features list; Change log.
- [ ] **Step 2: Specify the new endpoints exactly:**
  - `GET /meta` (public, no token needed, rate limited; this is how the extension finds the API before sign-in): `{api_version: "1.0", backend: "laravel"|"rails"|..., features: string[], connect_url: string|null, web_url_template: string}` where `connect_url` is the absolute URL of the connect page (null when `auth.exchange` is off) and `web_url_template` is the absolute agent ticket URL with `{reference}` in it. With a valid token the response also has `backend_version: "1.9.21"` (kept out of the public response so installs don't advertise their version). Feature names: `tickets.create`, `tickets.macro`, `tickets.updated_since`, `tickets.last_customer_reply_at`, `canned_responses`, `macros`, `auth.exchange`, `auth.revoke`, `realtime`.
  - `GET /tickets?updated_since=<ISO 8601>`: tickets with `updated_at >= updated_since`; malformed value 422.
  - List and show items gain `last_customer_reply_at` (ISO 8601 or null): last customer-side public activity.
  - `POST /auth/exchange` (no token; rate limited 10/min per IP): body `{code, code_verifier, redirect_uri}`; 200 `{token, token_type: "Bearer", expires_at, user: {id, name, email}}`; 400 `{message}` for unknown, used or expired code, wrong verifier or mismatched redirect_uri (one generic message, no detail on which).
  - `POST /auth/revoke` (any valid token): deletes the calling token; 204.
- [ ] **Step 3: Specify the connect flow** (helpdesk side, staff session): `GET {web_prefix}/agent/connect-extension?redirect_uri&state&code_challenge&code_challenge_method=S256&client_name`. `redirect_uri` must match `^https://[a-p]{32}\.chromiumapp\.org/$` (Chrome) unless the install adds patterns. Approve issues a one-time code (60 s, single use, stored hashed with the challenge and redirect_uri) and redirects to `redirect_uri?code=&state=`; Deny redirects with `?error=access_denied&state=`. Token minted on exchange: abilities `["agent"]`, name `Browser extension (<client_name>)`, kind `browser_extension`, no expiry unless the install sets one. Each agent sees and revokes their own extension tokens on `{web_prefix}/agent/browser-extensions`.
- [ ] **Step 4: Commit**

```bash
git add contracts/staff-api-v1.md README.md
git commit -m "Add staff API v1 contract"
```

### Task 2: OpenAPI file

**Files:**
- Create: `contracts/staff-api-v1.openapi.yaml`, `contracts/package.json` (scripts only: `lint`), `.github/workflows/contracts.yml`

**Interfaces:**
- Produces: `contracts/staff-api-v1.openapi.yaml`, OpenAPI 3.1, with `components.schemas` named exactly `Meta`, `TicketListItem`, `Ticket`, `Reply`, `Agent`, `Department`, `CannedResponse`, `Macro`, `Dashboard`, `PaginationMeta`, `Error`, `ValidationError`, `ExchangeRequest`, `ExchangeResponse`, `AuthValidateResponse`. Plan 3 generates TypeScript types from it with `openapi-typescript`.

- [ ] **Step 1: Write the YAML** covering every endpoint in the Task 1 table, `servers: [{url: "{base}", variables: {base: {default: "https://helpdesk.example.com/support/api/v1"}}}]`, `bearerAuth` security scheme, and the schemas above derived from Laravel's resources (`TicketCollectionResource` = `TicketListItem`, `TicketResource` = `Ticket`, etc.) plus `last_customer_reply_at`.
- [ ] **Step 2: Lint**

Run: `cd contracts && npx @redocly/cli@1 lint staff-api-v1.openapi.yaml`
Expected: `Woohoo! Your API description is valid.` (warnings allowed, no errors)

- [ ] **Step 3: Add CI** `.github/workflows/contracts.yml`: on push/PR touching `contracts/**`, run the lint command and `cd conformance && npm ci && npm run typecheck`.
- [ ] **Step 4: Commit** `git commit -m "Add staff API v1 OpenAPI description"`

### Task 3: Conformance runner skeleton

**Files:**
- Create: `conformance/package.json`, `conformance/tsconfig.json`, `conformance/vitest.config.ts`, `conformance/src/client.ts`, `conformance/src/env.ts`, `conformance/tests/00-meta.test.ts`, `conformance/README.md`

**Interfaces:**
- Produces: `env()` returning `{baseUrl: string, agentToken: string, adminToken?: string}` from `ESCALATED_CONFORMANCE_URL` (full API base, e.g. `http://localhost:8000/support/api/v1`), `ESCALATED_CONFORMANCE_TOKEN`, `ESCALATED_CONFORMANCE_ADMIN_TOKEN`; `api(method, path, {token?, query?, body?}) => Promise<{status, headers, json}>` that retries once after `Retry-After` on 429.

- [ ] **Step 1: Write `tests/00-meta.test.ts`**: `GET /meta` without a token is 200 with no `backend_version` key; with the token it has `backend_version`; `api_version` matches `/^1\./`; `backend` is a non-empty string; `features` is a string array; `web_url_template` contains `{reference}`; `connect_url` is a string when `auth.exchange` is listed, else null. If `/meta` is 404, the test fails with message `Backend does not serve staff API contract v1 (GET /meta is 404)` and a vitest `globalSetup` marks the run so every other file skips.
- [ ] **Step 2: Run it against nothing** `ESCALATED_CONFORMANCE_URL=http://127.0.0.1:9 npx vitest run` and check it fails with a connection message naming the URL, not a stack trace.
- [ ] **Step 3: Commit** `git commit -m "Add conformance suite runner"`

### Task 4: Conformance tests for the extension subset

**Files:**
- Create: `conformance/tests/10-auth.test.ts`, `20-tickets-list.test.ts`, `30-ticket-show.test.ts`, `40-ticket-actions.test.ts`, `50-resources.test.ts`, `60-errors.test.ts`, `conformance/src/schema.ts`

**Interfaces:**
- Consumes: Task 3 `env()`, `api()`; Task 2 OpenAPI.
- Produces: `expectSchema(name: string, value: unknown)` in `src/schema.ts`, validating against the OpenAPI component with Ajv (`ajv` + `ajv-formats`, draft 2020).

Seed assumptions (documented in `conformance/README.md`, each backend's CI provides them): two staff users (the token's owner and one other agent), at least three open tickets with one unassigned, at least one department; canned responses and macros optional.

- [ ] **Step 1: Write the tests**, one `it` per line:
  - auth: `POST /auth/validate` 200 matches `AuthValidateResponse`; no token 401 `{message}`; garbage token 401; `POST /auth/exchange` with a random code 400 `{message}` (feature `auth.exchange` only); `POST /auth/revoke` is covered only when `ESCALATED_CONFORMANCE_REVOCABLE_TOKEN` is set, then that token gets 401 afterwards.
  - list: 200 matches `{data: TicketListItem[], meta: PaginationMeta}`; `per_page=1&page=2` returns a different reference than page 1; `per_page=500` caps at 100; `status=open` only returns open; `unassigned=1` only null assignee; `updated_since` far future returns `[]`, far past returns >= 3, `+02:00` offset accepted, `not-a-date` 422; every item has `last_customer_reply_at` key when feature listed.
  - show: by reference 200 matches `Ticket`; unknown reference 404 `{message}`.
  - actions (on one seeded ticket, restoring state after): reply 201/200 then shows in thread; internal note has `is_internal_note: true`; status `pending` then back; priority change; assign to the other agent then back; assign to a non-agent 422; macro only when one exists (else `it.skip` with reason).
  - resources: agents, departments, canned-responses, macros each 200 `{data: []}` shape.
  - errors: agent token on `DELETE /tickets/{ref}` 403 not 401; 422 body has `errors`; rate-limit headers present on a 200.
- [ ] **Step 2: Run against a local Laravel install** (plan 2 Task 6 provides the docker seed) `npm test` and record which fail on v1.9.20 (expected: meta, exchange, updated_since, last_customer_reply_at). Note the list in the PR body.
- [ ] **Step 3: Commit and open the PR**

```bash
git commit -m "Add staff API v1 conformance tests"
gh pr create -R escalated-dev/escalated-developer-context --title "Staff API v1 contract and conformance suite" --body "<summary + the failing-on-1.9.20 list>"
```
