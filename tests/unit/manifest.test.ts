import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

describe('manifest.json', () => {
  it('is Manifest V3 with a minimum Chrome version', () => {
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.minimum_chrome_version).toBe('116')
  })

  it('requests exactly the allowed permissions', () => {
    const expected = ['sidePanel', 'storage', 'alarms', 'notifications', 'contextMenus', 'identity']
    expect([...manifest.permissions].sort()).toEqual([...expected].sort())
  })

  it('asks for helpdesk origins only as optional host permissions', () => {
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*'])
    expect(manifest).not.toHaveProperty('host_permissions')
  })

  it('has no content scripts', () => {
    expect(manifest).not.toHaveProperty('content_scripts')
  })

  it('uses an ES module service worker and the side panel page', () => {
    expect(manifest.background.service_worker).toBe('background.js')
    expect(manifest.background.type).toBe('module')
    expect(manifest.side_panel.default_path).toBe('sidepanel.html')
  })

  it('keeps the default CSP', () => {
    expect(manifest).not.toHaveProperty('content_security_policy')
  })

  it('matches the package version', () => {
    expect(manifest.version).toBe(pkg.version)
  })
})

describe('production build isolation', () => {
  it('has no host_permissions in the source manifest', () => {
    expect(manifest).not.toHaveProperty('host_permissions')
  })

  const built = resolve(root, 'dist/manifest.json')
  it.skipIf(!existsSync(built))('keeps the e2e-only host permissions out of dist/', () => {
    const dist = JSON.parse(readFileSync(built, 'utf8'))
    expect(dist).not.toHaveProperty('host_permissions')
    expect(dist.name).toBe('Escalated')
    expect(readFileSync(built, 'utf8')).not.toMatch(/localhost|127\.0\.0\.1|e2e/i)
  })
})
