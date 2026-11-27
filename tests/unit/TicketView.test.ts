// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import TicketView from '../../src/sidepanel/views/TicketView.vue'
import App from '../../src/sidepanel/App.vue'
import ConnectView from '../../src/sidepanel/views/ConnectView.vue'
import { router, showQueue } from '../../src/sidepanel/router'
import { getChromeFake } from '../setup/chrome'
import type { Session, Ticket } from '../../src/api/client'

const FULL = ['macros', 'tickets.macro', 'canned_responses']
const TEMPLATE = 'https://help.test/support/tickets/{reference}'

const session = (features: string[] = FULL, template: string | null = TEMPLATE): Session => ({
  origin: 'https://help.test',
  apiBase: 'https://help.test/support/api/v1',
  token: 't',
  user: { id: 7, name: 'Ada', email: 'ada@help.test' },
  meta: { api_version: '1.0', backend: 'laravel', features, connect_url: null, web_url_template: template },
})

const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

const makeTicket = (over: Partial<Ticket> = {}): Ticket =>
  ({
    id: 1,
    reference: 'ESC-1',
    ticket_type: 'question',
    subject: 'Cannot log in',
    description: 'desc',
    status: 'open',
    status_label: 'Open',
    priority: 'high',
    priority_label: 'High',
    channel: 'email',
    metadata: [],
    external_reference: null,
    requester: { kind: 'user', id: 3, name: 'Grace Hopper', email: 'grace@x.test' },
    assignee: { id: 8, name: 'Linus', email: null },
    department: { id: 2, name: 'Billing' },
    sla_breached: false,
    tags: [],
    replies: [
      {
        id: 3,
        body: 'Newest <b>reply</b>\nsecond line',
        is_internal_note: false,
        is_pinned: false,
        author: { id: 7, name: 'Ada' },
        created_at: iso(-5),
      },
      {
        id: 2,
        body: 'Secret note',
        is_internal_note: true,
        is_pinned: false,
        author: { id: 8, name: 'Linus' },
        created_at: iso(-60),
      },
      {
        id: 1,
        body: 'Oldest',
        is_internal_note: false,
        is_pinned: false,
        author: null,
        created_at: iso(-600),
      },
    ],
    activities: [],
    sla: {
      first_response_due_at: iso(120),
      first_response_at: null,
      first_response_breached: false,
      resolution_due_at: iso(-30),
      resolution_breached: true,
    },
    is_following: false,
    followers_count: 0,
    custom_actions: [],
    resolved_at: null,
    closed_at: null,
    last_reply_at: iso(-5),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }) as unknown as Ticket

const ok = (data: unknown) => ({ ok: true, data })
const fail = (status: number, message: string, errors?: Record<string, string[]>) => ({
  ok: false,
  error: { status, message, ...(errors ? { errors } : {}) },
})

type Handler = (...args: unknown[]) => unknown
let sendMessage: ReturnType<typeof vi.fn>
let handlers: Record<string, Handler>
let scrolled: Element[]

const calls = (name: string) =>
  sendMessage.mock.calls
    .map((c) => c[0] as { call: string; args: unknown[] })
    .filter((m) => m.call === name)
    .map((m) => m.args)

const AGENTS = [
  { id: 7, name: 'Ada', email: 'ada@help.test' },
  { id: 8, name: 'Linus', email: null },
]
const MACROS = [
  { id: 5, name: 'Close as solved', actions: [{ type: 'status', value: 'resolved' }], order: 0 },
]
const CANNED = [{ id: 1, title: 'Greeting', body: 'Hi there,' }]

beforeEach(() => {
  handlers = {
    getTicket: () => ok({ data: makeTicket() }),
    agents: () => ok({ data: AGENTS }),
    macros: () => ok({ data: MACROS }),
    cannedResponses: () => ok({ data: CANNED }),
    setStatus: () => ok({ message: 'Status updated.' }),
    setPriority: () => ok({ message: 'Priority updated.' }),
    assign: () => ok({ message: 'Ticket assigned.' }),
    applyMacro: () => ok({ message: 'Macro applied.' }),
  }
  sendMessage = getChromeFake().runtime.sendMessage as unknown as ReturnType<typeof vi.fn>
  sendMessage.mockImplementation(async (msg: { call: string; args: unknown[] }) => {
    const h = handlers[msg.call]
    return h ? h(...msg.args) : fail(500, `unhandled ${msg.call}`)
  })
  scrolled = []
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
  showQueue()
})
afterEach(() => {
  document.body.innerHTML = ''
})

