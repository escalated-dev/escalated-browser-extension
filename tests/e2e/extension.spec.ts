import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { REVOKE_DELAY_MS, startMock, type Mock } from './mock-server'

const dist = resolve(import.meta.dirname, '../../dist-e2e')

let mock: Mock
let context: BrowserContext
let worker: Worker
let extensionId: string
let profile: string
let page: Page
const workerErrors: string[] = []

function watchWorker(w: Worker): void {
  w.on('console', (m) => {
    if (m.type() === 'error') workerErrors.push(m.text())
  })
}

const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}))
const pollNow = () => page.evaluate(() => chrome.runtime.sendMessage({ type: 'poll-now' }))
/** The poller's alert keys ("reference|timestamp|kind"), recorded before each notification. */
const alertKeys = () =>
  worker.evaluate(async () => {
    const got = await chrome.storage.local.get('poll.notified')
    return Object.keys((got['poll.notified'] as Record<string, number> | undefined) ?? {})
  })

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  mock = await startMock()
  profile = mkdtempSync(join(tmpdir(), 'esc-e2e-'))
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: process.env.E2E_HEADED !== '1',
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  })
  context.on('serviceworker', watchWorker)
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  watchWorker(worker)
  extensionId = new URL(worker.url()).host
})

test.afterAll(async () => {
  await context?.close()
  await mock?.close()
  if (profile) rmSync(profile, { recursive: true, force: true })
})

test('the service worker starts cleanly and the toolbar button opens the side panel', async () => {
  expect(worker.url()).toBe(`chrome-extension://${extensionId}/background.js`)
  await expect
    .poll(() => worker.evaluate(() => chrome.sidePanel.getPanelBehavior()))
    .toEqual({ openPanelOnActionClick: true })
  expect(await worker.evaluate(() => chrome.runtime.getManifest().side_panel?.default_path)).toBe(
    'sidepanel.html',
  )
  expect(workerErrors).toEqual([])
})

test('signs in through the helpdesk connect page', async () => {
  page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`)
  await page.getByLabel('Helpdesk address').fill(mock.url)
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible()
  expect(mock.exchanges).toBe(1)
  await expect(page.getByText('Sam Agent')).toBeVisible()
})

test('the queue shows the three fixture tickets', async () => {
  await expect(page.locator('[data-reference]')).toHaveCount(3)
  await expect(page.getByText('Cannot reset my password')).toBeVisible()
  await expect(page.getByText('Invoice shows the wrong amount')).toBeVisible()
  await expect(page.getByText('Export to CSV fails')).toBeVisible()
})

test('the badge shows the assigned count after a poll', async () => {
  await pollNow()
  await expect.poll(badge).toBe('3')
  mock.addAssignedTicket('A fourth ticket')
  await pollNow()
  await expect.poll(badge).toBe('4')
  // The incremental listing (open=1, updated_since) found it: an "Assigned to you" alert.
  await expect.poll(alertKeys).toContainEqual(expect.stringMatching(/^ESC-00050\|.+\|assigned$/))
  expect(mock.listQueries.some((q) => q.has('open') && q.has('updated_since') && q.has('assigned_to'))).toBe(
    true,
  )
})

test('a customer reply on one of my tickets raises a reply alert', async () => {
  mock.customerReply('ESC-00002', 'Any news on this?')
  await pollNow()
  await expect.poll(alertKeys).toContainEqual(expect.stringMatching(/^ESC-00002\|.+\|reply$/))
  // Headless Chromium may not keep notifications; when it does, the id carries the window.
  const shown = await worker.evaluate(() => chrome.notifications.getAll())
  for (const id of Object.keys(shown)) expect(id).toMatch(/^ESC-\d+(\|\d+)?$/)
})

test('opens a ticket, sends a reply and shows it in the thread', async () => {
  await page.locator('[data-reference="ESC-00001"]').click()
  await expect(page.getByRole('heading', { name: /Cannot reset my password/ })).toBeVisible()
  const thread = page.getByRole('region', { name: 'Conversation' })
  await expect(thread.getByText('The reset email never arrives.')).toBeVisible()

  await page.getByPlaceholder('Write a reply to the customer').fill('We have sent a new link.')
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(thread.getByText('We have sent a new link.')).toBeVisible()
  expect(mock.tickets[0]?.replies[0]?.body).toBe('We have sent a new link.')
  expect(mock.requests).toContain('POST /tickets/ESC-00001/reply')
})

test('the worker raised no errors', () => {
  expect(workerErrors).toEqual([])
})

test('disconnect revokes the token before giving up host access, then clears everything', async () => {
  await page.getByRole('button', { name: 'Back to queue' }).click()
  // The e2e build holds the localhost hosts as required permissions, so removing them cannot
  // cut the panel off here. Record when the panel asks Chrome to remove the helpdesk origin and
  // compare it with when the mock received the revoke, which it answers after REVOKE_DELAY_MS.
  await page.evaluate(() => {
    const w = window as unknown as { removedAt: { at: number; origins: string[] }[] }
    w.removedAt = []
    const real = chrome.permissions.remove.bind(chrome.permissions)
    const spy = ((p: { origins?: string[] }) => {
      w.removedAt.push({ at: Date.now(), origins: p.origins ?? [] })
      return real(p)
    }) as never
    chrome.permissions.remove = spy
    if (chrome.permissions.remove !== spy) {
      Object.defineProperty(chrome.permissions, 'remove', { value: spy, configurable: true, writable: true })
    }
  })
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await page
    .getByRole('group', { name: 'Disconnect from this helpdesk?' })
    .getByRole('button', { name: 'Disconnect' })
    .click()
  await expect(page.getByRole('heading', { name: 'Connect to your helpdesk' })).toBeVisible()
  await expect.poll(() => mock.revoked.length).toBe(1)
  const pattern = `${mock.url}/*`
  const removal = async () =>
    (
      await page.evaluate(
        () => (window as unknown as { removedAt: { at: number; origins: string[] }[] }).removedAt,
      )
    ).find((r) => r.origins.includes(pattern))
  await expect.poll(removal).toBeDefined()
  expect((await removal())!.at).toBeGreaterThanOrEqual(mock.revokedAt[0]! + REVOKE_DELAY_MS - 50)
  await expect.poll(() => worker.evaluate(() => chrome.storage.local.get(null))).toEqual({})
  expect(await worker.evaluate(() => chrome.storage.session.get(null))).toEqual({})
  expect(await page.evaluate(() => localStorage.getItem('lastAddress'))).toBeNull()
  await expect.poll(badge).toBe('')
})
