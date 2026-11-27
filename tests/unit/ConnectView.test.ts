// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ConnectView from '../../src/sidepanel/views/ConnectView.vue'
import PanelHeader from '../../src/sidepanel/components/PanelHeader.vue'
import { ConnectError, type ConnectErrorCode } from '../../src/auth/connect'
import { connectErrorMessage } from '../../src/i18n/en'
import type { Session } from '../../src/api/client'

const { connectMock, disconnectMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
}))
vi.mock('../../src/auth/connect', async (orig) => ({
  ...(await orig<typeof import('../../src/auth/connect')>()),
  connect: connectMock,
  disconnect: disconnectMock,
}))

const session = (origin = 'https://help.test'): Session => ({
  origin,
  apiBase: `${origin}/support/api/v1`,
  token: 't',
  user: { id: 7, name: 'Ada', email: 'ada@help.test' },
  meta: { api_version: '1.0', backend: 'laravel', features: [], connect_url: null, web_url_template: null },
})

beforeEach(() => {
  connectMock.mockReset()
  disconnectMock.mockReset()
})

describe('ConnectView', () => {
  it('shows the address field, Connect button and Advanced fields', () => {
    const w = mount(ConnectView)
    expect(w.find('input#address').exists()).toBe(true)
    expect(w.find('button[type=submit]').text()).toBe('Connect')
    expect(w.find('details summary').text()).toBe('Advanced')
    expect(w.find('input#api-path').exists()).toBe(true)
    expect(w.find('input#token').attributes('type')).toBe('password')
    expect(w.find('label[for=address]').exists()).toBe(true)
  })

  it('calls connect synchronously from the click with address and advanced options', async () => {
    connectMock.mockReturnValue(new Promise(() => undefined))
    const w = mount(ConnectView, { attachTo: document.body })
    await w.find('#address').setValue('help.test')
    await w.find('#api-path').setValue('/x/api/v1')
    await w.find('#token').setValue('tok')
    const button = w.find('button[type=submit]')
    ;(button.element as HTMLButtonElement).click()
    // No await between the click and the assertion: the user gesture must reach connect().
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock).toHaveBeenCalledWith('help.test', { apiPath: '/x/api/v1', manualToken: 'tok' })
    await w.vm.$nextTick()
    expect(w.find('button[type=submit]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('emits connected with the session', async () => {
    const s = session()
    connectMock.mockResolvedValue(s)
    const w = mount(ConnectView)
    await w.find('#address').setValue('help.test')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.emitted('connected')).toEqual([[s]])
  })

  it.each([
    ['permission_denied', 'Chrome access to that site was not allowed.'],
    ['not_found', 'No Escalated API found at that address. Ask your admin to turn on the API.'],
    ['unreachable', 'Could not reach that address. Check it and your connection.'],
    ['invalid_address', "That doesn't look like a web address."],
    [
      'needs_manual_token',
      'This helpdesk does not support sign-in from the extension yet. Paste an API token under Advanced.',
    ],
    ['denied', 'Sign-in was cancelled.'],
    ['state_mismatch', "Sign-in didn't finish. Try again."],
    ['connect_failed', "Sign-in didn't finish. Try again."],
    ['invalid_token', "That token wasn't accepted."],
  ] as [ConnectErrorCode, string][])('maps %s to its copy', async (code, copy) => {
    connectMock.mockRejectedValue(new ConnectError(code))
    const w = mount(ConnectView)
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('[role=alert]').text()).toBe(copy)
    expect(w.find('button[type=submit]').attributes('disabled')).toBeUndefined()
  })

  it('falls back to a generic message for unknown errors', async () => {
    connectMock.mockRejectedValue(new Error('boom'))
    const w = mount(ConnectView)
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('[role=alert]').text()).toBe('Something went wrong. Try again.')
    expect(connectErrorMessage('nope')).toBe('Something went wrong. Try again.')
  })

  it('reconnect state pre-fills the address and explains', () => {
    const w = mount(ConnectView, { props: { reconnect: true, initialAddress: 'https://help.test' } })
    expect(w.text()).toContain('Your session ended. Sign in again.')
    expect((w.find('#address').element as HTMLInputElement).value).toBe('https://help.test')
    expect(w.find('button[type=submit]').text()).toBe('Reconnect')
  })
})

describe('PanelHeader', () => {
  it('shows host, name and Not encrypted only for http', () => {
    const https = mount(PanelHeader, { props: { session: session() } })
    expect(https.text()).toContain('help.test')
    expect(https.text()).toContain('Ada')
    expect(https.text()).not.toContain('Not encrypted')
    const http = mount(PanelHeader, { props: { session: session('http://localhost:8000') } })
    expect(http.text()).toContain('localhost:8000')
    expect(http.text()).toContain('Not encrypted')
  })

  it('confirms inline before disconnecting', async () => {
    disconnectMock.mockResolvedValue(undefined)
    const w = mount(PanelHeader, { props: { session: session() } })
    await w.find('button').trigger('click')
    expect(disconnectMock).not.toHaveBeenCalled()
    expect(w.text()).toContain('Disconnect from this helpdesk?')
    await w.find('button.danger').trigger('click')
    await flushPromises()
    expect(disconnectMock).toHaveBeenCalledTimes(1)
    expect(w.emitted('disconnected')).toHaveLength(1)
  })

  it('cancel keeps the session', async () => {
    const w = mount(PanelHeader, { props: { session: session() } })
    await w.find('button').trigger('click')
    const cancel = w.findAll('button').find((b) => b.text() === 'Cancel')!
    await cancel.trigger('click')
    expect(disconnectMock).not.toHaveBeenCalled()
    expect(w.text()).not.toContain('Disconnect from this helpdesk?')
  })
})
