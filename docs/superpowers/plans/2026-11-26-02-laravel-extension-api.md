# Laravel staff API for the browser extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring escalated-laravel to staff API contract v1 (plan 1) including the helpdesk sign-in flow for the extension, with the two new agent pages in the shared frontend, and run the conformance suite in Laravel's CI.

**Architecture:** Additive changes to `routes/api.php`, the API controllers and resources, one new table for one-time codes, one new column on api tokens, two agent web routes rendered through `EscalatedUiRenderer` as shared frontend pages `Escalated/Agent/ConnectExtension` and `Escalated/Agent/BrowserExtensions`. Released as escalated-laravel 1.9.21 with `@escalated-dev/escalated` 0.12.13.

**Tech Stack:** PHP 8.2+, Laravel 11-13, Pest, Vue 3 + Inertia (frontend repo), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-26-escalated-browser-extension-design.md`; contract: `escalated-developer-context/contracts/staff-api-v1.md` (plan 1).

**Repos:** `escalated-dev/escalated-laravel` (worktree `C:\Users\work\escalated-wt\escalated-laravel`, branch `feat/extension-api`), `escalated-dev/escalated` (worktree `C:\Users\work\escalated-wt\escalated`, branch `feat/extension-pages`).

## Global Constraints

- Additive only: no existing route, field or default changes meaning. API stays off by default (`escalated.api.enabled`).
- Patch version bumps: escalated-laravel 1.9.21, frontend 0.12.13.
- One-time code: 60 seconds, single use, stored as sha256, PKCE S256 only.
- Default allowed redirect pattern: `^https://[a-p]{32}\.chromiumapp\.org/$`; config `escalated.api.extension_redirect_patterns` (array of regexes).
- Extension tokens: abilities `["agent"]`, name `Browser extension (<client_name>)` with client_name trimmed to 60 chars, `kind = 'browser_extension'`, `expires_at` from `escalated.api.extension_token_expiry_days` (default null).
- Feature list served by `/meta` on Laravel: `tickets.create`, `tickets.macro`, `tickets.updated_since`, `tickets.last_customer_reply_at`, `canned_responses`, `macros`, `auth.exchange`, `auth.revoke`, plus `realtime` when broadcasting is on.
- UI copy: no em dashes; all new strings translated in the frontend's 14 locales (English source, other locales may copy English for now only if that is the repo's existing practice; check `src/locales` before deciding).
- No "Claude", "Filament" or AI mentions in commits or PRs. Never commit `.security-audit/`.
- Run `vendor/bin/pint` and the full Pest suite before each PR; frontend: `npm run lint`, `npm test`.

## Review Focus

- An agent who is signed out when the extension opens the connect page: they must land on the host login and come back to the same connect URL with its query intact (use `redirect()->guest()` behaviour of the host `auth` middleware; test the 302 to login keeps `url.intended`).
- A non-agent signed-in user opening the connect page: 403 page, no code issued.
- Replay: the same code exchanged twice, or after 60 s, or with the right code but a different `redirect_uri`: all 400 with the same message, and a replayed code also revokes the token minted by the first exchange (code-replay defence).
- An admin revokes the agent's extension token from Admin > API tokens: the extension's next call gets 401 (existing behaviour; add the test).
- Tenancy installs: codes and tokens are created on the tenant connection (`Escalated::table()` / tenant-aware models), so a code minted on tenant A cannot be exchanged on tenant B.

---

### Task 1: `/meta`, `updated_since`, `last_customer_reply_at`

**Files:**
- Create: `src/Http/Controllers/Api/MetaController.php`, `tests/Feature/Api/MetaTest.php`, `tests/Feature/Api/TicketUpdatedSinceTest.php`
- Modify: `routes/api.php` (agent group), `src/Http/Controllers/Api/TicketController.php:35-50`, `src/Services/TicketService.php` (`list()` filters), `src/Http/Resources/TicketCollectionResource.php`, `src/Http/Resources/TicketResource.php`

**Interfaces:**
- Produces: route `GET {prefix}/meta` named `escalated.api.meta`, outside the token middleware (public, `throttle:60,1`, registered only while `escalated.api.enabled`); it reads an optional Bearer token itself and adds `backend_version` only when that token is valid; `connect_url` = `route('escalated.agent.extension.connect')` (Task 5); `web_url_template` = `route('escalated.agent.tickets.show', '{reference}')` with the encoded placeholder restored; `MetaController::__invoke(Request $request): JsonResponse`; `TicketService::list()` accepts filter key `updated_since` (Carbon-parseable ISO 8601).

