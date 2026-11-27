// Zips dist/ into escalated-browser-extension-<version>.zip using the system tar
// (bsdtar on Windows and macOS writes zip with -a), so no extra dependency is needed.
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

if (!existsSync('dist/manifest.json')) {
  console.error('dist/ is missing. Run npm run build first.')
  process.exit(1)
}
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const out = `escalated-browser-extension-${version}.zip`
rmSync(out, { force: true })
const res = spawnSync('tar', ['-a', '-c', '-f', out, '-C', 'dist', '.'], { stdio: 'inherit' })
if (res.status !== 0) process.exit(res.status ?? 1)
console.log(`Wrote ${out}`)
