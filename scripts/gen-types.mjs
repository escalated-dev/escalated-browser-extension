// Generates src/api/schema.d.ts from the staff API contract's OpenAPI file.
// Run: npm run gen:types
// openapi-typescript 7 declares a TypeScript 5 peer, so it runs through npx
// instead of being a devDependency (it would conflict with TypeScript 6).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Pinned to a commit of escalated-dev/escalated-developer-context.
// Re-pin to the merge commit once escalated-developer-context PR #33 merges.
const CONTRACT_URL =
  'https://raw.githubusercontent.com/escalated-dev/escalated-developer-context/5cbb2d28ddc24c23353cfed26dd19b08ec319764/contracts/staff-api-v1.openapi.yaml'

const out = fileURLToPath(new URL('../src/api/schema.d.ts', import.meta.url))
const result = spawnSync('npx', ['--yes', 'openapi-typescript@7.13.0', CONTRACT_URL, '-o', out], {
  stdio: 'inherit',
  shell: true,
})
process.exit(result.status ?? 1)
