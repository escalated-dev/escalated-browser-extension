import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getChromeFake } from '../setup/chrome'
import type { Session } from '../../src/api/client'

const session = (features: string[]): Session =>
  ({
    origin: 'https://help.test',
    apiBase: 'https://help.test/support/api/v1',
    token: 't',
    user: { id: 7, name: 'Ada', email: 'a@b.c' },
    meta: { api_version: '1.0', backend: 'x', features, connect_url: null, web_url_template: null },
  }) as unknown as Session

type Click = (info: unknown, tab?: unknown) => void
let mod: typeof import('../../src/background/contextMenu')

beforeEach(async () => {
  vi.resetModules()
  mod = await import('../../src/background/contextMenu')
})

const settle = () => new Promise((r) => setTimeout(r, 0))
const click = (info: unknown, tab?: unknown) =>
  (getChromeFake().contextMenus.onClicked as unknown as { emit: Click }).emit(info, tab)

describe('context menu lifecycle', () => {
  it('creates the item when connected with tickets.create', async () => {
    const c = getChromeFake()
    await c.storage.local.set({ session: session(['tickets.create']) })
    mod.registerContextMenu()
    await mod.syncContextMenu()
    expect(c.contextMenus.map.get('create-ticket')).toMatchObject({
      id: 'create-ticket',
      title: 'Create Escalated ticket',
      contexts: ['selection', 'page'],
    })
  })

  it('does not create it without the feature or when disconnected', async () => {
    const c = getChromeFake()
    await mod.syncContextMenu()
    expect(c.contextMenus.map.size).toBe(0)
    await c.storage.local.set({ session: session(['macros']) })
    await mod.syncContextMenu()
    expect(c.contextMenus.map.size).toBe(0)
  })

  it('removes it on disconnect, and creates it on connect via storage changes', async () => {
    const c = getChromeFake()
    mod.registerContextMenu()
    await c.storage.local.set({ session: session(['tickets.create']) })
    await settle()
    expect(c.contextMenus.map.has('create-ticket')).toBe(true)
    await c.storage.local.clear()
    await settle()
    expect(c.contextMenus.map.size).toBe(0)
  })

  it('uses removeAll then create, never leaving duplicates after repeated syncs', async () => {
    const c = getChromeFake()
    await c.storage.local.set({ session: session(['tickets.create']) })
    await Promise.all([mod.syncContextMenu(), mod.syncContextMenu(), mod.syncContextMenu()])
    expect(c.contextMenus.removeAll).toHaveBeenCalledTimes(3)
    expect(c.contextMenus.create).toHaveBeenCalledTimes(3)
    expect(c.contextMenus.map.size).toBe(1)
  })
})

describe('context menu click', () => {
  const tab = { id: 11, windowId: 2, title: 'Pricing page', url: 'https://shop.test/pricing' }

  it('opens the panel synchronously, then stores the pending create', async () => {
    const c = getChromeFake()
    mod.registerContextMenu()
    click({ menuItemId: 'create-ticket', selectionText: 'Broken checkout', pageUrl: tab.url }, tab)
    // Synchronous: the open call is made before any await.
    expect(c.sidePanel.open).toHaveBeenCalledWith({ tabId: 11 })
    expect(c.sidePanel.open.mock.invocationCallOrder[0]!).toBeLessThan(
      c.storage.session.set.mock.invocationCallOrder[0]!,
    )
    await settle()
    const stored = (await c.storage.session.get('pendingCreate')).pendingCreate as Record<string, unknown>
    expect(stored).toMatchObject({
      selection: 'Broken checkout',
      title: 'Pricing page',
      url: 'https://shop.test/pricing',
    })
    expect(typeof stored.at).toBe('number')
  })

  it('ignores other menu items', async () => {
    const c = getChromeFake()
    mod.registerContextMenu()
    click({ menuItemId: 'other' }, tab)
    await settle()
    expect(c.sidePanel.open).not.toHaveBeenCalled()
    expect(c.storage.session.set).not.toHaveBeenCalled()
  })

  it('drops non-http(s) urls and trims the selection to 10000 characters', async () => {
    const c = getChromeFake()
    mod.registerContextMenu()
    for (const url of ['chrome://settings', 'file:///C:/a.txt', 'javascript:alert(1)', 'not a url']) {
      click({ menuItemId: 'create-ticket', selectionText: 'x'.repeat(12000), pageUrl: url }, { ...tab, url })
      await settle()
      const p = (await c.storage.session.get('pendingCreate')).pendingCreate as {
        url: string
        selection: string
      }
      expect(p.url).toBe('')
      expect(p.selection).toHaveLength(10000)
    }
    click({ menuItemId: 'create-ticket', pageUrl: 'http://plain.test/a' }, tab)
    await settle()
    const p = (await c.storage.session.get('pendingCreate')).pendingCreate as {
      url: string
      selection: string
    }
    expect(p.url).toBe('http://plain.test/a')
    expect(p.selection).toBe('')
  })

  it('still stores the pending create when there is no tab id', async () => {
    const c = getChromeFake()
    mod.registerContextMenu()
    click({ menuItemId: 'create-ticket', pageUrl: 'https://a.test/' }, undefined)
    await settle()
    expect(c.sidePanel.open).not.toHaveBeenCalled()
    expect((await c.storage.session.get('pendingCreate')).pendingCreate).toBeTruthy()
  })
})

describe('service worker wiring', () => {
  it('registers the click listener and syncs the menu at top level', async () => {
    const c = getChromeFake()
    await c.storage.local.set({ session: session(['tickets.create']) })
    await import('../../src/background/index')
    expect(c.contextMenus.onClicked.listenerCount()).toBe(1)
    await vi.waitFor(() => expect(c.contextMenus.map.has('create-ticket')).toBe(true))
  })
})
