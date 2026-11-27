# Chrome Web Store listing

Text for the store submission form. Keep it in step with `public/manifest.json` and [privacy](privacy.md).

## Single purpose

Escalated for Chrome lets helpdesk agents work their Escalated ticket queue from a side panel in any tab: see their queue, read and answer tickets, triage them, and get a notification when a ticket is assigned to them or a customer replies.

## Permission justifications

| Permission | Why |
|---|---|
| `sidePanel` | The whole interface is a side panel, opened from the toolbar button. |
| `storage` | Keeps the access token, the agent's name and email, the helpdesk address and notification state in local extension storage, and reply drafts in session storage. |
| `alarms` | Checks the helpdesk once a minute for new assignments and customer replies, and for the badge count. |
| `notifications` | Shows "Assigned to you" and "Customer replied" alerts. Clicking one opens the ticket. |
| `contextMenus` | Adds the right-click item "Create Escalated ticket", which fills the new ticket form from the selected text, page title and page address. |
| `identity` | Signs in through the helpdesk's own sign-in page with `launchWebAuthFlow`, so the agent never types a password into the extension. |
| `https://*/*` and `http://*/*` (optional host permissions) | Only the one origin the user types, requested when they click Connect. Helpdesks are self-hosted, so the address is not known in advance. After a connect, every other granted origin is removed; Disconnect removes the connected one. `http://` is for helpdesks on a local network, and the panel marks such a connection "Not encrypted". |

The extension has no content scripts and does not use `scripting`, `tabs` or `host_permissions`. All code ships in the package; nothing is loaded from the network.

## Data disclosure answers

These match [privacy](privacy.md).

| Question | Answer |
|---|---|
| Personally identifiable information | Yes: the agent's name and email, from the connected helpdesk |
| Health information | No |
| Financial and payment information | No |
| Authentication information | Yes: the helpdesk access token |
| Personal communications | Yes: ticket messages the agent reads and writes |
| Location | No |
| Web history | No |
| User activity | No |
| Website content | Yes: the selected text, title and address of a page, only when the agent uses the right-click item |

Certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases. (The data goes only to the helpdesk the user connects.)
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL: the published copy of `docs/privacy.md`.
