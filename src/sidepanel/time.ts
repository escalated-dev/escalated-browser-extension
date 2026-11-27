const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
]

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })

/** "5 min. ago", "yesterday". Empty string for a missing or unparsable timestamp. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const seconds = Math.round((t - now) / 1000)
  const abs = Math.abs(seconds)
  for (const [unit, size] of UNITS) {
    if (abs >= size) return rtf.format(Math.trunc(seconds / size), unit)
  }
  return rtf.format(0, 'second')
}
