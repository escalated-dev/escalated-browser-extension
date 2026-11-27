# Privacy

Escalated for Chrome is a side panel for helpdesk agents. This page says what it does with your data.

## Where your data goes

- The extension talks only to the helpdesk you connect it to. It sends requests to that helpdesk's staff API and to nothing else.
- There is no analytics, tracking, advertising or error reporting. No third party receives anything.
- There is no server run by the extension's authors. Nothing passes through us.

## What is stored, and where

In the browser's local extension storage, on this device:

- your access token, your name and email, the helpdesk address, and what the helpdesk says about itself (which features it supports, the link pattern for its ticket pages);
- for notifications: the reference of each ticket the extension has seen assigned to you or unassigned, and when it last saw it (at most 2,000 entries); which alerts it has already shown, kept for 24 hours; and when it last checked.

That storage is not synced. The token does not leave this browser profile, and it is never put in a URL or written to a log.

In the browser's session storage, which Chrome empties when the browser closes: reply drafts, a ticket you clicked in a notification before the panel opened, and the right-click capture described below.

In the side panel's own page storage: the address of the last helpdesk you connected, so the form is filled in if your session ends and you need to reconnect.

Your queue and tickets are fetched when needed and not kept.

## Page content

The extension does not read web pages. The one exception is the right-click item "Create Escalated ticket". When you choose it, the extension reads the selected text, the page title and the page address, and puts them into the new ticket form. This capture is held in the browser's session storage until the create form opens or the browser closes, whichever is first. It goes to your helpdesk only if you press the button to create the ticket.

## Data disclosure

For the store's data disclosure:

- Collected: personally identifiable information (the agent's name and email), authentication information (the access token), personal communications (ticket messages you read and write), and website content (only the selected text, title and address of a page, when you use the right-click item).
- Not collected: health, financial or payment information, location, web history, and user activity such as clicks or keystrokes.
- All of it goes only to the helpdesk you connect. It is not sold, not transferred to third parties, not used for anything other than the extension's single purpose, and not used to determine creditworthiness or for lending.

## Permissions

Chrome asks you to allow access to your helpdesk's address when you choose Connect. The extension asks only for the one address you typed. After a successful connect it gives up access to any other site address it was allowed before, so only the connected helpdesk remains. It has no access to other sites.

## Disconnect and revoke

Choose Disconnect in the panel header. The extension:

1. asks the helpdesk to revoke its token, while it still has access to the helpdesk address;
2. deletes everything in its local storage and session storage, and the remembered helpdesk address;
3. once the helpdesk has answered, or after five seconds, gives up its access to the helpdesk address.

If the helpdesk could not be reached, the token may still be valid there. You can always revoke it from your helpdesk, on the browser extensions page of your agent account, or ask your admin to remove it.

When the helpdesk rejects the token (for example, you revoked it there), the extension deletes the token and everything in its local storage, shows a red "!" on its icon and asks you to reconnect. The remembered address is kept so you do not have to type it again.

Removing the extension from Chrome deletes its stored data as well. If you remove it without disconnecting, revoke the token from your helpdesk.

## Contact

Questions about this page: open an issue at https://github.com/escalated-dev/escalated-browser-extension/issues.