- [ ] **Step 1: Failing tests**
  - `it('serves public meta')`: no token, 200, no `backend_version` key, `connect_url` ends with `/support/agent/connect-extension`, `web_url_template` ends with `/support/agent/tickets/{reference}`; 404 when `escalated.api.enabled` is false.
  - `it('serves meta')`: agent token, `GET /support/api/v1/meta` 200, `api_version` `'1.0'`, `backend` `'laravel'`, `backend_version` equals `Composer\InstalledVersions::getPrettyVersion('escalated-dev/escalated-laravel')` stripped of leading `v` (fallback `'dev'`), `features` contains `'auth.exchange'` and `'tickets.updated_since'`, does not contain `'realtime'` when `escalated.broadcasting.enabled` is false.
  - `it('filters by updated_since')`: three tickets with `updated_at` 3 days, 1 day, now; `?updated_since=` 2 days ago (with `Z`) returns 2; same instant with `+02:00` offset equivalent returns 2; `not-a-date` 422 with `errors.updated_since`.
  - `it('exposes last_customer_reply_at')`: ticket with `last_customer_activity_at` set shows it as ISO 8601 in list and show; null stays null.
- [ ] **Step 2: Run** `vendor/bin/pest tests/Feature/Api/MetaTest.php tests/Feature/Api/TicketUpdatedSinceTest.php` → FAIL (404 / missing key).
- [ ] **Step 3: Implement.** `updated_since` validated `['nullable', 'date']` in the controller, added to the `$request->only([...])` list, applied as `where('updated_at', '>=', Carbon::parse($v)->utc())`. Both resources add `'last_customer_reply_at' => $this->last_customer_activity_at?->toIso8601String()`.
- [ ] **Step 4: Run** the two files plus `vendor/bin/pest tests/Feature/Api` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add API meta endpoint, updated_since filter and last_customer_reply_at"`

### Task 2: Token kind column and one-time codes table

**Files:**
- Create: `database/migrations/2026_11_26_000001_add_kind_to_escalated_api_tokens.php`, `database/migrations/2026_11_26_000002_create_escalated_api_token_codes.php`, `src/Models/ApiTokenCode.php`, `tests/Unit/ApiTokenCodeTest.php`
- Modify: `src/Models/ApiToken.php` (`kind` fillable; `createToken(..., ?string $kind = null)` as a new trailing parameter)

**Interfaces:**
- Produces: `ApiTokenCode::issue(Model $user, string $codeChallenge, string $redirectUri, string $clientName): string` (returns plain code, 43+ url-safe chars); `ApiTokenCode::consume(string $code, string $verifier, string $redirectUri): ?ApiTokenCode` (null on any failure; marks `used_at`; when the code was already used, revokes `api_token_id` and returns null); columns `id, code (sha256, unique), tokenable_type, tokenable_id, code_challenge, redirect_uri, client_name, expires_at, used_at, api_token_id (nullable), timestamps`. Table via `Escalated::table('api_token_codes')`, migrations follow the existing tenant-aware migration pattern in `database/migrations/`.

- [ ] **Step 1: Failing unit tests**: issue then consume with correct verifier returns the row; wrong verifier null; wrong redirect null; after `travel(61)->seconds()` null; second consume null and the linked token is deleted; S256 check is `rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=') === code_challenge`.
- [ ] **Step 2: Run** `vendor/bin/pest tests/Unit/ApiTokenCodeTest.php` → FAIL.
- [ ] **Step 3: Implement** the migrations, model and `consume` with a row lock (`lockForUpdate` inside a transaction) so two concurrent exchanges cannot both succeed.
- [ ] **Step 4: Run** → PASS; run migrations on sqlite, mysql, pgsql through the existing CI matrix later.
- [ ] **Step 5: Commit** `git commit -m "Add one-time codes for browser extension sign-in"`

### Task 3: `/auth/exchange` and `/auth/revoke`

**Files:**
- Create: `src/Http/Controllers/Api/ExtensionAuthController.php`, `tests/Feature/Api/ExtensionExchangeTest.php`
- Modify: `routes/api.php`, `src/Http/Controllers/Api/AuthController.php` (add `revoke`)

**Interfaces:**
- Consumes: Task 2 `ApiTokenCode::consume`, `ApiToken::createToken(..., kind: 'browser_extension')`.
- Produces: `POST {prefix}/auth/exchange` (name `escalated.api.auth.exchange`, outside the token middleware, `throttle:10,1`, still only registered while `escalated.api.enabled`); `POST {prefix}/auth/revoke` (agent group, name `escalated.api.auth.revoke`).

- [ ] **Step 1: Failing tests**: valid exchange 200 `{token, token_type: 'Bearer', expires_at: null, user: {id, name, email}}` and that token passes `POST /auth/validate` with `abilities` `['agent']`; invalid code 400 `{message: 'Invalid or expired code.'}`; missing fields 422; 11th call in a minute 429; a user who lost agent access between approve and exchange gets 400 and no token; revoke 204 then the same token gets 401.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Exchange re-checks `StaffAccess::isAgent($user)` before minting; stores `api_token_id` on the code row.
- [ ] **Step 4: Run** `vendor/bin/pest tests/Feature/Api` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add browser extension token exchange and revoke"`

### Task 4: Frontend pages ConnectExtension and BrowserExtensions (escalated repo)

