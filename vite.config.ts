import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// The page source is src/sidepanel/index.html; the manifest expects sidepanel.html.
const renameSidepanelHtml = (): Plugin => ({
  name: 'rename-sidepanel-html',
  apply: 'build',
  writeBundle(options) {
    const dir = options.dir ?? path('./dist')
    renameSync(join(dir, 'index.html'), join(dir, 'sidepanel.html'))
  },
})

// Test-only build (npm run build:e2e): the manifest also lists the local hosts the mock
// helpdesk runs on, so chrome.permissions.request resolves without a prompt. No code differs.
const e2eManifest = (): Plugin => ({
  name: 'e2e-manifest',
  apply: 'build',
  writeBundle(options) {
    const file = join(options.dir ?? path('./dist-e2e'), 'manifest.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    manifest.name = 'Escalated (e2e build)'
    manifest.host_permissions = ['http://localhost/*', 'http://127.0.0.1/*']
    writeFileSync(
      file,
      `${JSON.stringify(manifest, null, 2)}
`,
    )
  },
})

export default defineConfig(({ mode }) => ({
  root: path('./src/sidepanel'),
  publicDir: path('./public'),
  base: './',
  plugins: [vue(), tailwindcss(), renameSidepanelHtml(), ...(mode === 'e2e' ? [e2eManifest()] : [])],
  resolve: {
    alias: { '@': path('./src') },
  },
  build: {
    outDir: path(mode === 'e2e' ? './dist-e2e' : './dist'),
    emptyOutDir: true,
    target: 'chrome116',
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: path('./src/sidepanel/index.html'),
        background: path('./src/background/index.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
}))
