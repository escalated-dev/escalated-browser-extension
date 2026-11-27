import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { buildZip, listFiles, listZipEntries } from '../../scripts/zip-lib.mjs'

let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('zip writer', () => {
  it('writes a real zip whose entries match the directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'zip-'))
    mkdirSync(join(dir, 'assets'))
    mkdirSync(join(dir, 'icons'))
    writeFileSync(join(dir, 'manifest.json'), '{"a":1}')
    writeFileSync(join(dir, 'assets', 'x.js'), 'console.log(1)\n'.repeat(50))
    writeFileSync(join(dir, 'icons', '16.png'), Buffer.from([0, 1, 2, 3]))

    const zip: Buffer = buildZip(dir)
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    const names: string[] = listZipEntries(zip)
    expect(names).toEqual(listFiles(dir))
    expect(names).toEqual(['assets/x.js', 'icons/16.png', 'manifest.json'])

    // First local entry round-trips through inflate.
    const nameLen = zip.readUInt16LE(26)
    const size = zip.readUInt32LE(18)
    const body = inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + size))
    expect(body.toString()).toBe('console.log(1)\n'.repeat(50))
  })
})
