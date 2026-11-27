# Development

## Setup

You need Node 24 or later.

```
npm ci
npm run build
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Rebuilds `dist/` when files change |
| `npm run build` | Production build into `dist/` |
| `npm run build:e2e` | Test build into `dist-e2e/` (see End-to-end tests) |
| `npm run zip` | Zips `dist/` into `escalated-browser-extension-<version>.zip` |
| `npm run check:dist` | Fails if `dist/` has e2e host permissions, content scripts, or localhost addresses |
| `npm run lint` | ESLint and Prettier check |
| `npm run typecheck` | `vue-tsc` |
| `npm test` | Unit tests (Vitest) |
| `npm run e2e` | End-to-end tests (Playwright), after `npm run build:e2e` |
| `npm run gen:types` | Regenerates `src/api/schema.d.ts` from the staff API contract |

## Load the extension unpacked

1. Run `npm run build`.
2. Open `chrome://extensions` and turn on Developer mode.
3. Choose Load unpacked and pick the `dist/` folder.
4. Click the toolbar icon. The side panel opens. Enter your helpdesk address and connect.

After a rebuild, press the reload button on the extension card.

## Regenerating API types

The types come from the staff API contract, `contracts/staff-api-v1.openapi.yaml` in `escalated-dev/escalated-developer-context`. `scripts/gen-types.mjs` downloads the file at a pinned commit and writes `src/api/schema.d.ts`.

```
npm run gen:types
```

The pin is the commit in `CONTRACT_URL`. When the contract changes, move the pin to the new commit and regenerate. The pin currently points at a commit on a pull request branch. Re-pin it to the merge commit once escalated-developer-context PR #33 merges.

## End-to-end tests

The suite loads the real extension in Chromium and drives it against a mock helpdesk (`tests/e2e/mock-server.ts`, fixtures in `tests/e2e/fixtures/`). The mock serves the part of the staff API the extension uses, checks the PKCE verifier on `/auth/exchange`, and has a connect page that approves at once. That auto-approve is for tests only. The real page must never do it.

```
npx playwright install chromium    # once
npm run build:e2e
npm run e2e
```

It runs headless. Set `E2E_HEADED=1` to watch it; on a Linux machine without a display, run it under `xvfb-run` when headed.

`npm run build:e2e` writes `dist-e2e/`. Its manifest is the production one plus `host_permissions` for `http://localhost/*` and `http://127.0.0.1/*`, so `chrome.permissions.request` resolves without a prompt. The code is identical. The production build has no `host_permissions`, and a unit test checks that `dist/` does not contain the e2e additions.

Flows covered: the service worker starts without errors and the toolbar button is set to open the side panel; sign in through the helpdesk connect page (`launchWebAuthFlow`); the queue; opening a ticket; sending a reply; the badge count after a poll; disconnect with token revocation.

The service worker and the reply path are also covered by unit tests, which run without a browser.

## Releasing

1. Update `version` in `package.json` and `public/manifest.json` (a unit test checks they match).
2. Tag the commit `v<version>` and push the tag.
3. The Release workflow runs the tests, builds, zips and attaches the zip to the GitHub release.
4. The owner uploads the zip to the Chrome Web Store. `docs/privacy.md` is the privacy policy for the listing.

## Pre-submission checklist

Before the first store submission, the owner checks the extension by hand against a real install (Laravel 1.9.21 or later, for example the docker demo from `escalated-laravel`, with the staff API turned on):

- [ ] Connect by signing in through the helpdesk page, then disconnect and connect again with a pasted token.
- [ ] Reply, add an internal note, change status and priority, assign, apply a macro, insert a canned response.
- [ ] Get a notification when a ticket is assigned to you, and when a customer replies to one of yours. Clicking it opens the ticket.
- [ ] Create a ticket from a page with the right-click item.
- [ ] Revoke the token from the helpdesk and confirm the panel asks to reconnect and the badge shows "!".
- [ ] Open the browser extensions page of the agent account, confirm the token is listed, then confirm Disconnect removes it.
