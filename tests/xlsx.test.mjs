import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readXlsx, columnIndex, looksLikeXlsx } from '../src/lib/xlsx.ts'

const bytes = new Uint8Array(readFileSync(new URL('../samples/b1-lesen-teil.xlsx', import.meta.url)))
const sheets = readXlsx(bytes)

describe('columnIndex', () => {
  test('single letters', () => {
    assert.equal(columnIndex('A1'), 0)
    assert.equal(columnIndex('G3'), 6)
  })

  test('rolls over past Z', () => {
    assert.equal(columnIndex('AA1'), 26)
    assert.equal(columnIndex('AB12'), 27)
    assert.equal(columnIndex('BC12'), 54)
  })
})

describe('looksLikeXlsx', () => {
  test('recognises the zip signature', () => {
    assert.equal(looksLikeXlsx(bytes), true)
  })

  test('rejects plain text', () => {
    assert.equal(looksLikeXlsx(new TextEncoder().encode('german,korean')), false)
  })
})

describe('readXlsx — the real workbook', () => {
  test('finds all four sheets, in workbook order', () => {
    assert.deepEqual(
      sheets.map((s) => s.name),
      ['Teil순 단어장', '복습용', '요약', '표현만 모아보기'],
    )
  })

  test('Korean sheet names decoded correctly', () => {
    assert.ok(sheets.every((s) => !s.name.includes('&#')))
  })

  test('the word sheet has two title rows above its header', () => {
    const rows = sheets[0].rows
    assert.equal(rows[0].length, 1)
    assert.equal(rows[1].length, 1)
    assert.deepEqual(rows[2].slice(0, 5), ['Teil', '지문/문제유형', '순서', '독일어', '뜻'])
  })

  test('156 word rows', () => {
    assert.equal(sheets[0].rows.length - 3, 156)
  })

  test('15 expression rows', () => {
    assert.equal(sheets[3].rows.length - 2, 15)
  })

  test('cell values survive intact, commas included', () => {
    const first = sheets[0].rows[3]
    assert.deepEqual(first.slice(0, 6), [
      'Teil 2',
      'Mit der U-Bahn ins Skigebiet',
      '1',
      'das Skigebiet',
      '스키장, 스키 지역',
      'Gebiet = 지역',
    ])
  })

  test('no row is missing its German or its meaning', () => {
    const rows = sheets[0].rows.slice(3)
    assert.equal(rows.filter((r) => !r[3] || !r[4]).length, 0)
  })

  test('German words are unique', () => {
    const words = sheets[0].rows.slice(3).map((r) => r[3])
    assert.equal(new Set(words).size, words.length)
  })

  test('matches the counts the summary sheet claims', () => {
    const summary = Object.fromEntries(
      sheets[2].rows
        .slice(2)
        .filter((r) => /^Teil \d$/.test(r[0] ?? ''))
        .map((r) => [r[0], Number(r[1])]),
    )
    const actual = {}
    for (const row of sheets[0].rows.slice(3)) actual[row[0]] = (actual[row[0]] ?? 0) + 1

    // The summary is the workbook's own tally, so it is an independent check
    // that no row was dropped or duplicated during parsing.
    for (const [teil, count] of Object.entries(summary)) {
      if (count > 0) assert.equal(actual[teil], count, `${teil}: parsed ${actual[teil]}, sheet says ${count}`)
    }
  })

  test('numbers come through as text', () => {
    assert.equal(sheets[0].rows[3][2], '1')
  })

  test('the expression sheet keeps its own shape', () => {
    assert.deepEqual(sheets[3].rows[1], ['Teil', '표현', '뜻', '주의'])
    assert.deepEqual(sheets[3].rows[2].slice(0, 2), [
      'Teil 2',
      'im Vergleich zum Vorjahr / verglichen mit',
    ])
  })
})
