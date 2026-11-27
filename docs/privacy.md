# Privacy

Escalated for Chrome is a side panel for helpdesk agents. This page says what it does with your data.

## Where your data goes

- The extension talks only to the helpdesk you connect it to. It sends requests to that helpdesk's staff API and to nothing else.
- There is no analytics, tracking, advertising or error reporting. No third party receives anything.
- There is no server run by the extension's authors. Nothing passes through us.

## What is stored, and where

- When you connect, the extension keeps your access token, your name and email, and the helpdesk address in the browser's local extension storage on this device.
- That storage is not synced. The token does not leave this browser profile, and it is never put in a URL or written to a log.
- Short reply drafts are kept in session storage and are cleared when the browser closes.
- Your queue and tickets are fetched when needed. Beyond that, only ticket references and timestamps are kept, so notifications can spot new work.

## Page content

The extension does not read web pages. The one exception is the right-click item "Create Escalated ticket". When you choose it, the extension reads the selected text, the page title and the page address, and puts them into the new ticket form. This capture is held in the browser's session storage until the create form opens or the browser closes, whichever is first. It goes to your helpdesk only if you press the button to create the ticket.

## Data disclosure

For the store's data disclosure: ticket content (including anything you type into a reply or a new ticket) and the agent's identity (name and email) go only to the helpdesk you connect, and nowhere else.

## Permissions

The extension asks Chrome for access to your helpdesk's address only, at the moment you connect. It has no access to other sites.

## Disconnect and revoke

Choose Disconnect in the panel header. The extension asks the helpdesk to revoke its token, deletes everything it stored, and gives up its access to the helpdesk address. You can also revoke the token from your helpdesk, on the browser extensions page of your agent account, or ask your admin to remove it.

Removing the extension from Chrome deletes its stored data as well. If you remove it without disconnecting, revoke the token from your helpdesk.

## Contact

Questions about this page: open an issue at https://github.com/escalated-dev/escalated-browser-extension/issues.
