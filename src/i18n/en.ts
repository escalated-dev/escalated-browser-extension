import type { ConnectErrorCode } from '../auth/connect'

export const en = {
  connect: {
    title: 'Connect to your helpdesk',
    reconnectNotice: 'Your session ended. Sign in again.',
    addressLabel: 'Helpdesk address',
    addressPlaceholder: 'support.example.com',
    submit: 'Connect',
    submitReconnect: 'Reconnect',
    connecting: 'Connecting...',
    advanced: 'Advanced',
    apiPathLabel: 'API path',
    apiPathHint: 'Only needed if discovery fails, for example /support/api/v1',
    tokenLabel: 'API token',
    tokenHint: 'Paste a token to skip sign-in.',
  },
  connectErrors: {
    permission_denied: 'Chrome access to that site was not allowed.',
    not_found: 'No Escalated API found at that address. Ask your admin to turn on the API.',
    unreachable: 'Could not reach that address. Check it and your connection.',
    invalid_address: "That doesn't look like a web address.",
    needs_manual_token:
      'This helpdesk does not support sign-in from the extension yet. Paste an API token under Advanced.',
    denied: 'Sign-in was cancelled.',
    state_mismatch: "Sign-in didn't finish. Try again.",
    connect_failed: "Sign-in didn't finish. Try again.",
    invalid_token: "That token wasn't accepted.",
  } satisfies Record<ConnectErrorCode, string>,
  genericError: 'Something went wrong. Try again.',
  header: {
    disconnect: 'Disconnect',
    confirm: 'Disconnect from this helpdesk?',
    confirmYes: 'Disconnect',
    confirmNo: 'Cancel',
    notEncrypted: 'Not encrypted',
  },
  queue: {
    tabsLabel: 'Ticket queues',
    mine: 'Mine',
    unassigned: 'Unassigned',
    open: 'All open',
    searchLabel: 'Search tickets',
    searchPlaceholder: 'Search tickets',
    loading: 'Loading...',
    loadMore: 'Load more',
    retry: 'Try again',
    loadError: 'Could not load tickets.',
    emptyMine: 'Nothing is assigned to you.',
    emptyUnassigned: 'No unassigned tickets.',
    emptyOpen: 'No open tickets.',
    emptySearch: 'No tickets match your search.',
    noRequester: 'Unknown requester',
    slaBreached: 'SLA breached',
    noActivity: 'No activity yet',
  },
  ticket: {
    back: 'Back to queue',
  },
} as const

export function connectErrorMessage(code: unknown): string {
  if (typeof code === 'string' && code in en.connectErrors) {
    return en.connectErrors[code as ConnectErrorCode]
  }
  return en.genericError
}
