// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import QueueView from '../../src/sidepanel/views/QueueView.vue'
import App from '../../src/sidepanel/App.vue'
import { router, showQueue } from '../../src/sidepanel/router'
import { relativeTime } from '../../src/sidepanel/time'
import { getChromeFake } from '../setup/chrome'
import type { Session, TicketListItem } from '../../src/api/client'

const session: Session = {
  origin: 'https://help.test',
  apiBase: 'https://help.test/support/api/v1',
  token: 't',
  user: { id: 7, name: 'Ada', email: 'ada@help.test' },
  meta: { api_version: '1.0', backend: 'laravel', features: [], connect_url: null, web_url_template: null },
}

const ticket = (n: number, over: Partial<TicketListItem> = {}): TicketListItem =>
  ({
    id: n,
    reference: `ESC-${n}`,
    ticket_type: 'question',
    subject: `Subject ${n}`,
    status: 'open',
    status_label: 'Open',
    priority: 'high',
    priority_label: 'High',
    requester: { name: 'Grace', email: 'g@x.test' },
    assignee: null,
    department: null,
    sla_breached: false,
    last_reply_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    last_customer_reply_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }) as TicketListItem

type Page = { data: TicketListItem[]; current_page?: number; last_page?: number }
const page = (p: Page) => ({
  ok: true,
  data: {
    data: p.data,
    meta: {
      current_page: p.current_page ?? 1,
      last_page: p.last_page ?? 1,
      per_page: 25,
      total: p.data.length,
    },
  },
})

let sendMessage: ReturnType<typeof vi.fn>
const listArgs = () =>
  sendMessage.mock.calls.map((c) => (c[0] as { args: unknown[] }).args[0] as Record<string, unknown>)

