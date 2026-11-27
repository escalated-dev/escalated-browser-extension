// Dependency-free zip writer (deflate) so packaging works the same on Windows and Linux.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

/** Relative file paths under dir, forward slashes, sorted. */
export function listFiles(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(join(dir, rel)).isDirectory()) out.push(...listFiles(dir, rel))
    else out.push(rel)
  }
  return out
}

const DOS_TIME = 0 // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1 // 2026-01-01, fixed so output is reproducible

export function buildZip(dir) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const rel of listFiles(dir)) {
    const data = readFileSync(join(dir, rel))
    const packed = deflateRawSync(data)
    const name = Buffer.from(rel, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // utf-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, packed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + packed.length
  }
  const centralBytes = Buffer.concat(centrals)
  const count = centrals.length / 2
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

/** Entry names read back from the central directory. */
export function listZipEntries(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('Not a zip: no end record')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory')
    const n = zip.readUInt16LE(p + 28)
    const extra = zip.readUInt16LE(p + 30)
    const comment = zip.readUInt16LE(p + 32)
    names.push(zip.subarray(p + 46, p + 46 + n).toString('utf8'))
    p += 46 + n + extra + comment
  }
  return names
}
