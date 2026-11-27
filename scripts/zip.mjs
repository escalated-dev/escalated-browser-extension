// Zips dist/ into escalated-browser-extension-<version>.zip with a built-in writer, so it
// needs no system zip or tar and behaves the same everywhere.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { buildZip, listFiles, listZipEntries } from './zip-lib.mjs'

if (!existsSync('dist/manifest.json')) {
  console.error('dist/ is missing. Run npm run build first.')
  process.exit(1)
}
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const out = `escalated-browser-extension-${version}.zip`
rmSync(out, { force: true })
const zip = buildZip('dist')
writeFileSync(out, zip)

// Check what was written, not what was built.
const written = readFileSync(out)
const expected = listFiles('dist')
const actual = listZipEntries(written)
if (
  written.readUInt32LE(0) !== 0x04034b50 ||
  actual.length !== expected.length ||
  actual.some((n, i) => n !== expected[i])
) {
  rmSync(out, { force: true })
  console.error('Zip check failed: entries do not match dist/.')
  process.exit(1)
}
console.log(`Wrote ${out} (${actual.length} files)`)
