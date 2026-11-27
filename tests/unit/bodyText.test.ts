// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bodyText } from '../../src/sidepanel/bodyText'

describe('bodyText', () => {
  it('leaves plain text alone, line breaks and angle brackets included', () => {
    expect(bodyText('Hi,\n\nif a < b and c > d, use <Enter>.\n')).toBe(
      'Hi,\n\nif a < b and c > d, use <Enter>.\n',
    )
    expect(bodyText(null)).toBe('')
    expect(bodyText(undefined)).toBe('')
  })

  it('turns <br> into a line break and paragraphs into a blank line', () => {
    expect(bodyText('<p>Hello,</p>\n<p>Line one<br>Line two<br/>Line three</p>')).toBe(
      'Hello,\n\nLine one\nLine two\nLine three',
    )
  })

  it('collapses HTML source whitespace and decodes entities', () => {
    expect(bodyText('<div>Thanks   for\n   waiting &amp; sorry</div><div>Sam</div>')).toBe(
      'Thanks for waiting & sorry\nSam',
    )
  })

  it('puts list items on their own lines', () => {
    expect(bodyText('<ul><li>One</li><li>Two</li></ul>')).toBe('One\nTwo')
  })

  it('drops scripts, styles and every tag, keeping only text', () => {
    const out = bodyText(
      '<style>p{color:red}</style><p>Hi <img src="x" onerror="alert(1)"><a href="javascript:x">link</a></p><script>alert(2)</script>',
    )
    expect(out).toBe('Hi link')
  })
})
