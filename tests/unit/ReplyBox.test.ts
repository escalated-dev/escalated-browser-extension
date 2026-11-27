// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ReplyBox from '../../src/sidepanel/components/ReplyBox.vue'
import { getChromeFake } from '../setup/chrome'
import type { CannedResponse } from '../../src/api/client'

const canned: CannedResponse[] = [
  { id: 1, title: 'Greeting', body: 'Hi there,' },
  { id: 2, title: 'Thanks', body: ' Thanks for waiting.' },
]

let sendMessage: ReturnType<typeof vi.fn>
const replyCalls = () =>
  sendMessage.mock.calls
    .map((c) => c[0] as { call: string; args: unknown[] })
    .filter((m) => m.call === 'reply')

const created = { ok: true, data: { data: { id: 9 }, message: 'Reply sent.' } }

const box = (props: Record<string, unknown> = {}) =>
  mount(ReplyBox, { props: { reference: 'ESC-1', canned, ...props }, attachTo: document.body })

const value = (w: ReturnType<typeof box>) => (w.find('textarea').element as HTMLTextAreaElement).value

beforeEach(() => {
  sendMessage = getChromeFake().runtime.sendMessage as unknown as ReturnType<typeof vi.fn>
  sendMessage.mockResolvedValue(created)
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('ReplyBox', () => {
  it('sends a public reply by default and a note after toggling', async () => {
    const w = box()
    await flushPromises()
    await w.find('textarea').setValue('Hello')
    await w.find('button.send').trigger('click')
    await flushPromises()
    expect(replyCalls()[0]!.args).toEqual(['ESC-1', 'Hello', false])
    expect(w.emitted('sent')).toHaveLength(1)

    await w.findAll('button.mode')[1]!.trigger('click')
    expect(w.findAll('button.mode')[1]!.attributes('aria-pressed')).toBe('true')
    await w.find('textarea').setValue('Private')
    await w.find('button.send').trigger('click')
    await flushPromises()
    expect(replyCalls()[1]!.args).toEqual(['ESC-1', 'Private', true])
  })

  it('labels the toggle and send button', async () => {
    const w = box()
    await flushPromises()
    expect(w.findAll('button.mode').map((b) => b.text())).toEqual(['Reply', 'Internal note'])
    expect(w.find('button.send').text()).toBe('Send reply')
    await w.findAll('button.mode')[1]!.trigger('click')
    expect(w.find('button.send').text()).toBe('Add note')
  })

  it('does not send an empty body', async () => {
    const w = box()
    await flushPromises()
    await w.find('textarea').setValue('   ')
    expect(w.find('button.send').attributes('disabled')).toBeDefined()
    await w.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(replyCalls()).toHaveLength(0)
  })

  it('sends on Ctrl+Enter and Cmd+Enter but not plain Enter', async () => {
    const w = box()
    await flushPromises()
    await w.find('textarea').setValue('One')
    await w.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()
    await w.find('textarea').setValue('Two')
    await w.find('textarea').trigger('keydown', { key: 'Enter', metaKey: true })
    await flushPromises()
    await w.find('textarea').setValue('Three')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(replyCalls().map((c) => c.args[1])).toEqual(['One', 'Two'])
  })

  it('is disabled while sending and sends once', async () => {
    let release!: (v: unknown) => void
    sendMessage.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const w = box()
    await flushPromises()
    await w.find('textarea').setValue('Hello')
    await w.find('button.send').trigger('click')
    expect(w.find('textarea').attributes('disabled')).toBeDefined()
    expect(w.find('button.send').attributes('disabled')).toBeDefined()
    await w.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(replyCalls()).toHaveLength(1)
    release(created)
    await flushPromises()
    expect(w.find('textarea').attributes('disabled')).toBeUndefined()
  })

  it('keeps the draft and shows the API message when sending fails', async () => {
    sendMessage.mockResolvedValueOnce({
      ok: false,
      error: { status: 403, message: 'This action is unauthorized.' },
    })
    const w = box()
    await flushPromises()
    await w.find('textarea').setValue('Keep me')
    await w.find('button.send').trigger('click')
    await flushPromises()
    expect(w.find('[role=alert]').text()).toBe('This action is unauthorized.')
    expect(value(w)).toBe('Keep me')
    expect(w.emitted('sent')).toBeUndefined()
    await vi.waitFor(() => expect(getChromeFake().storage.session.dump()['draft:ESC-1']).toBe('Keep me'))
  })

  it('saves the draft per ticket after a 500 ms debounce', async () => {
    vi.useFakeTimers()
    const w = box()
    await flushPromises()
    await w.find('textarea').setValue('Draft')
    await vi.advanceTimersByTimeAsync(499)
    expect(getChromeFake().storage.session.dump()).toEqual({})
    await vi.advanceTimersByTimeAsync(1)
    expect(getChromeFake().storage.session.dump()).toEqual({ 'draft:ESC-1': 'Draft' })
  })

  it('restores a saved draft on mount', async () => {
    await getChromeFake().storage.session.set({ 'draft:ESC-1': 'Saved', 'draft:ESC-2': 'Other' })
    const w = box()
    await flushPromises()
    expect(value(w)).toBe('Saved')
  })

  it('clears the draft after a successful send', async () => {
    vi.useFakeTimers()
    const w = box()
    await flushPromises()
    await w.find('textarea').setValue('Hello')
    await vi.advanceTimersByTimeAsync(600)
    expect(getChromeFake().storage.session.dump()['draft:ESC-1']).toBe('Hello')
    await w.find('button.send').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(600)
    expect(getChromeFake().storage.session.dump()).toEqual({})
    expect(value(w)).toBe('')
  })

  it('inserts a canned response at the cursor', async () => {
    const w = box()
    await flushPromises()
    const ta = w.find('textarea').element as HTMLTextAreaElement
    await w.find('textarea').setValue('Hello world')
    ta.setSelectionRange(5, 5)
    await w.find('select.canned').setValue('2')
    expect(ta.value).toBe('Hello Thanks for waiting. world')
  })

  it('appends a canned response when there is no cursor position yet', async () => {
    const w = box()
    await flushPromises()
    await w.find('select.canned').setValue('1')
    expect(value(w)).toBe('Hi there,')
    await w.find('select.canned').setValue('2')
    expect(value(w)).toBe('Hi there, Thanks for waiting.')
  })

  it('hides the canned picker when there are no canned responses', async () => {
    const w = box({ canned: null })
    await flushPromises()
    expect(w.find('select.canned').exists()).toBe(false)
  })
})
