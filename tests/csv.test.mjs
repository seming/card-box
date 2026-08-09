import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseCsv,
  parseDelimited,
  detectDelimiter,
  stripBom,
  guessHeaderRow,
  squareUp,
} from '../src/lib/csv.ts'

describe('parseDelimited', () => {
  test('plain rows', () => {
    assert.deepEqual(parseDelimited('a,b\nc,d', ','), [
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  test('quoted field containing the delimiter', () => {
    // This is the shape that matters: 56 of 156 meanings in the real deck have a comma.
    assert.deepEqual(parseDelimited('"das Skigebiet","스키장, 스키 지역"', ','), [
      ['das Skigebiet', '스키장, 스키 지역'],
    ])
  })

  test('quoted field containing a newline', () => {
    assert.deepEqual(parseDelimited('"line one\nline two",b', ','), [['line one\nline two', 'b']])
  })

  test('escaped quotes', () => {
    assert.deepEqual(parseDelimited('"he said ""hallo""",b', ','), [['he said "hallo"', 'b']])
  })

  test('empty fields survive', () => {
    assert.deepEqual(parseDelimited('a,,c', ','), [['a', '', 'c']])
  })

  test('CRLF line endings', () => {
    assert.deepEqual(parseDelimited('a,b\r\nc,d\r\n', ','), [
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  test('blank lines are dropped', () => {
    assert.deepEqual(parseDelimited('a,b\n\n\nc,d', ','), [
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  test('a row of only empty fields is dropped', () => {
    assert.deepEqual(parseDelimited('a,b\n,,\nc,d', ','), [
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  test('no trailing newline still yields the last row', () => {
    assert.deepEqual(parseDelimited('a,b', ','), [['a', 'b']])
  })

  test('tabs', () => {
    assert.deepEqual(parseDelimited('a\tb\nc\td', '\t'), [
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  test('a quote mid-field is literal, not an opener', () => {
    assert.deepEqual(parseDelimited('5" nail,b', ','), [['5" nail', 'b']])
  })

  test('ragged rows are preserved as-is', () => {
    assert.deepEqual(parseDelimited('a,b,c\nd,e', ','), [
      ['a', 'b', 'c'],
      ['d', 'e'],
    ])
  })
})

describe('stripBom', () => {
  test('removes a leading BOM', () => {
    assert.equal(stripBom('﻿Teil'), 'Teil')
  })

  test('leaves clean text alone', () => {
    assert.equal(stripBom('Teil'), 'Teil')
  })

  test('a BOM does not corrupt the first header cell', () => {
    assert.deepEqual(parseCsv('﻿a,b\n1,2'), [
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('detectDelimiter', () => {
  test('comma', () => {
    assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',')
  })

  test('tab', () => {
    assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t')
  })

  test('semicolon, as European Excel writes', () => {
    assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';')
  })

  test('is not fooled by commas inside quoted fields', () => {
    // Tab-separated, but the quoted cells are full of commas.
    const text = 'de\tko\n"das Skigebiet"\t"스키장, 스키 지역"\n"die Kassen"\t"금고, 수입"'
    assert.equal(detectDelimiter(text), '\t')
  })

  test('falls back to comma on a single column', () => {
    assert.equal(detectDelimiter('just\none\ncolumn'), ',')
  })
})

describe('guessHeaderRow', () => {
  test('first row when the file is a plain table', () => {
    assert.equal(
      guessHeaderRow([
        ['a', 'b'],
        ['1', '2'],
      ]),
      0,
    )
  })

  test('skips title lines above the header', () => {
    // The real workbook has exactly this shape.
    const rows = [
      ['B1 Lesen 노란색 단어장 — Teil 순서'],
      ['사진으로 보낸 노란색 단어만'],
      ['Teil', '지문/문제유형', '순서', '독일어', '뜻', '시험 포인트', '암기 체크'],
      ['Teil 2', 'Mit der U-Bahn ins Skigebiet', '1', 'das Skigebiet', '스키장, 스키 지역', 'Gebiet = 지역'],
    ]
    assert.equal(guessHeaderRow(rows), 2)
  })

  test('empty input', () => {
    assert.equal(guessHeaderRow([]), 0)
  })
})

describe('squareUp', () => {
  test('pads short rows', () => {
    assert.deepEqual(squareUp([['a']], 3), [['a', '', '']])
  })

  test('truncates long rows', () => {
    assert.deepEqual(squareUp([['a', 'b', 'c', 'd']], 2), [['a', 'b']])
  })
})

describe('the real deck', () => {
  const text = readFileSync(new URL('../samples/b1-lesen-teil.csv', import.meta.url), 'utf8')
  const rows = parseCsv(text)

  test('parses to 171 cards plus a header', () => {
    assert.equal(rows.length, 172)
  })

  test('every row has all seven columns', () => {
    const widths = new Set(rows.map((r) => r.length))
    assert.deepEqual([...widths], [7])
  })

  test('commas inside meanings stayed inside their field', () => {
    const skigebiet = rows.find((r) => r[0] === 'das Skigebiet')
    assert.deepEqual(skigebiet?.slice(0, 3), ['das Skigebiet', '스키장, 스키 지역', 'Gebiet = 지역'])
  })

  test('no field leaked a stray quote', () => {
    assert.ok(!rows.some((r) => r.some((c) => c.startsWith('"') || c.endsWith('"'))))
  })
})
