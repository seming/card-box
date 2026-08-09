import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCards, guessMapping, headerLabels, dedupeKey } from '../src/lib/import.ts'
import { parseCsv, guessHeaderRow } from '../src/lib/csv.ts'
import { readXlsx } from '../src/lib/xlsx.ts'
import { CHUNK_SIZE, CardSchema } from '../src/types.ts'

let counter = 0
const deps = (over = {}) => ({
  deckId: 'deck1',
  newId: () => `id${++counter}`,
  now: '2026-08-10T00:00:00.000Z',
  emptyFsrs: () => ({
    due: '2026-08-10T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: 0,
  }),
  ...over,
})

const mapping = (over = {}) => ({
  front: 0,
  back: 1,
  example: null,
  note: null,
  tags: [],
  ...over,
})

const opts = (over = {}) => ({ mapping: mapping(), reverse: false, duplicates: 'skip', ...over })

describe('buildCards — basics', () => {
  test('one row becomes one card', () => {
    const r = buildCards([['das Skigebiet', '스키장']], opts(), deps())
    assert.equal(r.cards.length, 1)
    assert.equal(r.cards[0].front, 'das Skigebiet')
    assert.equal(r.cards[0].back, '스키장')
  })

  test('produces cards that satisfy the schema', () => {
    const r = buildCards([['a', 'b']], opts(), deps())
    assert.doesNotThrow(() => CardSchema.parse(r.cards[0]))
  })

  test('trims surrounding whitespace', () => {
    const r = buildCards([['  das Skigebiet  ', ' 스키장 ']], opts(), deps())
    assert.equal(r.cards[0].front, 'das Skigebiet')
    assert.equal(r.cards[0].back, '스키장')
  })

  test('rows missing front or back are counted, not imported', () => {
    const r = buildCards([['a', ''], ['', 'b'], ['c', 'd']], opts(), deps())
    assert.equal(r.cards.length, 1)
    assert.equal(r.emptyRows, 2)
  })

  test('unmapped optional fields stay absent', () => {
    const r = buildCards([['a', 'b']], opts(), deps())
    assert.equal(r.cards[0].example, undefined)
    assert.equal(r.cards[0].note, undefined)
  })

  test('example and note are carried across when mapped', () => {
    const r = buildCards(
      [['a', 'b', 'Ein Satz.', 'Gebiet = 지역']],
      opts({ mapping: mapping({ example: 2, note: 3 }) }),
      deps(),
    )
    assert.equal(r.cards[0].example, 'Ein Satz.')
    assert.equal(r.cards[0].note, 'Gebiet = 지역')
  })

  test('lang is stamped on every card when given', () => {
    const r = buildCards([['a', 'b']], opts({ lang: 'de-DE' }), deps())
    assert.equal(r.cards[0].lang, 'de-DE')
  })
})

describe('buildCards — tags', () => {
  test('a tag column becomes a tag', () => {
    const r = buildCards([['a', 'b', 'Teil2']], opts({ mapping: mapping({ tags: [2] }) }), deps())
    assert.deepEqual(r.cards[0].tags, ['Teil2'])
  })

  test('several tag columns combine', () => {
    const r = buildCards(
      [['a', 'b', 'Teil2', 'noun']],
      opts({ mapping: mapping({ tags: [2, 3] }) }),
      deps(),
    )
    assert.deepEqual(r.cards[0].tags, ['Teil2', 'noun'])
  })

  test('a tag cell with spaces splits into several tags', () => {
    const r = buildCards([['a', 'b', 'Teil 2']], opts({ mapping: mapping({ tags: [2] }) }), deps())
    assert.deepEqual(r.cards[0].tags, ['Teil', '2'])
  })

  test('extraTags apply to every card', () => {
    const r = buildCards([['a', 'b'], ['c', 'd']], opts({ extraTags: ['b1'] }), deps())
    assert.ok(r.cards.every((c) => c.tags.includes('b1')))
  })

  test('duplicate tags collapse', () => {
    const r = buildCards(
      [['a', 'b', 'noun']],
      opts({ mapping: mapping({ tags: [2] }), extraTags: ['noun'] }),
      deps(),
    )
    assert.deepEqual(r.cards[0].tags, ['noun'])
  })
})