**Files (escalated repo):**
- Create: `src/pages/Agent/ConnectExtension.vue`, `src/pages/Agent/BrowserExtensions.vue`, `tests/pages/ConnectExtension.test.js`, `tests/pages/BrowserExtensions.test.js`, matching `.stories.js`
- Modify: `src/locales/*.json` (14 locales, keys under `browser_extensions.*`), `CHANGELOG.md` (Unreleased > Added)

**Interfaces:**
- Produces: page `Escalated/Agent/ConnectExtension` with props `{client_name: string, origin_host: string, approve_url: string, deny_url: string}` posting a form (Inertia `router.post`) to `approve_url` / `deny_url`; page `Escalated/Agent/BrowserExtensions` with props `{tokens: Array<{id, name, created_at, last_used_at, expires_at}>, revoke_url_template: string}` (template contains `__ID__`), revoking with `router.delete`.

- [ ] **Step 1: Failing tests**: ConnectExtension renders "Connect browser extension", the client name, and two buttons "Approve" and "Deny"; clicking Approve posts to `approve_url`. BrowserExtensions lists names with relative "last used" (or "Never used"), Revoke asks for confirmation inline (no `window.confirm`) then deletes `/support/agent/browser-extensions/5`; empty state "No browser extensions connected."
- [ ] **Step 2: Run** `npm test -- ConnectExtension BrowserExtensions` → FAIL.
- [ ] **Step 3: Implement** with the agent panel layout and existing panel components (match `Agent/Dashboard.vue` conventions), dark/light via the panel tokens.
- [ ] **Step 4: Run** `npm run lint && npm test` → PASS.
- [ ] **Step 5: Commit and open PR** on `escalated` (`feat/extension-pages`): `git commit -m "Add browser extension connect and management pages"`

### Task 5: Laravel web routes for the two pages

**Files:**
- Create: `src/Http/Controllers/Agent/BrowserExtensionController.php`, `tests/Feature/Agent/BrowserExtensionTest.php`
- Modify: `routes/agent.php`, `config/escalated.php` (`api.extension_redirect_patterns`, `api.extension_token_expiry_days`), `docs/` (new `docs/browser-extension.md`; link from README's docs list), `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 2 `ApiTokenCode::issue`, Task 4 page names and props.
- Produces: `GET  {prefix}/agent/connect-extension` (`escalated.agent.extension.connect`), `POST {prefix}/agent/connect-extension/approve` (`.approve`), `POST {prefix}/agent/connect-extension/deny` (`.deny`), `GET {prefix}/agent/browser-extensions` (`escalated.agent.extensions.index`), `DELETE {prefix}/agent/browser-extensions/{id}` (`.destroy`). All inside the existing agent middleware group (so 2FA and agent checks apply). Approve and deny receive the original query as hidden inputs and re-validate it.

- [ ] **Step 1: Failing tests**: GET with valid params renders `Escalated/Agent/ConnectExtension` with `client_name`; bad `redirect_uri` (`https://evil.example/`) 422 and no code row; `code_challenge_method=plain` 422; approve 302 to `https://<32 a-p>.chromiumapp.org/?code=...&state=xyz` and one code row exists; deny 302 to `...?error=access_denied&state=xyz`; non-agent 403; guest 302 to login; index lists only the current user's `browser_extension` tokens; destroy of another user's token 404; destroy own 302 back and row gone.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** full suite `vendor/bin/pest` and `vendor/bin/pint --test` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add browser extension connect page and token list for agents"`

### Task 6: Conformance in Laravel CI

**Files:**
- Create: `docker/host-app/app/Console/Commands/ConformanceSeed.php` (host-app only, not the package), `.github/workflows/conformance.yml`
- Modify: `docker/host-app` registration of the command, `docker/README.md` (one paragraph)

**Interfaces:**
- Consumes: plan 1 `conformance/` suite and its env vars.
- Produces: `php artisan escalated:conformance-seed` (host app) creating two agents, one admin, three open tickets (one unassigned), one department, one canned response, one macro, printing `AGENT_TOKEN=...`, `ADMIN_TOKEN=...`, `REVOCABLE_TOKEN=...` lines.

- [ ] **Step 1: Write the workflow**: build and start `docker/compose.yml` with `ESCALATED_API_ENABLED=true`, run the seed command, export the tokens, clone `escalated-dev/escalated-developer-context` (pinned to the merged plan 1 commit), `cd conformance && npm ci && ESCALATED_CONFORMANCE_URL=http://localhost:8080/support/api/v1 npm test`.
- [ ] **Step 2: Run locally** the same steps with Docker and confirm all tests pass.
- [ ] **Step 3: Commit** `git commit -m "Run the staff API conformance suite in CI"`, open the Laravel PR referencing the frontend PR. Release order once both are green and merged: frontend 0.12.13, then Laravel 1.9.21 (patch bumps, the usual release PR + GitHub release flow, then Packagist Update).