async function open(s: Session = session(), reference = 'ESC-1') {
  const w = mount(TicketView, { props: { session: s, reference }, attachTo: document.body })
  await flushPromises()
  return w
}
const sel = (w: Awaited<ReturnType<typeof open>>, css: string) =>
  (w.find(css).element as HTMLSelectElement).value

describe('TicketView header', () => {
  it('shows reference, subject, requester, status, priority, assignee, department and SLA times', async () => {
    const w = await open()
    expect(calls('getTicket')[0]).toEqual(['ESC-1'])
    const head = w.find('.head')
    expect(head.text()).toContain('#ESC-1 Cannot log in')
    expect(head.text()).toContain('Grace Hopper')
    expect(head.text()).toContain('grace@x.test')
    expect(head.text()).toContain('Billing')
    expect(sel(w, 'select.status')).toBe('open')
    expect(sel(w, 'select.priority')).toBe('high')
    expect(sel(w, 'select.assignee')).toBe('8')
    expect(head.text()).toContain('First response due in 2 hr.')
    expect(head.text()).toContain('Resolution due 30 min. ago')
    expect(head.find('.sla-breach').text()).toContain('Resolution due')
  })

  it('links to the helpdesk with the reference encoded, and hides the link without a template', async () => {
    const w = await open(session(FULL, TEMPLATE), 'ESC/1 x')
    const a = w.find('a.helpdesk')
    expect(a.attributes('href')).toBe('https://help.test/support/tickets/ESC%2F1%20x')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toBe('noopener')
    expect(a.text()).toBe('Open in helpdesk')
    const w2 = await open(session(FULL, null))
    expect(w2.find('a.helpdesk').exists()).toBe(false)
  })

  it('emits back', async () => {
    const w = await open()
    await w.find('button.back').trigger('click')
    expect(w.emitted('back')).toHaveLength(1)
  })

  it('shows an error with retry when the ticket cannot load', async () => {
    handlers.getTicket = () => fail(404, 'Not found')
    const w = await open()
    expect(w.find('[role=alert]').text()).toContain('Not found')
    handlers.getTicket = () => ok({ data: makeTicket() })
    await w.find('button.retry').trigger('click')
    await flushPromises()
    expect(w.find('.head').text()).toContain('#ESC-1')
  })
})

describe('Thread', () => {
  it('lists oldest to newest, marks internal notes and scrolls to the newest', async () => {
    const w = await open()
    const items = w.findAll('.message')
    expect(items.map((i) => i.find('.body').text())).toEqual([
      'Oldest',
      'Secret note',
      'Newest <b>reply</b>\nsecond line',
    ])
    expect(items[1]!.classes()).toContain('note')
    expect(items[1]!.text()).toContain('Internal note')
    expect(items[0]!.text()).not.toContain('Internal note')
    expect(items[0]!.find('.author').text()).toBe('Grace Hopper')
    expect(items[2]!.find('.author').text()).toBe('Ada')
    expect(items[2]!.find('time').text()).toBe('5 min. ago')
    expect(scrolled.at(-1)).toBe(items[2]!.element)
  })

  it('renders bodies as text, never as markup', async () => {
    const w = await open()
    const body = w.findAll('.message')[2]!.find('.body')
    expect(body.find('b').exists()).toBe(false)
    expect(body.element.textContent).toBe('Newest <b>reply</b>\nsecond line')
    expect(body.classes()).toContain('body')
  })

  it('scrolls again when a newer reply arrives after a send', async () => {
    const w = await open()
    scrolled = []
    const t = makeTicket()
    t.replies = [
      {
        id: 4,
        body: 'Fresh',
        is_internal_note: false,
        is_pinned: false,
        author: { id: 7, name: 'Ada' },
        created_at: iso(0),
      },
      ...t.replies!,
    ] as Ticket['replies']
    handlers.getTicket = () => ok({ data: t })
    handlers.reply = () => ok({ data: { id: 4 }, message: 'Reply sent.' })
    await w.find('textarea').setValue('Fresh')
    await w.find('button.send').trigger('click')
    await flushPromises()
    expect(calls('getTicket')).toHaveLength(2)
    expect(w.findAll('.message').at(-1)!.text()).toContain('Fresh')
    expect(scrolled.at(-1)).toBe(w.findAll('.message').at(-1)!.element)
  })
})