beforeEach(() => {
  sendMessage = getChromeFake().runtime.sendMessage as unknown as ReturnType<typeof vi.fn>
  sendMessage.mockResolvedValue(page({ data: [] }))
  showQueue()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('QueueView', () => {
  it('loads Mine by default and maps tabs to queries', async () => {
    const w = mount(QueueView, { props: { session } })
    await flushPromises()
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({ type: 'api', call: 'listTickets' })
    expect(listArgs()[0]).toEqual({ assigned_to: 7, page: 1 })

    const tabs = w.findAll('button.tab')
    expect(tabs.map((t) => t.text())).toEqual(['Mine', 'Unassigned', 'All open'])
    expect(tabs[0]!.attributes('aria-current')).toBe('true')

    await tabs[1]!.trigger('click')
    await flushPromises()
    expect(listArgs()[1]).toEqual({ unassigned: true, page: 1 })
    expect(w.findAll('button.tab')[1]!.attributes('aria-current')).toBe('true')
    expect(w.findAll('button.tab')[0]!.attributes('aria-current')).toBeUndefined()

    await tabs[2]!.trigger('click')
    await flushPromises()
    expect(listArgs()[2]).toEqual({ status: 'open', page: 1 })
  })

  it('shows reference, subject, requester, priority, SLA dot and relative time', async () => {
    sendMessage.mockResolvedValue(
      page({
        data: [
          ticket(1, { sla_breached: true }),
          ticket(2, { requester: { name: null, email: 'e@x.test' } }),
        ],
      }),
    )
    const w = mount(QueueView, { props: { session } })
    await flushPromises()
    const rows = w.findAll('button.row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('#ESC-1')
    expect(rows[0]!.text()).toContain('Subject 1')
    expect(rows[0]!.text()).toContain('Grace')
    expect(rows[0]!.text()).toContain('High')
    expect(rows[0]!.text()).toContain('5 min. ago')
    expect(rows[0]!.find('.sla').attributes('aria-label')).toBe('SLA breached')
    expect(rows[1]!.find('.sla').exists()).toBe(false)
    expect(rows[1]!.text()).toContain('e@x.test')
  })

  it('emits open with the reference when a row is clicked', async () => {
    sendMessage.mockResolvedValue(page({ data: [ticket(3)] }))
    const w = mount(QueueView, { props: { session } })
    await flushPromises()
    await w.find('button.row').trigger('click')
    expect(w.emitted('open')).toEqual([['ESC-3']])
  })

  it.each([
    [0, 'Nothing is assigned to you.'],
    [1, 'No unassigned tickets.'],
    [2, 'No open tickets.'],
  ])('shows the empty state for tab %i', async (i, copy) => {
    const w = mount(QueueView, { props: { session } })
    await flushPromises()
    await w.findAll('button.tab')[i]!.trigger('click')
    await flushPromises()
    expect(w.find('.state').text()).toBe(copy)
  })

  it('debounces search by 300 ms', async () => {
    vi.useFakeTimers()
    const w = mount(QueueView, { props: { session } })
    await flushPromises()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const input = w.find('input[type=search]')
    await input.setValue('re')
    await vi.advanceTimersByTimeAsync(200)
    await input.setValue('refund')
    await vi.advanceTimersByTimeAsync(299)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(listArgs()[1]).toEqual({ assigned_to: 7, search: 'refund', page: 1 })
    expect(w.find('.state').text()).toBe('No tickets match your search.')
  })

  it('offers Load more while current_page < last_page and appends the next page', async () => {
    sendMessage
      .mockResolvedValueOnce(page({ data: [ticket(1)], current_page: 1, last_page: 2 }))
      .mockResolvedValueOnce(page({ data: [ticket(2)], current_page: 2, last_page: 2 }))
    const w = mount(QueueView, { props: { session } })
    await flushPromises()
    const more = w.find('button.more')
    expect(more.text()).toBe('Load more')
    await more.trigger('click')
    await flushPromises()
    expect(listArgs()[1]).toEqual({ assigned_to: 7, page: 2 })
    expect(w.findAll('button.row')).toHaveLength(2)
    expect(w.find('button.more').exists()).toBe(false)
  })

  it('ignores a stale response after switching tabs', async () => {
    let release!: (v: unknown) => void
    sendMessage
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValueOnce(page({ data: [ticket(9)] }))
    const w = mount(QueueView, { props: { session } })
    await w.findAll('button.tab')[1]!.trigger('click')
    await flushPromises()
    release(page({ data: [ticket(1)] }))
    await flushPromises()
    expect(w.findAll('button.row')).toHaveLength(1)
    expect(w.find('button.row').text()).toContain('ESC-9')
  })

  it('shows an error with retry when the list fails', async () => {
    sendMessage
      .mockResolvedValueOnce({ ok: false, error: { status: 500, message: 'x' } })
      .mockResolvedValueOnce(page({ data: [ticket(1)] }))
    const w = mount(QueueView, { props: { session } })
    await flushPromises()
    expect(w.find('[role=alert]').text()).toContain('Could not load tickets.')
    await w.find('button.link').trigger('click')
    await flushPromises()
    expect(w.findAll('button.row')).toHaveLength(1)
  })
})

describe('QueueView status filter (E4)', () => {
  const withOpen: Session = {
    ...session,
    meta: { ...session.meta, features: ['tickets.open_filter'] },
  }

  it('with tickets.open_filter, every tab asks for open tickets by default', async () => {
    const w = mount(QueueView, { props: { session: withOpen } })
    await flushPromises()
    expect(listArgs()[0]).toEqual({ assigned_to: 7, open: true, page: 1 })
    const tabs = w.findAll('button.tab')
    await tabs[1]!.trigger('click')
    await flushPromises()
    expect(listArgs()[1]).toEqual({ unassigned: true, open: true, page: 1 })
    await tabs[2]!.trigger('click')
    await flushPromises()
    expect(listArgs()[2]).toEqual({ open: true, page: 1 })
    expect(w.find('select#queue-status option').text()).toBe('Any open status')
  })

  it('offers each contract status and filters by it instead of the open family', async () => {
    const w = mount(QueueView, { props: { session: withOpen } })
    await flushPromises()
    const select = w.find('select#queue-status')
    expect(select.findAll('option').map((o) => o.text())).toEqual([
      'Any open status',
      'Open',
      'In progress',
      'Waiting on customer',
      'Waiting on agent',
      'Escalated',
      'Resolved',
      'Closed',
      'Reopened',
      'Live',
    ])
    await select.setValue('resolved')
    await flushPromises()
    expect(listArgs().at(-1)).toEqual({ assigned_to: 7, status: 'resolved', page: 1 })
    expect(w.find('.state').text()).toBe('No tickets with that status.')
    await w.findAll('button.tab')[2]!.trigger('click')
    await flushPromises()
    expect(listArgs().at(-1)).toEqual({ status: 'resolved', page: 1 })
  })

  it('without the feature, keeps the old queries and says "Any status"', async () => {
    const w = mount(QueueView, { props: { session } })
    await flushPromises()
    expect(listArgs()[0]).toEqual({ assigned_to: 7, page: 1 })
    expect(w.find('select#queue-status option').text()).toBe('Any status')
    await w.find('select#queue-status').setValue('waiting_on_customer')
    await flushPromises()
    expect(listArgs().at(-1)).toEqual({ assigned_to: 7, status: 'waiting_on_customer', page: 1 })
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-06-01T12:00:00Z')
  it('formats past times', () => {
    expect(relativeTime('2026-06-01T11:55:00Z', now)).toBe('5 min. ago')
    expect(relativeTime('2026-06-01T09:00:00Z', now)).toBe('3 hr. ago')
    expect(relativeTime('2026-05-31T12:00:00Z', now)).toBe('yesterday')
    expect(relativeTime(null, now)).toBe('')
    expect(relativeTime('nonsense', now)).toBe('')
  })
})

describe('App', () => {
  const storeSession = () => getChromeFake().storage.local.set({ session })

  it('shows Reconnect when needsReconnect is set', async () => {
    await getChromeFake().storage.local.set({ needsReconnect: true })
    const w = mount(App)
    await flushPromises()
    expect(w.find('button[type=submit]').text()).toBe('Reconnect')
    expect(w.text()).toContain('Your session ended. Sign in again.')
  })

  it('shows the queue when connected', async () => {
    await storeSession()
    const w = mount(App)
    await flushPromises()
    expect(w.text()).toContain('help.test')
    expect(w.find('button.tab').exists()).toBe(true)
  })

  it('opens a ticket on the open-ticket message and answers ok', async () => {
    await storeSession()
    const w = mount(App)
    await flushPromises()
    const respond = vi.fn()
    getChromeFake().runtime.onMessage.emit(
      { type: 'open-ticket', reference: 'ESC-42' },
      { id: getChromeFake().runtime.id },
      respond,
    )
    await flushPromises()
    expect(respond).toHaveBeenCalledWith({ ok: true })
    expect(router.view).toBe('ticket')
    expect(router.currentReference).toBe('ESC-42')
    expect(w.find('button.back').exists()).toBe(true)
  })

  it('ignores open-ticket from other senders', async () => {
    await storeSession()
    mount(App)
    await flushPromises()
    const respond = vi.fn()
    getChromeFake().runtime.onMessage.emit({ type: 'open-ticket', reference: 'X' }, { id: 'other' }, respond)
    expect(respond).not.toHaveBeenCalled()
    expect(router.view).toBe('queue')
  })

  it('consumes a fresh pendingOpen on load and clears it', async () => {
    await storeSession()
    await getChromeFake().storage.session.set({
      pendingOpen: { reference: 'ESC-7', at: Date.now() - 30_000 },
    })
    mount(App)
    await flushPromises()
    expect(router.currentReference).toBe('ESC-7')
    expect(getChromeFake().storage.session.dump()).toEqual({})
  })

  it('discards a stale pendingOpen (2 minutes or older) but clears it', async () => {
    await storeSession()
    await getChromeFake().storage.session.set({
      pendingOpen: { reference: 'ESC-8', at: Date.now() - 121_000 },
    })
    mount(App)
    await flushPromises()
    expect(router.view).toBe('queue')
    expect(getChromeFake().storage.session.dump()).toEqual({})
  })

  it('opens a pendingOpen written while the panel is open', async () => {
    await storeSession()
    mount(App)
    await flushPromises()
    await getChromeFake().storage.session.set({ pendingOpen: { reference: 'ESC-9', at: Date.now() } })
    await flushPromises()
    expect(router.currentReference).toBe('ESC-9')
    expect(getChromeFake().storage.session.dump()).toEqual({})
  })
})

describe('App: worker state in the panel', () => {
  const storeSession = () => getChromeFake().storage.local.set({ session })
  afterEach(() => {
    try {
      localStorage.clear()
    } catch {
      // jsdom only
    }
  })

  it('asks the worker to re-read /meta when the panel opens connected (M10)', async () => {
    await storeSession()
    mount(App)
    await flushPromises()
    expect(sendMessage).toHaveBeenCalledWith({ type: 'refresh-meta' })
  })

  it('does not ask for /meta when signed out', async () => {
    mount(App)
    await flushPromises()
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'refresh-meta' })
  })

  it('shows the refusal banner while the worker reports a 403, and hides it after (M14)', async () => {
    await storeSession()
    await getChromeFake().storage.local.set({ 'poll.forbidden': true })
    const w = mount(App)
    await flushPromises()
    expect(w.find('.banner').text()).toBe('The helpdesk refused access. Reconnect or ask your admin.')
    await getChromeFake().storage.local.remove('poll.forbidden')
    await flushPromises()
    expect(w.find('.banner').exists()).toBe(false)
  })

  it('keeps the address for a reconnect after a 401 (E7)', async () => {
    await storeSession()
    const w = mount(App)
    await flushPromises()
    expect(localStorage.getItem('lastAddress')).toBe('https://help.test')
    // The worker's 401 path: session gone, reconnect flagged, the panel's localStorage untouched.
    await getChromeFake().storage.local.clear()
    await getChromeFake().storage.local.set({ needsReconnect: true })
    await flushPromises()
    expect((w.find('#address').element as HTMLInputElement).value).toBe('https://help.test')
  })

  it('an explicit Disconnect leaves the connect form empty (E7)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    await storeSession()
    const w = mount(App)
    await flushPromises()
    await w.find('button.quiet').trigger('click')
    await w.find('button.danger').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(w.find('#address').exists()).toBe(true))
    expect((w.find('#address').element as HTMLInputElement).value).toBe('')
    expect(localStorage.getItem('lastAddress')).toBeNull()
  })
})
