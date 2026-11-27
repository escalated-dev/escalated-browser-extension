# Escalated browser extension

Answer Escalated tickets from any tab. A Chrome side panel for agents: your queue, the conversation, replies and notes, canned responses, macros, and alerts when a ticket is assigned to you or a customer replies.

It talks only to the helpdesk you connect, using its staff API. Nothing else is sent anywhere. See [the privacy page](docs/privacy.md).

## Install

Until the Chrome Web Store listing is live:

- From a release: download `escalated-browser-extension-<version>.zip` from the [releases page](https://github.com/escalated-dev/escalated-browser-extension/releases), unzip it, open `chrome://extensions`, turn on Developer mode and choose Load unpacked.
- From source: `npm ci && npm run build`, then load the `dist/` folder the same way. See [development](docs/development.md).

Needs Chrome 116 or later and an Escalated install with the staff API turned on.

## Connect

Click the toolbar icon to open the side panel, enter your helpdesk address and choose Connect. Chrome asks for access to that address, then opens your helpdesk's sign-in page. Approve the connection there. If your helpdesk cannot sign in from the extension, paste an API token under Advanced.

To leave, choose Disconnect in the panel header. It asks the helpdesk to revoke the token, deletes everything the extension stored, and then gives up access to the helpdesk address.

## Docs

- [Privacy](docs/privacy.md)
- [Development, tests and releasing](docs/development.md)
- [Store listing text](docs/store-listing.md)

## License

MIT