describe('triage', () => {
  it('changes the status then refetches the ticket', async () => {
    const w = await open()
    await w.find('select.status').setValue('resolved')
    await flushPromises()
    expect(calls('setStatus')).toEqual([['ESC-1', 'resolved']])
    expect(calls('getTicket')).toHaveLength(2)
  })

  it('shows a refused transition inline and keeps the old value', async () => {
    handlers.setStatus = () =>
      fail(422, 'Cannot change status.', { status: ['Cannot change status from open to reopened.'] })
    const w = await open()
    await w.find('select.status').setValue('reopened')
    await flushPromises()
    expect(w.find('.triage .status-error').text()).toBe('Cannot change status from open to reopened.')
    expect(sel(w, 'select.status')).toBe('open')
    expect(calls('getTicket')).toHaveLength(1)
  })

  it('does not send the status the ticket already has', async () => {
    const w = await open()
    await w.find('select.status').setValue('open')
    await flushPromises()
    expect(calls('setStatus')).toHaveLength(0)
  })

  it('changes the priority', async () => {
    const w = await open()
    await w.find('select.priority').setValue('urgent')
    await flushPromises()
    expect(calls('setPriority')).toEqual([['ESC-1', 'urgent']])
    expect(calls('getTicket')).toHaveLength(2)
  })

  it('assigns to me in one click and hides the button when already mine', async () => {
    const w = await open()
    await w.find('button.assign-me').trigger('click')
    await flushPromises()
    expect(calls('assign')).toEqual([['ESC-1', 7]])
    expect(calls('getTicket')).toHaveLength(2)

    handlers.getTicket = () => ok({ data: makeTicket({ assignee: { id: 7, name: 'Ada', email: null } }) })
    const mine = await open()
    expect(mine.find('button.assign-me').exists()).toBe(false)
  })

  it('lists agents in the assignee picker without an Unassigned choice', async () => {
    handlers.getTicket = () => ok({ data: makeTicket({ assignee: null }) })
    const w = await open()
    const options = w.findAll('select.assignee option:not([disabled])').map((o) => o.text())
    expect(options).toEqual(['Ada', 'Linus'])
    expect(w.find('select.assignee').text().toLowerCase()).not.toContain('unassigned')
    await w.find('select.assignee').setValue('8')
    await flushPromises()
    expect(calls('assign')).toEqual([['ESC-1', 8]])
  })

  it('shows a failure message for priority and keeps the old value', async () => {
    handlers.setPriority = () => fail(403, 'This action is unauthorized.')
    const w = await open()
    await w.find('select.priority').setValue('low')
    await flushPromises()
    expect(w.find('.triage .action-error').text()).toBe('This action is unauthorized.')
    expect(sel(w, 'select.priority')).toBe('high')
  })

  it('ignores a late refetch response that was superseded', async () => {
    const releases: ((v: unknown) => void)[] = []
    const w = await open()
    handlers.getTicket = () => new Promise((r) => releases.push(r))
    await w.find('select.priority').setValue('urgent')
    await flushPromises()
    await w.find('select.priority').setValue('low')
    await flushPromises()
    expect(releases).toHaveLength(2)
    releases[1]!(ok({ data: makeTicket({ priority: 'low', priority_label: 'Low' }) }))
    await flushPromises()
    releases[0]!(ok({ data: makeTicket({ priority: 'urgent', priority_label: 'Urgent' }) }))
    await flushPromises()
    expect(sel(w, 'select.priority')).toBe('low')
  })
})

