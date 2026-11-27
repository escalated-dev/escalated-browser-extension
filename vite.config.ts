import { renameSync } from 'node:fs'
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

export default defineConfig({
  root: path('./src/sidepanel'),
  publicDir: path('./public'),
  base: './',
  plugins: [vue(), tailwindcss(), renameSidepanelHtml()],
  resolve: {
    alias: { '@': path('./src') },
  },
  build: {
    outDir: path('./dist'),
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
})
