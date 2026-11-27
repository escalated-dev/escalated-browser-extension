// Generates placeholder icons (rounded square with a chevron mark) with no dependencies.
// Real store-listing artwork replaces these later. Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// Distance from a point to a segment, for the chevron strokes.
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

const render = (size) => {
  const rows = []
  const r = size * 0.22
  const stroke = size * 0.09
  const SS = 4 // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    for (let x = 0; x < size; x++) {
      let bg = 0
      let fg = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          const cx = Math.min(Math.max(px, r), size - r)
          const cy = Math.min(Math.max(py, r), size - r)
          if (Math.hypot(px - cx, py - cy) <= r) {
            bg++
            const d = Math.min(
              segDist(px, py, size * 0.3, size * 0.6, size * 0.5, size * 0.38),
              segDist(px, py, size * 0.5, size * 0.38, size * 0.7, size * 0.6),
              segDist(px, py, size * 0.3, size * 0.78, size * 0.5, size * 0.56),
              segDist(px, py, size * 0.5, size * 0.56, size * 0.7, size * 0.78),
            )
            if (d <= stroke / 2) fg++
          }
        }
      }
      const alpha = bg / (SS * SS)
      const mix = bg ? fg / bg : 0
      // teal #0f766e background, white mark
      row[1 + x * 4] = Math.round(15 + (255 - 15) * mix)
      row[2 + x * 4] = Math.round(118 + (255 - 118) * mix)
      row[3 + x * 4] = Math.round(110 + (255 - 110) * mix)
      row[4 + x * 4] = Math.round(alpha * 255)
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync('public/icons', { recursive: true })
for (const size of [16, 32, 48, 128]) writeFileSync(`public/icons/${size}.png`, render(size))