describe('buildCards — reverse cards', () => {
  test('off by default', () => {
    assert.equal(buildCards([['a', 'b']], opts(), deps()).cards.length, 1)
  })

  test('doubles the count and mirrors the sides', () => {
    const r = buildCards([['das Skigebiet', '스키장']], opts({ reverse: true }), deps())
    assert.equal(r.cards.length, 2)
    assert.deepEqual(
      r.cards.map((c) => [c.front, c.back]),
      [
        ['das Skigebiet', '스키장'],
        ['스키장', 'das Skigebiet'],
      ],
    )
  })

  test('the mirror is tagged so it can be found later', () => {
    const r = buildCards([['a', 'b']], opts({ reverse: true }), deps())
    assert.ok(!r.cards[0].tags.includes('reverse'))
    assert.ok(r.cards[1].tags.includes('reverse'))
  })

  test('each direction gets its own id', () => {
    const r = buildCards([['a', 'b']], opts({ reverse: true }), deps())
    assert.notEqual(r.cards[0].id, r.cards[1].id)
  })

  test('171 entries become 342 cards', () => {
    const rows = Array.from({ length: 171 }, (_, i) => [`de${i}`, `ko${i}`])
    assert.equal(buildCards(rows, opts({ reverse: true }), deps()).cards.length, 342)
  })
})

describe('buildCards — duplicates', () => {
  const existing = () => new Map([['das skigebiet', { id: 'old', front: 'das Skigebiet' }]])

  test('skip leaves the existing card alone', () => {
    const r = buildCards([['das Skigebiet', 'x'], ['neu', 'y']], opts(), deps({ existing: existing() }))
    assert.equal(r.cards.length, 1)
    assert.equal(r.duplicates, 1)
    assert.equal(r.cards[0].front, 'neu')
  })

  test('overwrite imports it and reports the count', () => {
    const r = buildCards(
      [['das Skigebiet', 'x']],
      opts({ duplicates: 'overwrite' }),
      deps({ existing: existing() }),
    )
    assert.equal(r.cards.length, 1)
    assert.equal(r.overwritten, 1)
  })

  test('allow imports it without comment', () => {
    const r = buildCards(
      [['das Skigebiet', 'x']],
      opts({ duplicates: 'allow' }),
      deps({ existing: existing() }),
    )
    assert.equal(r.cards.length, 1)
    assert.equal(r.duplicates, 0)
    assert.equal(r.overwritten, 0)
  })

  test('matching ignores case and padding', () => {
    const r = buildCards([['  DAS SKIGEBIET  ', 'x']], opts(), deps({ existing: existing() }))
    assert.equal(r.duplicates, 1)
  })

  test('catches duplicates inside the file itself', () => {
    const r = buildCards([['wort', 'a'], ['wort', 'b']], opts(), deps())
    assert.equal(r.cards.length, 1)
    assert.equal(r.duplicates, 1)
  })

  test('a reverse card is not mistaken for a duplicate of its own front', () => {
    // 'b' as a reverse front must not block a later row whose front is 'b'.
    const r = buildCards([['a', 'b'], ['b', 'c']], opts({ reverse: true }), deps())
    assert.equal(r.cards.length, 4)
  })
})

describe('buildCards — chunk assignment', () => {
  test('fills chunk 0 first', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`a${i}`, `b${i}`])
    assert.ok(buildCards(rows, opts(), deps()).cards.every((c) => c.chunk === 0))
  })

  test('rolls over at CHUNK_SIZE', () => {
    const rows = Array.from({ length: CHUNK_SIZE + 2 }, (_, i) => [`a${i}`, `b${i}`])
    const cards = buildCards(rows, opts(), deps()).cards
    assert.equal(cards.filter((c) => c.chunk === 0).length, CHUNK_SIZE)
    assert.equal(cards.filter((c) => c.chunk === 1).length, 2)
  })

  test('continues from where the deck already is', () => {
    const rows = Array.from({ length: 3 }, (_, i) => [`a${i}`, `b${i}`])
    const cards = buildCards(rows, opts(), deps({ startChunk: 4, startChunkCount: CHUNK_SIZE - 1 })).cards
    assert.deepEqual(cards.map((c) => c.chunk), [4, 5, 5])
  })

  test('reverse cards consume chunk slots too', () => {
    const rows = Array.from({ length: CHUNK_SIZE }, (_, i) => [`a${i}`, `b${i}`])
    const cards = buildCards(rows, opts({ reverse: true }), deps()).cards
    assert.equal(cards.length, CHUNK_SIZE * 2)
    assert.equal(cards.filter((c) => c.chunk === 0).length, CHUNK_SIZE)
    assert.equal(cards.filter((c) => c.chunk === 1).length, CHUNK_SIZE)
  })
})