describe('macros and canned responses', () => {
  it('hides the macro picker unless both features are present', async () => {
    for (const features of [[], ['macros'], ['tickets.macro'], ['canned_responses']]) {
      const w = await open(session(features))
      expect(w.find('select.macro').exists()).toBe(false)
    }
    expect(calls('macros')).toHaveLength(0)
    const w = await open(session(['macros', 'tickets.macro']))
    expect(w.find('select.macro').exists()).toBe(true)
  })

  it('hides the canned picker without the canned_responses feature', async () => {
    const w = await open(session(['macros', 'tickets.macro']))
    expect(w.find('select.canned').exists()).toBe(false)
    const w2 = await open(session(FULL))
    expect(w2.find('select.canned').exists()).toBe(true)
  })

  it('asks for confirmation before applying a macro, then refetches', async () => {
    const w = await open()
    await w.find('select.macro').setValue('5')
    expect(calls('applyMacro')).toHaveLength(0)
    expect(w.find('.macro-confirm').text()).toContain('Close as solved')
    expect(w.find('.macro-confirm').text()).toContain('change the status or send replies')
    await w.find('button.macro-yes').trigger('click')
    await flushPromises()
    expect(calls('applyMacro')).toEqual([['ESC-1', 5]])
    expect(calls('getTicket')).toHaveLength(2)
    expect(w.find('.macro-confirm').exists()).toBe(false)
  })

  it('does nothing when the macro confirmation is cancelled', async () => {
    const w = await open()
    await w.find('select.macro').setValue('5')
    await w.find('button.macro-no').trigger('click')
    expect(w.find('.macro-confirm').exists()).toBe(false)
    expect(calls('applyMacro')).toHaveLength(0)
  })

  it('shows the API message when a macro fails', async () => {
    handlers.applyMacro = () => fail(404, 'Macro not found.')
    const w = await open()
    await w.find('select.macro').setValue('5')
    await w.find('button.macro-yes').trigger('click')
    await flushPromises()
    expect(w.find('.macro-error').text()).toBe('Macro not found.')
  })
})

describe('refresh failures', () => {
  it('shows a small inline notice with retry when a refetch fails while a ticket is shown', async () => {
    const w = await open()
    handlers.getTicket = () => fail(500, 'boom')
    await w.find('select.macro').setValue('5')
    await w.find('button.macro-yes').trigger('click')
    await flushPromises()
    expect(w.find('.head').exists()).toBe(true)
    expect(w.find('.refresh-error').text()).toContain("Couldn't refresh this ticket.")
    handlers.getTicket = () => ok({ data: makeTicket({ subject: 'Fresh subject' }) })
    await w.find('button.refresh-retry').trigger('click')
    await flushPromises()
    expect(w.find('.refresh-error').exists()).toBe(false)
    expect(w.find('.head').text()).toContain('Fresh subject')
  })
})

describe('macro names', () => {
  it('shows names with replacement patterns literally in the confirmation', async () => {
    handlers.macros = () => ok({ data: [{ id: 9, name: "Tidy $& and $' up", actions: [], order: 0 }] })
    const w = await open()
    await w.find('select.macro').setValue('9')
    expect(w.find('.macro-confirm').text()).toContain('Apply "Tidy $& and $\' up"?')
  })
})

describe('App integration', () => {
  const storeSession = () => getChromeFake().storage.local.set({ session: session() })

  it('keeps a notification consumed while disconnected and opens it after connecting', async () => {
    await getChromeFake().storage.session.set({ pendingOpen: { reference: 'ESC-7', at: Date.now() } })
    const w = mount(App)
    await flushPromises()
    expect(w.findComponent(ConnectView).exists()).toBe(true)
    expect(router.currentReference).toBe('ESC-7')
    w.findComponent(ConnectView).vm.$emit('connected', session())
    await flushPromises()
    expect(router.view).toBe('ticket')
    expect(calls('getTicket')[0]).toEqual(['ESC-7'])
    expect(w.find('.head').exists()).toBe(true)
  })

  it('still goes to the queue after a plain connect', async () => {
    const w = mount(App)
    await flushPromises()
    w.findComponent(ConnectView).vm.$emit('connected', session())
    await flushPromises()
    expect(router.view).toBe('queue')
  })

  it('returns to the queue keeping its tab and search', async () => {
    handlers.listTickets = () =>
      ok({ data: [], meta: { current_page: 1, last_page: 1, per_page: 25, total: 0 } })
    await storeSession()
    const w = mount(App, { attachTo: document.body })
    await flushPromises()
    await w.findAll('button.tab')[1]!.trigger('click')
    await w.find('input[type=search]').setValue('refund')
    await new Promise((r) => setTimeout(r, 350))
    await flushPromises()
    router.currentReference = 'ESC-1'
    router.view = 'ticket'
    await flushPromises()
    expect(w.find('.head').exists()).toBe(true)
    await w.find('button.back').trigger('click')
    await flushPromises()
    expect(router.view).toBe('queue')
    expect(w.findAll('button.tab')[1]!.attributes('aria-current')).toBe('true')
    expect((w.find('input[type=search]').element as HTMLInputElement).value).toBe('refund')
  })
})
