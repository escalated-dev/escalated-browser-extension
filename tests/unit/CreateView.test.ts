// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CreateView from '../../src/sidepanel/views/CreateView.vue'
import App from '../../src/sidepanel/App.vue'
import { router, showQueue } from '../../src/sidepanel/router'
import { getChromeFake } from '../setup/chrome'
import type { Session } from '../../src/api/client'

const session = (features = ['tickets.create']): Session =>
  ({
    origin: 'https://help.test',
    apiBase: 'https://help.test/support/api/v1',
    token: 't',
    user: { id: 7, name: 'Ada', email: 'ada@help.test' },
    meta: { api_version: '1.0', backend: 'x', features, connect_url: null, web_url_template: null },
  }) as unknown as Session

const ok = (data: unknown) => ({ ok: true, data })
const fail = (status: number, message: string, errors?: Record<string, string[]>) => ({
  ok: false,
  error: { status, message, ...(errors ? { errors } : {}) },
})

type Handler = (...args: unknown[]) => unknown
let handlers: Record<string, Handler>
let sendMessage: ReturnType<typeof vi.fn>
const calls = (name: string) =>
  sendMessage.mock.calls
    .map((c) => c[0] as { call: string; args: unknown[] })
    .filter((m) => m.call === name)
    .map((m) => m.args)

beforeEach(() => {
  handlers = {
    departments: () =>
      ok({
        data: [
          { id: 1, name: 'Billing', description: null, is_active: true },
          { id: 2, name: 'Old', description: null, is_active: false },
        ],
      }),
    createTicket: () => ok({ data: { reference: 'ESC-42' }, message: 'Ticket created.' }),
    listTickets: () => ok({ data: [], meta: { current_page: 1, last_page: 1, per_page: 25, total: 0 } }),
    getTicket: () => fail(404, 'Not found'),
  }
  sendMessage = getChromeFake().runtime.sendMessage as unknown as ReturnType<typeof vi.fn>
  sendMessage.mockImplementation(async (msg: { call: string; args: unknown[] }) => {
    const h = handlers[msg.call]
    return h ? h(...msg.args) : fail(500, `unhandled ${msg.call}`)
  })
  showQueue()
})
afterEach(() => {
  document.body.innerHTML = ''
})

type Prefill = { selection?: string; title?: string; url?: string }
async function open(prefill?: Prefill) {
  const w = mount(CreateView, { props: { session: session(), prefill }, attachTo: document.body })
  await flushPromises()
  return w
}
const val = (w: { find: (s: string) => { element: Element } }, css: string) =>
  (w.find(css).element as HTMLInputElement).value

describe('CreateView prefill', () => {
  it('fills subject from the title, description from selection then url, email empty', async () => {
    const w = await open({ selection: 'Checkout is broken', title: 'Pricing', url: 'https://shop.test/p' })
    expect(val(w, 'input.subject')).toBe('Pricing')
    expect(val(w, 'textarea.description')).toBe('Checkout is broken\n\nhttps://shop.test/p')
    expect(val(w, 'input.email')).toBe('')
  })

  it('uses just the url when there is no selection, and nothing when there is neither', async () => {
    expect(val(await open({ title: 'T', url: 'https://a.test/' }), 'textarea.description')).toBe(
      'https://a.test/',
    )
    expect(val(await open({ title: 'T' }), 'textarea.description')).toBe('')
    expect(val(await open(), 'input.subject')).toBe('')
  })

  it('trims the subject to 255 characters', async () => {
    const w = await open({ title: 'x'.repeat(400) })
    expect(val(w, 'input.subject')).toHaveLength(255)
  })

  it('lists active departments only, and hides the field when departments fail', async () => {
    const w = await open()
    const opts = w.findAll('select.department option').map((o) => o.text())
    expect(opts).toContain('Billing')
    expect(opts).not.toContain('Old')
    handlers.departments = () => fail(403, 'Forbidden')
    const w2 = await open()
    expect(w2.find('select.department').exists()).toBe(false)
  })
})

