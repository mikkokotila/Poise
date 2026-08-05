import { describe, expect, it } from 'vitest'
import {
  blockMarkerLength,
  classifyLines,
  inlineSource,
  parseInline,
} from '../src/markdown-syntax'

// This module is the one place the markdown syntax is defined. The chat
// renderer and the editor both read it, so a change here changes what
// the writer may type AND what an agent reply may contain — which is the
// point: they can no longer drift apart.

describe('block kinds', () => {
  it('names every heading level, and only with a space after the hashes', () => {
    expect(classifyLines(['# a', '## a', '### a', '#### a', '##### a', '###### a']))
      .toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    expect(classifyLines(['#a', '#######  a', '#'])).toEqual(['body', 'body', 'body'])
  })

  it('names lists, quotes and rules', () => {
    expect(classifyLines(['- a', '1. a', '2) a'])).toEqual(['list-item', 'list-item', 'list-item'])
    expect(classifyLines(['> a', '>', '>a'])).toEqual(['quote', 'quote', 'body'])
    expect(classifyLines(['---', '***', '----------'])).toEqual(['rule', 'rule', 'rule'])
    // A marker with nothing after it is still prose until the space lands.
    expect(classifyLines(['-a', '1.a', '--'])).toEqual(['body', 'body', 'body'])
  })

  it('runs a fenced block to its close, or to the end if it never closes', () => {
    expect(classifyLines(['```ts', '# not a heading', '```', 'after']))
      .toEqual(['code-fence-open', 'code-content', 'code-fence-close', 'body'])
    expect(classifyLines(['```', 'stuck'])).toEqual(['code-fence-open', 'code-content'])
  })

  // A line that is markup end to end hides every character it has, so a
  // caret on it would be invisible and the line uneditable. Whichever
  // one the caret is on comes back as its own source.
  it('shows the source of a wholly hidden line the caret is on', () => {
    // A fence also stops opening a block, so `` ```ts `` can be typed one
    // key at a time without the document below turning into code.
    expect(classifyLines(['```ts', 'x'], 0)).toEqual(['source', 'body'])
    expect(classifyLines(['---', 'x'], 0)).toEqual(['source', 'body'])
    // A delimiter row keeps its table, though — the block around it must
    // not dissolve just because the caret arrived.
    expect(classifyLines(['| a | b |', '| - | - |', '| 1 | 2 |'], 1))
      .toEqual(['table-head', 'source', 'table-row'])
  })

  it('reports a marker length that splits the line into marker and content', () => {
    const cases: [string, string][] = [
      ['### Heading', '### '],
      ['- item', '- '],
      ['12) item', '12) '],
      ['> quoted', '> '],
      ['>', '>'],
      ['plain', ''],
    ]
    for (const [line, marker] of cases) {
      const kind = classifyLines([line])[0]
      expect(line.slice(0, blockMarkerLength(kind, line))).toBe(marker)
    }
  })

  it('treats a whole-line construct as all marker', () => {
    for (const line of ['---', '```ts', '| --- | --- |']) {
      const kind = classifyLines(line === '| --- | --- |' ? ['| a | b |', line] : [line]).pop()!
      expect(blockMarkerLength(kind, line)).toBe(line.length)
    }
  })
})

describe('inline runs', () => {
  const kinds = (s: string) => parseInline(s).map((seg) => seg.kind)

  it('reads bold, italic, code and links', () => {
    expect(kinds('**b**')).toEqual(['bold'])
    expect(kinds('*i*')).toEqual(['italic'])
    expect(kinds('_i_')).toEqual(['italic'])
    expect(kinds('`c`')).toEqual(['code'])
    expect(kinds('[t](https://e.com)')).toEqual(['link'])
    const link = parseInline('[t](https://e.com)')[0]
    expect(link).toMatchObject({ kind: 'link', text: 't', url: 'https://e.com' })
  })

  it('keeps emphasis out of the middle of a word', () => {
    expect(kinds('some_variable_name')).toEqual(['text'])
    expect(kinds('2 * 3 * 4')).toEqual(['text'])
    expect(kinds('a _b_ c')).toEqual(['text', 'italic', 'text'])
  })

  it('prefers whichever run opens first', () => {
    expect(kinds('`**not bold**`')).toEqual(['code'])
    expect(kinds('**a `b` c**')).toEqual(['bold'])
  })

  it('leaves an unclosed or empty marker as literal text', () => {
    expect(kinds('**')).toEqual(['text'])
    expect(kinds('`')).toEqual(['text'])
    expect(kinds('[unclosed](')).toEqual(['text'])
    expect(kinds('[t]( )')).toEqual(['text'])
    expect(kinds('****')).toEqual(['text'])
  })

  // The editor keeps markdown in the document and only hides it, so a
  // parse that cannot be turned back into its exact source would corrupt
  // the file on the next keystroke.
  it('rebuilds its own source character for character', () => {
    const samples = [
      'plain prose',
      '**bold** and *italic* and _under_ and `code`',
      'a [link](https://example.com) mid-sentence',
      'trailing **bold**',
      '**',
      '`unclosed',
      '[t](url with spaces)',
      'some_variable_name and 2 * 3',
      '***x***',
      '[a](b)[c](d)',
      '',
    ]
    for (const sample of samples) {
      expect(parseInline(sample).map(inlineSource).join('')).toBe(sample)
    }
  })

  it('does not nest one run inside another', () => {
    // Documented limitation, shared by both renderers: the inner run is
    // literal text inside the outer one.
    const segs = parseInline('**bold `code`**')
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: 'bold', text: 'bold `code`' })
  })
})
