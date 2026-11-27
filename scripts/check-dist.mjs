// Fails if the production build contains anything from the e2e build.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listFiles } from './zip-lib.mjs'

const dir = 'dist'
const problems = []
if (!existsSync(join(dir, 'manifest.json'))) {
  console.error('dist/ is missing. Run npm run build first.')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
for (const key of ['host_permissions', 'content_scripts']) {
  if (key in manifest) problems.push(`manifest.json has ${key}`)
}
for (const rel of listFiles(dir)) {
  if (/\.(png|ico|jpe?g|woff2?)$/i.test(rel)) continue
  const text = readFileSync(join(dir, rel), 'utf8')
  for (const marker of ['localhost', '127.0.0.1']) {
    if (text.includes(marker)) problems.push(`${rel} contains "${marker}"`)
  }
}
if (problems.length > 0) {
  console.error(`dist/ check failed:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('dist/ check passed')
