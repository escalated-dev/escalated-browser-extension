# Staff REST API parity (audit 2026-11-26)

Read from each backend's up-to-date default branch. Reference contract: escalated-laravel `routes/api.php`.

## Laravel contract (reference)

- Mounted only when `escalated.api.enabled` (`ESCALATED_API_ENABLED`, default false). Prefix `escalated.api.prefix`, default `support/api/v1` (config only).
- Middleware: tenancy, `ResolveTenant`, `AuthenticateApiToken:{agent|admin}`, `ApiRateLimit`, `EnforceRoutePermissions`. No session/CSRF. `{ticket}` = reference only.
- Auth: `Authorization: Bearer <64 hex>` (sha256 stored). Abilities `agent`, `admin`, `*`, not hierarchical. Errors `{message}`: 401 `Unauthenticated.` / `Invalid token.` / `Token has expired.` / `Token owner not found.`; 403 `Insufficient permissions.` / `User no longer has agent access.`
- Tokens: admin UI only (`{admin}/api-tokens`, page `Escalated/Admin/ApiTokens/Index`): name, `user_id` (validated integer: breaks UUID hosts), abilities, `expires_in_days` 1-365. Shown once. No artisan command.
- Rate limit: `ESCALATED_API_RATE_LIMIT` (60/min per token), `X-RateLimit-Limit/Remaining`, 429 `{message:"Too many requests.", retry_after}` + `Retry-After`.
- CORS: none, no OPTIONS route. An extension must call from its service worker/extension pages with host permission (skips CORS), never from content scripts.
- Errors: 422 `{message, errors:{field:[msgs]}}`; policy 403 `This action is unauthorized.`; permission 403 `You do not have the required permission: X`.
- Pagination: `{data, meta{current_page,last_page,per_page,total}}`, `page`, `per_page` default 15, >100 = 422.

| # | Method | Path | Ability | Request | Response |
|---|---|---|---|---|---|
| E1 | POST | /auth/validate | agent | | `{user{id,name,email}, abilities, is_agent, is_admin, token_name, expires_at}` |
| E2 | GET | /dashboard | agent | | `{stats{open,my_assigned,unassigned,sla_breached,resolved_today}, recent_tickets[10], needs_attention{sla_breaching,unassigned_urgent}, my_performance}` |
| E3 | GET | /tickets | agent | status, priority, ticket_type, assigned_to, unassigned, department_id, account_type+account_id, search, sla_breached, tag_ids[], sort_by, sort_dir, per_page, page, following | `{data:[{id,reference,ticket_type,account?,subject,status,status_label,priority,priority_label,requester{name,email},assignee{id,name}|null,department{id,name}|null,sla_breached,last_reply_at,created_at,updated_at}], meta}` |
| E4 | POST | /tickets | agent | subject, description; priority, ticket_type, department_id, tags[], external_reference, metadata, requester, subjects[] | 201 `{data, message}` |
| E5 | GET | /tickets/{ref} | agent | | `{data:{... requester{kind,id,name,email}, assignee, department, tags, subjects, replies[latest first, attachments], activities[20], sla{...}, custom_actions, resolved_at, closed_at}}` |
| E6/E7 | GET/PUT | /tickets/{ref}/subjects | agent | `subjects[]` full replace | `{data:[{link_id,type,id,role,position,title,subtitle,url,color,icon,missing}]}` |
| E8 | POST | /tickets/{ref}/reply | agent | body, is_internal_note | 201 `{data{id,body,is_internal_note,author,created_at}, message}` |
| E9 | PATCH | /tickets/{ref}/status | agent | status | `{message, status}` |
| E10 | PATCH | /tickets/{ref}/priority | agent | priority | `{message, priority}` |
| E11 | POST | /tickets/{ref}/assign | agent | agent_id | `{message}` |
| E12 | POST | /tickets/{ref}/follow | agent | toggles | `{message, following}` |
| E13 | POST | /tickets/{ref}/macro | agent | macro_id | `{message}` |
| E14 | POST | /tickets/{ref}/actions/{action} | agent | payload | `{message, action}` |
| E15 | POST | /tickets/{ref}/tags | agent | tag_ids[] full sync | `{message}` |
| E16 | GET | /agents | agent | | `{data:[{id,name,email}]}` |
| E17 | GET | /departments | agent | | `{data:[{id,name,description,is_active}]}` |
| E18 | GET | /tags | agent | | `{data:[{id,name,color}]}` |
| E19 | GET | /canned-responses | agent | | `{data:[{id,title,body}]}` |
| E20 | GET | /macros | agent | | `{data:[{id,name,steps,order}]}` (bug: `steps` always null; other ports use `actions`) |
| E21 | GET | /realtime/config | agent | | reverb/pusher config or null |
| E22 | DELETE | /tickets/{ref} | admin | | `{message}` |
| E23 | GET | /reports/summary | admin | period | summary |
| E24 | GET | /reports/export/{type} | admin | format, period | JSON or CSV (unknown type = 500) |