describe('guessMapping', () => {
  test('recognises the real workbook header', () => {
    const headers = ['Teil', '지문/문제유형', '순서', '독일어', '뜻', '시험 포인트', '암기 체크']
    const m = guessMapping(headers)
    assert.equal(headers[m.front], '독일어')
    assert.equal(headers[m.back], '뜻')
    assert.equal(headers[m.note], '시험 포인트')
    assert.ok(m.tags.map((i) => headers[i]).includes('Teil'))
  })

  test('recognises an English header', () => {
    const headers = ['front', 'back', 'example', 'tags']
    const m = guessMapping(headers)
    assert.deepEqual([m.front, m.back, m.example], [0, 1, 2])
    assert.deepEqual(m.tags, [3])
  })

  test('leaves fields unmapped when nothing matches', () => {
    const m = guessMapping(['col1', 'col2'])
    assert.equal(m.front, null)
    assert.equal(m.back, null)
  })

  test('never maps one column to two fields', () => {
    const m = guessMapping(['word', 'meaning', 'example', 'note'])
    const used = [m.front, m.back, m.example, m.note].filter((i) => i !== null)
    assert.equal(new Set(used).size, used.length)
  })
})

describe('headerLabels', () => {
  test('falls back for blank header cells', () => {
    assert.deepEqual(headerLabels(['a', '', 'c'], 4), ['a', 'Column 2', 'c', 'Column 4'])
  })
})

describe('dedupeKey', () => {
  test('case and padding insensitive', () => {
    assert.equal(dedupeKey('  Das Skigebiet '), dedupeKey('das skigebiet'))
  })
})

describe('end to end — the real deck', () => {
  test('csv → 334 cards, with four genuine duplicates skipped', () => {
    const text = readFileSync(new URL('../samples/b1-lesen-teil.csv', import.meta.url), 'utf8')
    const rows = parseCsv(text)
    const header = guessHeaderRow(rows)
    const headers = rows[header]

    assert.deepEqual(headers.slice(0, 3), ['german', 'korean', 'exam_point'])

    const r = buildCards(
      rows.slice(header + 1),
      {
        mapping: { front: 0, back: 1, example: null, note: 2, tags: [3] },
        reverse: true,
        duplicates: 'skip',
        lang: 'de-DE',
      },
      deps(),
    )

    // The workbook holds 171 entries but only 167 distinct German terms: four
    // expressions — ein Verbot fordern, mit viel Flüssigkeit, den Arzt aufsuchen,
    // beeinträchtigt sein — appear on both the word sheet and the expression
    // sheet, worded slightly differently in Korean. This is the deck's own
    // property, not a parsing fault, and it is what deduplication is for.
    assert.equal(rows.length - 1, 171)
    assert.equal(r.duplicates, 4)
    assert.equal(r.cards.length, 334)
    assert.equal(r.emptyRows, 0)
    assert.ok(r.cards.every((c) => c.lang === 'de-DE'))
    assert.equal(r.cards.filter((c) => c.tags.includes('reverse')).length, 167)
  })

  test('allowing duplicates keeps all 171 entries', () => {
    const text = readFileSync(new URL('../samples/b1-lesen-teil.csv', import.meta.url), 'utf8')
    const rows = parseCsv(text)
    const r = buildCards(
      rows.slice(1),
      {
        mapping: { front: 0, back: 1, example: null, note: 2, tags: [3] },
        reverse: true,
        duplicates: 'allow',
      },
      deps(),
    )
    assert.equal(r.cards.length, 342)
  })

  test('xlsx → the same 342 cards, straight from the workbook', () => {
    const bytes = new Uint8Array(readFileSync(new URL('../samples/b1-lesen-teil.xlsx', import.meta.url)))
    const sheet = readXlsx(bytes)[0]
    const header = guessHeaderRow(sheet.rows)
    assert.equal(header, 2)

    const m = guessMapping(sheet.rows[header])
    const r = buildCards(sheet.rows.slice(header + 1), {
      mapping: m,
      reverse: true,
      duplicates: 'skip',
      lang: 'de-DE',
    }, deps())

    // 156 words in this sheet; the 15 expressions live on another one.
    assert.equal(r.cards.length, 312)
    assert.equal(r.emptyRows, 0)
    assert.equal(r.cards[0].front, 'das Skigebiet')
    assert.equal(r.cards[0].back, '스키장, 스키 지역')
    assert.equal(r.cards[0].note, 'Gebiet = 지역')
    assert.ok(r.cards[0].tags.includes('Teil'))
  })
})
