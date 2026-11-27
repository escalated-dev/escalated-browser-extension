// Some helpdesks store HTML bodies (Laravel keeps sanitised HTML for HTML-only inbound email).
// The panel never renders HTML: it turns such a body into plain text with its line breaks.

const LOOKS_LIKE_HTML =
  /<(?:p|br|div|span|a|b|i|u|strong|em|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|blockquote|pre|img|font|hr|html|body)\b[^>]*>/i

const BLOCKS = 'p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, ul, ol, table, hr'

// Block edges get a marker; a run of markers becomes one line break, or a blank line when a
// paragraph is part of it. Private-use characters do not occur in real mail text.
const LINE = ''
const PARAGRAPH = ''
const EDGES = /[ \t]*[][ \t]*/g

export function bodyText(body: string | null | undefined): string {
  const raw = body ?? ''
  if (!LOOKS_LIKE_HTML.test(raw) || typeof DOMParser === 'undefined') return raw
  // DOMParser builds an inert document: no scripts run and nothing is fetched.
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  doc.querySelectorAll('script, style, template, title, head').forEach((n) => n.remove())

  // HTML whitespace collapses, outside <pre>.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('pre')) n.textContent = (n.textContent ?? '').replace(/\s+/g, ' ')
  }
  doc.body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
  doc.body.querySelectorAll(BLOCKS).forEach((el) => {
    const mark = el.tagName === 'P' || el.tagName === 'BLOCKQUOTE' ? PARAGRAPH : LINE
    el.before(mark)
    el.after(mark)
  })
  return (doc.body.textContent ?? '')
    .replace(EDGES, (run) => (run.includes(PARAGRAPH) ? '\n\n' : '\n'))
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