Laravel issues: `following=1/0` both add requester = user (wrong); show never sets `is_following`/`followers_count`; no endpoint reference doc in `docs/` (only `docs/agent-ticket-api.md` for create fields/subjects).

## Per backend

| Backend | Overall | Key differences |
|---|---|---|
| adonis | nearly complete | no E6/E7/E23/E24; `page` ignored (always page 1); assignee, reply author, activity causer always null; same `following` bug |
| rails | gaps | no subjects/reports; macro path `apply_macro`; meta `total_pages`, default 25, no cap; token abilities and owner staff status never checked; DELETE not admin-only |
| django | gaps | create `POST tickets/create/`, delete `tickets/<ref>/delete/`, trailing slashes; subjects attach/detach; no reports; token middleware not installed by the package, no path scoping; no ability/staff checks; 422 errors are strings |
| wordpress | gaps, other envelope | `/wp-json/escalated/v1`; `{items,total,...}`; WP_Error shape; rate limit answers 401, counted twice (~30/min); **critical security bug below** |
| phoenix | gaps | only list/show/create/reply/status/priority/assign/actions + public departments/tags; `{error}`; no pagination/rate limit; needs `api_enabled` + `api_tokens_enabled` |
| symfony | gaps | always on; list/show/create/PATCH/POST status/actions/subjects/rating only; no reply, assign, tags, follow, resources, dashboard, validate; no rate limit; serializer groups may drop base fields (needs a test) |
| go | largely different | `/escalated/api` (no v1); numeric ids; integer status/priority; `{tickets,total}` limit/offset; writes via PATCH; no rate limit |
| spring | other API | `/escalated/api/{agent,admin}` JSON, numeric ids, Spring `Page`; no `/support/api/v1` |
| nestjs | none | only `escalated/api/v1/auth/*` host callbacks and mobile guest; `ApiTokenGuard` exported but host-applied |
| dotnet | none | only `support/api/v1/auth/*` and mobile guest; `ApiTokenAuthMiddleware` host-wired, no ability checks |

Token issuance: admin UI everywhere (WordPress also password `auth/login`). Default on: Symfony, WordPress, Spring yes; Go routes yes but tokens off; others off.

## Security problems found (code reading; WordPress, Rails, Django, Laravel confirmed by reading, Symfony needs a test)

1. **WordPress (critical):** `POST /wp-json/escalated/v1/auth/login` issues a `*` token to any WP user with a valid password. With default `visibility=all` the staff check is skipped, so a subscriber can read every ticket and delete tickets.
2. **Rails, Django:** any token, whatever its abilities or owner, can DELETE tickets.
3. **Laravel:** a staff `*` token can be swapped at `POST support/api/v1/mobile/auth/refresh` for a new `*` token with `token_expiry_days` expiry (default null = never), bypassing the admin-set expiry.
4. **Laravel, Adonis:** `following` filter returns the agent's requested tickets instead of followed ones.
5. **Symfony:** API serializer groups may omit base fields (unverified).

## Mobile API (Laravel `routes/mobile-api.php`)

`support/api/v1/mobile`, loads with the staff API unless `ESCALATED_MOBILE_API=false`. Public `auth/login|register`, departments, kb, guest; `customer`-token tickets. Staff `*` tokens pass the `customer` check (see security item 3).
