# Escalated browser extension: design

Status: approved by the owner (2026-11-26).
Research: `docs/research/browser-extension-research.md`. Backend audit: `docs/research/staff-api-parity.md`.

## Intent

Let agents answer tickets on the fly, from whatever tab they are in, without opening the
helpdesk. Owner's words: "escalated first, answer tickets on the fly". It is free and public
(MIT, new repo), and it should work against every Escalated backend: where a backend's staff
API is lacking, bring it up to speed ("if its lacking, get it up to speed").

Inventoros gets its own extension later, as a separate store listing (Chrome's single purpose
policy), possibly sharing tooling. Not in this design.

## Goals (v1)

1. **Connect (owner's choice: sign in via the helpdesk):** the agent enters their helpdesk's
   address and clicks Connect. The extension asks Chrome for access to that one origin, then
   opens the helpdesk's new "Connect browser extension" page in a popup
   (`chrome.identity.launchWebAuthFlow`). The agent signs in there if needed and approves; the
   helpdesk mints an agent-only token (named for the extension and browser, listed and
   revocable on the agent's profile and the admin API tokens page) and redirects to the
   extension's `https://<id>.chromiumapp.org/` URL with a one-time code, which the extension
   swaps for the token over the API (code expires in 60 seconds, PKCE-style verifier, so the
   token never sits in a URL). Pasting a token by hand stays available under Advanced.
   Disconnect revokes the token and forgets everything.
   Backend work in every port: the approve page (staff session, CSRF), `POST /auth/exchange`,
   and a "Browser extensions" list with Revoke on the agent profile.
2. **Queue in the side panel:** Mine / Unassigned / All open, with search and status filter.
   Each row shows reference, subject, requester, priority, SLA breach, last activity.
3. **Ticket view in the side panel:** subject, requester, status, priority, assignee,
   department, SLA due times, the conversation (replies and internal notes, newest at the
   bottom like the helpdesk), and an "Open in helpdesk" link.
4. **Answer:** reply or internal note, with canned responses to insert; apply a macro; change
   status, priority and assignee (assign to me in one click).
5. **Badge and alerts:** the toolbar badge shows the agent's open assigned count. A desktop
   notification when a ticket is newly assigned to them or one of their tickets gets a customer
   reply. Clicking it opens that ticket in the side panel. Polling every 60 seconds with
   `chrome.alarms` (realtime is a later improvement).
6. **Create a ticket from the page:** right-click a selection (or the page) and choose "Create
   Escalated ticket". The form is pre-filled with the selection and the page title and URL.
7. **Works the same on all 11 backends**, because each serves the same staff API (below).

## Non-goals (v1)

- Gmail / Outlook sidebars (costly and fragile per the research; revisit later).
- Knowledge base search and insert (v2: needs an agent KB search endpoint first).
- Attachments upload, live chat, reports, admin settings.
- More than one connected helpdesk at a time.
- Firefox and Edge store listings (v1.1; keep the code WebExtension-portable).
- Inventoros.

## Anti-goals (would make it a failure even if it works)

- Loading any code or UI from the helpdesk server (Chrome Web Store remote code ban).
- A content script on all sites, or asking for access to every site up front.
- Storing the token anywhere a web page can reach it (content scripts, `storage.sync`).
- Breaking when a backend lacks an optional endpoint: features the backend doesn't report are
  hidden, never shown broken.
- Becoming a second helpdesk UI to maintain: v1 covers answering and triage only.

## Constraints

- Manifest V3. Chrome first. Side panel API.
- Host access: `optional_host_permissions` for `https://*/*` and `http://*/*`; at connect,
  `chrome.permissions.request` for the one origin the agent typed, from their click.
- All API calls from the service worker or extension pages (extension origin with host
  permission, so no CORS work on any backend). Never from content scripts.
- Token in `chrome.storage.local` with `setAccessLevel('TRUSTED_CONTEXTS')`; never logged.
- Service worker can be stopped at any time: alarms are recreated on every start; no state
  kept only in memory.
- Store listing needs a privacy policy page and the Privacy practices answers: the extension
  sends data only to the helpdesk the user connects, nothing else (no analytics).
- Owner rules: patch version bumps; no "Claude"/"Filament"/AI mentions in commits or PRs; no em
  dashes in UI copy; READMEs short with detail in docs/.

## Approaches

- **A. Side panel app over the token staff API (chosen).** One stable contract, every backend
  serves it, the extension feature-detects. Most work, because most backends need API work,
  but it also fixes the same gaps for every other API client.
- B. Reuse the helpdesk's signed-in agent pages (session cookie). No backend work, but those
  are page payloads, not an API: they differ per backend, change with the UI, and fight
  SameSite/CSRF. Rejected: users complain most about extensions that break when the UI changes.
- C. Frame the agent screens in the side panel. Quickest, but most installs block framing,
  and there is no badge, alerts or "from this page". Rejected.

## The staff API contract (backend work)

Laravel's `support/api/v1` is the reference. The extension needs this subset on every backend,
with Laravel's paths, request fields, response shapes, `{data, meta}` pagination, `{message}`
/ `{message, errors}` errors, 401/403/404/422/429 statuses and rate limit headers:

| Endpoint | Laravel # | Used for |
|---|---|---|
| `GET /meta` (new) | E0 | api version, backend name and version, supported features |
| `POST /auth/validate` | E1 | connect, who am I |
| `GET /dashboard` | E2 | badge counts |
| `GET /tickets` | E3 | queue (filters: status, priority, assigned_to, unassigned, search, sort_by, sort_dir, page, per_page, updated_since (new)) |
| `POST /tickets` | E4 | create from page |
| `GET /tickets/{ref}` | E5 | ticket view |
| `POST /tickets/{ref}/reply` | E8 | reply / note |
| `PATCH /tickets/{ref}/status` | E9 | status |
| `PATCH /tickets/{ref}/priority` | E10 | priority |
| `POST /tickets/{ref}/assign` | E11 | assign |
| `POST /tickets/{ref}/macro` | E13 | macros |
| `GET /agents`, `/departments`, `/canned-responses`, `/macros` | E16, E17, E19, E20 | pickers |

New on every backend, including Laravel:
- `GET /meta`: `{api_version: "1.x", backend: "laravel", backend_version, features: [...]}`
  (no auth needed beyond the token; lets the extension hide what a backend can't do).
- `updated_since` (ISO 8601) on `GET /tickets`, so polling is one cheap request.
- `last_customer_reply_at` on list items (for "customer replied" alerts).

The rest of the Laravel API (subjects, follow, tags, actions, delete, reports, realtime) is
part of the contract too and gets ported for parity, but the extension does not depend on it.

**Where the contract lives:** written down once in `escalated-developer-context`
(`contracts/staff-api-v1.md` plus an OpenAPI file), with a black-box conformance test suite
that runs against a live backend over HTTP. Each backend's CI runs it. This is what keeps 11
backends matching.

**Per backend** (details in the parity report):
- Laravel: add E0 and `updated_since`; fix `following` filter, macro `steps` (should be
  `actions`), report type 500, UUID `user_id` on the token form; endpoint reference doc.
- Adonis: E0, `page` ignored, null assignee/author/causer, subjects, reports.
- Rails, Django: align paths (macro, create, delete, trailing slashes), pagination meta, token
  ability and staff checks; Django ships its own API middleware scoped to the API path.
- WordPress: serve the contract shape (a `v1` namespace alias or a new namespace) while keeping
  the existing routes for its current clients; real 429s.
- Phoenix, Symfony: fill the missing endpoints, pagination, rate limit, `{message}` errors.
- Go, Spring: add the `support/api/v1` contract alongside their current JSON APIs.
- NestJS, .NET: build the staff API (they have token guards but no endpoints).
- API on by default stays off where it is off today; the extension's connect screen tells the
  admin exactly which switch to turn on for their backend.

**Security fixes first** (owner approved 2026-11-26; in progress), as their own patch releases:
WordPress password login minting full tokens for any user; Rails/Django DELETE with any token;
Laravel mobile refresh bypassing token expiry.

## Extension build (my calls, correctable)

- New public repo `escalated-dev/escalated-browser-extension`, MIT.
- TypeScript, Vue 3, Vite, Tailwind 4 (same stack family as the shared frontend so the look
  matches; no Inertia). One small API client module typed from the OpenAPI file.
- Tests: unit tests for the client and state; Playwright end-to-end with the unpacked extension
  against a mock server built from the contract fixtures; one CI job against a real Laravel
  install.
- Releases: GitHub release with the zip on each tag. The owner submits to the Chrome Web Store
  (the developer account and listing are the owner's to create).

## Order of work

1. Security fixes (3 backends), patch releases.
2. Contract doc, OpenAPI file and conformance suite; Laravel brought fully to the contract.
3. Extension v1 against Laravel.
4. Backends brought to the contract, closest first (Adonis, Rails, Django, WordPress, Phoenix,
   Symfony), then Go and Spring, then NestJS and .NET; each with the conformance suite in CI.
5. Store listing material: icons, screenshots, privacy policy page.

## Decisions from the builder check (my calls, marked; correct any)

- **v1 ships on Laravel** (my call). The extension is released and submitted once it works
  against Laravel; it reads `/meta` and says plainly when a backend doesn't serve the contract
  yet. The other ten backends follow as a separate, parallel stream (step 4) and start working
  in the extension as each one passes the conformance suite. No extension release waits on them.
- **Finding the API** (my call). The agent types the helpdesk address. The extension tries
  `GET {address}/support/api/v1/meta`, then each backend's known default prefix
  (`/wp-json/escalated/v1`, `/escalated/api/v1`, `/escalated/api`); an "API path" field under
  Advanced covers custom prefixes. Every backend's contract routes default to
  `support/api/v1` except WordPress (`/wp-json/escalated/v1`, WP's REST convention). On
  tenancy installs the token belongs to its tenant, so the token resolves the tenant; no extra
  field.
- **Compatibility** (my call). Backend work is additive: existing routes and shapes stay (as
  aliases where paths change), so current clients, other API clients and the mobile app keep
  working. Patch version bumps, per the owner's rule.
- **Go and Spring** (my call). The contract is strict at the HTTP boundary: string statuses
  and priorities, ticket references, `{data, meta}` with `page`/`per_page`. Those two get a
  thin contract layer that translates to their internals; their current APIs stay.
- **Conformance suite** (my call). A Node/TypeScript runner in `escalated-developer-context`.
  Each backend's CI boots its own test app, seeds two staff users and a few tickets, and passes
  a known token via `ESCALATED_CONFORMANCE_TOKEN`; the suite only talks HTTP.
- **WordPress security fix** (my call, if the fix is approved). `auth/login` keeps working but
  only staff get staff tokens; other users get customer-only tokens, as the mobile app expects.
  Not a breaking change.

## Left to the builder

Exact UI layout of the side panel (keep it dense, match the agent panel's tokens), polling
backoff on errors and rate limits, notification wording, how features from `/meta` map to
UI, test fixture layout.
