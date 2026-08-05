import { describe, expect, it } from 'vitest'
import {
  classifyLines,
  isTableDelimText,
  isTableRowText,
  parseTableAligns,
  splitTableRow,
} from '../src/markdown-syntax'
import { tableColumnTemplate } from '../src/views/editor-view'

const TABLE = [
  '| Name | Role     |',
  '| ---- | -------- |',
  '| Ada  | Engineer |',
  '| Bob  | Writer   |',
]

describe('table line detection', () => {
  it('requires the outer pipes so prose containing one stays prose', () => {
    expect(isTableRowText('| a | b |')).toBe(true)
    expect(isTableRowText('| a | b |  ')).toBe(true)
    expect(isTableRowText('a | b')).toBe(false)
    expect(isTableRowText('| a | b')).toBe(false)
    expect(isTableRowText('either | or')).toBe(false)
    expect(isTableRowText('|')).toBe(false)
  })

  it('accepts the delimiter row in every alignment spelling', () => {
    expect(isTableDelimText('| --- | --- |')).toBe(true)
    expect(isTableDelimText('|---|---|')).toBe(true)
    expect(isTableDelimText('| :--- | ---: | :---: |')).toBe(true)
    expect(isTableDelimText('| --- | text |')).toBe(false)
    expect(isTableDelimText('| Name | Role |')).toBe(false)
  })
})

describe('classifying a table', () => {
  it('names the header, delimiter and body rows', () => {
    expect(classifyLines(TABLE))
      .toEqual(['table-head', 'table-delim', 'table-row', 'table-row'])
  })

  it('leaves a pipe row alone until a delimiter sits under it', () => {
    expect(classifyLines(['| a | b |', 'prose'])).toEqual(['body', 'body'])
  })

  it('ends the table at the first line that is not a row', () => {
    expect(classifyLines([...TABLE, '', 'after']))
      .toEqual(['table-head', 'table-delim', 'table-row', 'table-row', 'body', 'body'])
  })

  it('reveals only the delimiter row the caret is on', () => {
    expect(classifyLines(TABLE, 1))
      .toEqual(['table-head', 'source', 'table-row', 'table-row'])
  })

  it('does not read a table out of fenced code', () => {
    const src = ['```', '| a | b |', '| - | - |', '```', '| a | b |', '| - | - |']
    expect(classifyLines(src)).toEqual([
      'code-fence-open', 'code-content', 'code-content', 'code-fence-close',
      'table-head', 'table-delim',
    ])
  })

  it('reads two tables separated by prose', () => {
    const src = [...TABLE, 'between', '| x | y |', '| - | - |', '| 1 | 2 |']
    expect(classifyLines(src)).toEqual([
      'table-head', 'table-delim', 'table-row', 'table-row',
      'body',
      'table-head', 'table-delim', 'table-row',
    ])
  })
})

describe('splitting a row into markers and cells', () => {
  it('round-trips the source exactly', () => {
    for (const row of [...TABLE, '|a|b|', '| | |', '||', '| trailing |   ']) {
      const parts = splitTableRow(row)!
      expect(parts).not.toBeNull()
      expect(parts.markers.length).toBe(parts.cells.length + 1)
      const rejoined = parts.markers
        .map((marker, i) => marker + (parts.cells[i] ?? ''))
        .join('')
      expect(rejoined).toBe(row)
    }
  })

  it('hangs the padding on the markers so cells hold only content', () => {
    const parts = splitTableRow('| Ada  | Engineer |')!
    expect(parts.cells).toEqual(['Ada', 'Engineer'])
    expect(parts.markers).toEqual(['| ', '  | ', ' |'])
  })

  it('shares an empty cell\'s padding between its two markers', () => {
    // The row a fresh table is seeded with. Typing into it has to grow
    // `| a | b |`, so each empty cell needs a space on either side.
    const parts = splitTableRow('|  |  |')!
    expect(parts.cells).toEqual(['', ''])
    expect(parts.markers).toEqual(['| ', ' | ', ' |'])
  })

  it('treats every pipe as a cell break', () => {
    expect(splitTableRow('| a \\| b | c |')!.cells).toEqual(['a \\', 'b', 'c'])
  })

  it('refuses text that has no pair of pipes', () => {
    expect(splitTableRow('no pipes here')).toBeNull()
    expect(splitTableRow('| one')).toBeNull()
  })
})

describe('column layout', () => {
  it('sizes each column by its longest cell', () => {
    expect(tableColumnTemplate(['| Name | Role |', '| Ada | Engineer |']))
      .toBe('minmax(0, 4fr) minmax(0, 8fr)')
  })

  it('clamps so a short column keeps room and a long one leaves some', () => {
    expect(tableColumnTemplate(['| y | ' + 'x'.repeat(80) + ' |']))
      .toBe('minmax(0, 4fr) minmax(0, 24fr)')
  })

  it('widens to the row with the most columns', () => {
    expect(tableColumnTemplate(['| a | b |', '| a | b | c |']))
      .toBe('minmax(0, 4fr) minmax(0, 4fr) minmax(0, 4fr)')
  })

  it('reads alignment off the delimiter row', () => {
    expect(parseTableAligns('| :--- | ---: | :---: | --- |'))
      .toEqual(['left', 'right', 'center', null])
    expect(parseTableAligns('not a row')).toEqual([])
  })
})
