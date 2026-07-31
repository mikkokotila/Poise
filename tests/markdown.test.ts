import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/markdown'

// Agent replies are markdown by convention. The chat pane used to drop them
// into a <pre>, so a formatted answer arrived as a wall of asterisks and
// backticks that read worse than plain prose would have.
describe('block structure', () => {
  it('renders headings, paragraphs and rules', () => {
    expect(renderMarkdown('# Title\n\nsome prose')).toBe('<h1 class="md-h">Title</h1><p>some prose</p>')
    expect(renderMarkdown('---')).toBe('<hr class="md-hr">')
  })

  it('renders both kinds of list, and closes them', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul class="md-list"><li>one</li><li>two</li></ul>')
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol class="md-list"><li>one</li><li>two</li></ol>')
    expect(renderMarkdown('- a\n\nafter')).toBe('<ul class="md-list"><li>a</li></ul><p>after</p>')
  })

  it('keeps a fenced code block verbatim', () => {
    const html = renderMarkdown('```ts\nconst a = **not bold**\n```')
    expect(html).toContain('data-lang="ts"')
    expect(html).toContain('const a = **not bold**')
    expect(html).not.toContain('<strong>')
  })

  it('closes an unterminated fence rather than losing the rest', () => {
    expect(renderMarkdown('```\nstuck')).toContain('<code>stuck</code>')
  })

  it('joins the lines of a paragraph and of a quote', () => {
    expect(renderMarkdown('one\ntwo')).toBe('<p>one<br>two</p>')
    expect(renderMarkdown('> a\n> b')).toBe('<blockquote class="md-quote">a<br>b</blockquote>')
  })
})

describe('inline formatting', () => {
  it('renders bold, italic and code', () => {
    expect(renderMarkdown('**b**')).toBe('<p><strong>b</strong></p>')
    expect(renderMarkdown('*i*')).toBe('<p><em>i</em></p>')
    expect(renderMarkdown('`x`')).toBe('<p><code>x</code></p>')
  })

  it('leaves markdown inside a code span alone', () => {
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>')
  })

  it('does not italicise an underscore inside a word', () => {
    expect(renderMarkdown('some_variable_name')).toBe('<p>some_variable_name</p>')
  })
})

// The input is escaped once, up front, and every rule then works on escaped
// text — so there is no path by which markup in a reply survives as markup.
describe('a reply cannot inject markup', () => {
  it('escapes tags in prose, in code and in headings', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toContain('&lt;script&gt;')
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>')
    expect(renderMarkdown('```\n<img onerror=x>\n```')).toContain('&lt;img onerror=x&gt;')
    expect(renderMarkdown('# <b>x</b>')).toContain('&lt;b&gt;')
  })

  it('escapes quotes so nothing can break out of an attribute', () => {
    expect(renderMarkdown('a " b \' c')).toContain('&quot;')
  })

  it('links only http and https, and renders anything else as text', () => {
    expect(renderMarkdown('[x](https://example.com)'))
      .toBe('<p><a href="https://example.com" target="_blank" rel="noopener">x</a></p>')
    const js = renderMarkdown('[x](javascript:alert(1))')
    expect(js).not.toContain('<a ')
    expect(js).toContain('[x]')
    const data = renderMarkdown('[x](data:text/html,<script>)')
    expect(data).not.toContain('<a ')
  })

  it('refuses a url carrying a quote rather than emitting it as an href', () => {
    const html = renderMarkdown('[x](https://example.com"onmouseover=alert&#40;1&#41;)')
    // The text survives — inert, escaped, inside a paragraph — but it must not
    // become a link, and no attribute may be emitted from it.
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href=')
    expect(html).toContain('&quot;')
  })
})

describe('degenerate input', () => {
  it('handles empty and whitespace-only input', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('\n\n   \n')).toBe('')
  })

  it('does not throw on a lone marker', () => {
    expect(() => renderMarkdown('**')).not.toThrow()
    expect(() => renderMarkdown('`')).not.toThrow()
    expect(() => renderMarkdown('[unclosed](')).not.toThrow()
  })
})