describe('CreateView submit', () => {
  async function fill(w: Awaited<ReturnType<typeof open>>, email = 'cust@x.test') {
    await w.find('input.subject').setValue('Subj')
    await w.find('textarea.description').setValue('Body')
    await w.find('input.email').setValue(email)
  }

  it('validates required fields and the email before calling the API', async () => {
    const w = await open()
    await w.find('form').trigger('submit')
    expect(calls('createTicket')).toHaveLength(0)
    expect(w.find('[data-field=subject] .field-error').text()).toBe('Enter a subject.')
    expect(w.find('[data-field=description] .field-error').text()).toBe('Enter a description.')
    expect(w.find('[data-field=email] .field-error').text()).toBe('Enter the requester email.')
    await fill(w, 'not-an-email')
    await w.find('form').trigger('submit')
    expect(w.find('[data-field=email] .field-error').text()).toBe('Enter a valid email address.')
    expect(calls('createTicket')).toHaveLength(0)
  })

  it('calls createTicket with the contract fields then opens the new ticket', async () => {
    const w = await open()
    await fill(w)
    await w.find('select.priority').setValue('high')
    await w.find('select.department').setValue('1')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(calls('createTicket')).toEqual([
      [
        {
          subject: 'Subj',
          description: 'Body',
          priority: 'high',
          department_id: 1,
          requester: { name: 'cust', email: 'cust@x.test' },
        },
      ],
    ])
    expect(router.view).toBe('ticket')
    expect(router.currentReference).toBe('ESC-42')
  })

  it('sends the typed requester name when filled', async () => {
    const w = await open()
    await fill(w)
    await w.find('input.name').setValue('  Grace Hopper ')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect((calls('createTicket')[0]![0] as { requester: unknown }).requester).toEqual({
      name: 'Grace Hopper',
      email: 'cust@x.test',
    })
  })

  it('omits priority and department when left at their defaults', async () => {
    const w = await open()
    await fill(w)
    await w.find('form').trigger('submit')
    await flushPromises()
    const body = calls('createTicket')[0]![0] as Record<string, unknown>
    expect('priority' in body).toBe(false)
    expect('department_id' in body).toBe(false)
  })

  it('ignores a second submit while the first is in flight', async () => {
    let release!: (v: unknown) => void
    handlers.createTicket = () => new Promise((r) => (release = r))
    const w = await open()
    await fill(w)
    await w.find('form').trigger('submit')
    await w.find('form').trigger('submit')
    expect(calls('createTicket')).toHaveLength(1)
    expect(w.find('button.submit').attributes('disabled')).toBeDefined()
    release(ok({ data: { reference: 'ESC-9' }, message: 'x' }))
    await flushPromises()
    expect(router.currentReference).toBe('ESC-9')
  })

  it('shows 422 errors inline under each field and stays on the form', async () => {
    handlers.createTicket = () =>
      fail(422, 'The given data was invalid.', {
        subject: ['The subject is too long.'],
        'requester.email': ['The email is taken.'],
        priority: ['Bad priority.'],
        department_id: ['Unknown department.'],
        tags: ['Bad tag.'],
      })
    const w = await open()
    await fill(w)
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('[data-field=subject] .field-error').text()).toBe('The subject is too long.')
    expect(w.find('[data-field=email] .field-error').text()).toBe('The email is taken.')
    expect(w.find('[data-field=priority] .field-error').text()).toBe('Bad priority.')
    expect(w.find('[data-field=department] .field-error').text()).toBe('Unknown department.')
    expect(w.find('.form-error').text()).toBe('Bad tag.')
    expect(router.view).not.toBe('ticket')
    expect(w.find('button.submit').attributes('disabled')).toBeUndefined()
  })

  it('shows a general error for other failures and keeps the draft', async () => {
    handlers.createTicket = () => fail(500, 'Server exploded')
    const w = await open()
    await fill(w)
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('.form-error').text()).toBe('Server exploded')
    expect(val(w, 'input.subject')).toBe('Subj')
  })

  it('cancel goes back to the queue', async () => {
    const w = await open()
    router.view = 'create'
    await w.find('button.cancel').trigger('click')
    expect(router.view).toBe('queue')
  })
})

describe('App pendingCreate', () => {
  const store = () => getChromeFake().storage.local.set({ session: session() })
  const pending = (at = Date.now()) => ({ selection: 'sel', title: 'Title', url: 'https://a.test/', at })
  const left = async () => (await getChromeFake().storage.session.get('pendingCreate')).pendingCreate

  it('opens the create view from a fresh pendingCreate and clears it', async () => {
    await store()
    await getChromeFake().storage.session.set({ pendingCreate: pending() })
    const w = mount(App, { attachTo: document.body })
    await flushPromises()
    expect(router.view).toBe('create')
    expect(val(w, 'input.subject')).toBe('Title')
    expect(val(w, 'textarea.description')).toBe('sel\n\nhttps://a.test/')
    expect(await left()).toBeUndefined()
  })

  it('ignores a pendingCreate older than two minutes but clears it', async () => {
    await store()
    await getChromeFake().storage.session.set({ pendingCreate: pending(Date.now() - 3 * 60_000) })
    mount(App, { attachTo: document.body })
    await flushPromises()
    expect(router.view).toBe('queue')
    expect(await left()).toBeUndefined()
  })

  it('switches to the create view when a click arrives while the panel is open', async () => {
    await store()
    const w = mount(App, { attachTo: document.body })
    await flushPromises()
    expect(router.view).toBe('queue')
    await getChromeFake().storage.session.set({ pendingCreate: pending() })
    await flushPromises()
    expect(router.view).toBe('create')
    expect(val(w, 'input.subject')).toBe('Title')
  })
})
