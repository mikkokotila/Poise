import { describe, expect, it } from 'vitest'

import { stripMarkdownForTitle } from '../server/editor'

// The document title is a label — the switcher, the editor bar, the menu.
// It should read the way the line reads on the page. Only the leading `#`
// used to be removed, so `**Portfolio** is the entirety` surfaced as
// `**Portfolio **is the…` in the switcher.
describe('stripMarkdownForTitle', () => {
  it('drops heading markers', () => {
    expect(stripMarkdownForTitle('# My Heading')).toBe('My Heading')
    expect(stripMarkdownForTitle('### Deeper')).toBe('Deeper')
  })

  it('drops list markers', () => {
    expect(stripMarkdownForTitle('- a bullet')).toBe('a bullet')
    expect(stripMarkdownForTitle('1. first')).toBe('first')
    expect(stripMarkdownForTitle('12) twelfth')).toBe('twelfth')
  })

  it('unwraps bold, keeping the words', () => {
    expect(stripMarkdownForTitle('**Portfolio** is the entirety'))
      .toBe('Portfolio is the entirety')
  })

  it('unwraps inline code', () => {
    expect(stripMarkdownForTitle('the `prep_each_round` contract'))
      .toBe('the prep_each_round contract')
  })

  it('handles the malformed bold that older documents already contain', () => {
    // Written by the pre-fix Cmd+B: the space migrated inside the closer.
    expect(stripMarkdownForTitle("**Portfolio **is the entirety of Velocin's patents."))
      .toBe("Portfolio is the entirety of Velocin's patents.")
    expect(stripMarkdownForTitle('**NOTE: **something')).toBe('NOTE: something')
  })

  it('handles several runs on one line', () => {
    expect(stripMarkdownForTitle('## **Bold** and `code` together'))
      .toBe('Bold and code together')
  })

  it('drops a fence marker and its language tag', () => {
    expect(stripMarkdownForTitle('```js')).toBe('')
    expect(stripMarkdownForTitle('```')).toBe('')
  })

  it('leaves unmatched delimiters alone — the editor renders those literally too', () => {
    expect(stripMarkdownForTitle('a ** dangling')).toBe('a ** dangling')
    expect(stripMarkdownForTitle('2 * 3 * 4')).toBe('2 * 3 * 4')
  })

  it('leaves ordinary prose untouched', () => {
    expect(stripMarkdownForTitle('Just a plain sentence.')).toBe('Just a plain sentence.')
  })

  it('collapses the whitespace an unwrapped run can leave behind', () => {
    expect(stripMarkdownForTitle('**a**   **b**')).toBe('a b')
  })
})
