import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuery, search, QUICK_FILTERS } from '../src/lib/search.ts'
import { State } from '../src/types.ts'

const NOW = new Date(2026, 7, 10, 12, 0, 0, 0)
const iso = (d) => d.toISOString()
const days = (n) => iso(new Date(NOW.getTime() + n * 86400000))

let n = 0
const card = (over = {}) => {
  n++
  const { state = State.Review, scheduled_days = 5, due = days(-1), fsrs = {}, ...rest } = over
  return {
    id: `c${n}`,
    deckId: 'd1',
    chunk: 0,
    front: `front${n}`,
    back: `back${n}`,
    tags: [],
    fsrs: {
      due,
      stability: 10,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days,
      learning_steps: 0,
      reps: 1,
      lapses: 0,
      state,
      ...fsrs,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...rest,
  }
}

const find = (cards, q) => search(cards, q, { now: NOW }).map((c) => c.front)

describe('parseQuery', () => {
  test('bare words are text terms', () => {
    assert.deepEqual(parseQuery('abend'), [{ negated: false, kind: 'text', value: 'abend' }])
  })

  test('several words are separate terms, all required', () => {
    assert.equal(parseQuery('der abend').length, 2)
  })

  test('quoted phrases stay together', () => {
    assert.deepEqual(parseQuery('"der Arm"'), [{ negated: false, kind: 'text', value: 'der arm' }])
  })

  test('a leading dash negates', () => {
    const [t] = parseQuery('-tag:reverse')
    assert.equal(t.negated, true)
    assert.equal(t.kind, 'tag')
    assert.equal(t.value, 'reverse')
  })

  test('a lone dash is just text', () => {
    assert.equal(parseQuery('-')[0].kind, 'text')
  })

  test('field prefixes', () => {
    assert.equal(parseQuery('tag:noun')[0].kind, 'tag')
    assert.equal(parseQuery('is:due')[0].kind, 'is')
    assert.equal(parseQuery('deck:german')[0].kind, 'deck')
  })

  test('prop parses field, operator and number', () => {
    const [t] = parseQuery('prop:ivl>=21')
    assert.deepEqual(t.prop, { field: 'ivl', op: '>=', number: 21 })
  })

  test('a malformed prop degrades to text rather than matching nothing', () => {
    assert.equal(parseQuery('prop:garbage')[0].kind, 'text')
  })

  test('an empty query has no terms', () => {
    assert.deepEqual(parseQuery('   '), [])
  })
})

describe('text search', () => {
  const cards = [
    card({ front: 'der Abend', back: '저녁', tags: ['noun'] }),
    card({ front: 'abfahren', back: '출발하다', example: 'Wir fahren ab.' }),
    card({ front: 'die Abfahrt', back: '출발', note: 'Abend와 헷갈리지 않기' }),
  ]

  test('an empty query returns everything', () => {
    assert.equal(find(cards, '').length, 3)
  })

  test('matches the front', () => {
    assert.deepEqual(find(cards, 'abend'), ['der Abend', 'die Abfahrt'])
  })

  test('matches the back', () => {
    assert.deepEqual(find(cards, '출발하다'), ['abfahren'])
  })

  test('matches the example and the note', () => {
    assert.deepEqual(find(cards, 'fahren ab'), ['abfahren'])
    assert.deepEqual(find(cards, '헷갈리'), ['die Abfahrt'])
  })

  test('matches tags as text too', () => {
    assert.deepEqual(find(cards, 'noun'), ['der Abend'])
  })

  test('case-insensitive', () => {
    assert.deepEqual(find(cards, 'ABEND'), ['der Abend', 'die Abfahrt'])
  })

  test('two words must both appear, in any order', () => {
    assert.deepEqual(find(cards, 'der abend'), ['der Abend'])
    assert.deepEqual(find(cards, 'abend der'), ['der Abend'])
  })

  test('a quoted phrase requires the whole thing', () => {
    assert.deepEqual(find(cards, '"der Abend"'), ['der Abend'])
    assert.deepEqual(find(cards, '"abend der"'), [])
  })

  test('deleted cards never match', () => {
    assert.deepEqual(find([...cards, card({ front: 'gone', deleted: true })], ''), [
      'der Abend',
      'abfahren',
      'die Abfahrt',
    ])
  })
})

describe('tag:', () => {
  const cards = [
    card({ front: 'a', tags: ['noun', 'star3'] }),
    card({ front: 'b', tags: ['reverse'] }),
    card({ front: 'c', tags: [] }),
  ]

  test('exact tag, not a substring', () => {
    assert.deepEqual(find(cards, 'tag:noun'), ['a'])
    assert.deepEqual(find(cards, 'tag:nou'), [])
  })

  test('negation excludes', () => {
    assert.deepEqual(find(cards, '-tag:reverse'), ['a', 'c'])
  })

  test('combines with text', () => {
    assert.deepEqual(find(cards, 'tag:star3 tag:noun'), ['a'])
  })
})

describe('is:', () => {
  const cards = [
    card({ front: 'new', state: State.New }),
    card({ front: 'learning', state: State.Learning }),
    card({ front: 'young', state: State.Review, scheduled_days: 5 }),
    card({ front: 'mature', state: State.Review, scheduled_days: 40 }),
    card({ front: 'later', state: State.Review, due: days(5) }),
    card({ front: 'suspended', suspended: true }),
    card({ front: 'buried', buriedUntil: days(1) }),
    card({ front: 'mirror', tags: ['reverse'] }),
  ]

  test('by state', () => {
    assert.deepEqual(find(cards, 'is:new'), ['new'])
    assert.deepEqual(find(cards, 'is:learn'), ['learning'])
  })

  test('young and mature split at 21 days', () => {
    assert.ok(find(cards, 'is:young').includes('young'))
    assert.ok(!find(cards, 'is:young').includes('mature'))
    assert.ok(find(cards, 'is:mature').includes('mature'))
  })

  test('is:due excludes cards scheduled ahead', () => {
    assert.ok(!find(cards, 'is:due').includes('later'))
    assert.ok(find(cards, 'is:due').includes('young'))
  })

  test('a suspended card is never due, whatever its date says', () => {
    assert.ok(!find(cards, 'is:due').includes('suspended'))
    assert.deepEqual(find(cards, 'is:suspended'), ['suspended'])
  })

  test('a buried card is not due until its moment passes', () => {
    assert.ok(!find(cards, 'is:due').includes('buried'))
    assert.deepEqual(find(cards, 'is:buried'), ['buried'])
  })

  test('a bury that has expired no longer holds', () => {
    const expired = [card({ front: 'freed', buriedUntil: days(-1) })]
    assert.deepEqual(find(expired, 'is:buried'), [])
    assert.deepEqual(find(expired, 'is:due'), ['freed'])
  })

  test('is:reverse finds the mirror direction', () => {
    assert.deepEqual(find(cards, 'is:reverse'), ['mirror'])
  })

  test('an unknown is: matches nothing rather than everything', () => {
    assert.deepEqual(find(cards, 'is:nonsense'), [])
  })
})

describe('prop:', () => {
  const cards = [
    card({ front: 'short', scheduled_days: 3, fsrs: { lapses: 0, reps: 2 } }),
    card({ front: 'long', scheduled_days: 100, fsrs: { lapses: 1, reps: 9 } }),
    card({ front: 'leech', scheduled_days: 1, fsrs: { lapses: 12, reps: 30 } }),
  ]

  test('interval comparisons', () => {
    assert.deepEqual(find(cards, 'prop:ivl>=21'), ['long'])
    assert.deepEqual(find(cards, 'prop:ivl<5'), ['short', 'leech'])
  })

  test('lapses finds leeches — the quick filter is this query', () => {
    assert.deepEqual(find(cards, 'prop:lapses>=8'), ['leech'])
    assert.ok(QUICK_FILTERS.some((f) => f.query === 'prop:lapses>=8'))
  })

  test('equality and inequality', () => {
    assert.deepEqual(find(cards, 'prop:reps=9'), ['long'])
    assert.equal(find(cards, 'prop:reps!=9').length, 2)
  })

  test('stability and difficulty are queryable', () => {
    const c = [card({ front: 'hard', fsrs: { difficulty: 9, stability: 2 } })]
    assert.deepEqual(find(c, 'prop:difficulty>8'), ['hard'])
    assert.deepEqual(find(c, 'prop:s<3'), ['hard'])
  })

  test('an unknown field matches nothing', () => {
    assert.deepEqual(find(cards, 'prop:nope>1'), [])
  })
})

describe('deck:', () => {
  test('matches the deck name, not the id', () => {
    const cards = [card({ front: 'a', deckId: 'd1' }), card({ front: 'b', deckId: 'd2' })]
    const names = new Map([['d1', 'German core'], ['d2', 'B1 Lesen']])
    assert.deepEqual(
      search(cards, 'deck:german', { now: NOW, deckNames: names }).map((c) => c.front),
      ['a'],
    )
  })
})

describe('combining', () => {
  const cards = [
    card({ front: 'der Abend', tags: ['noun'], state: State.New }),
    card({ front: '저녁', tags: ['noun', 'reverse'], state: State.New }),
    card({ front: 'alt', tags: ['other'], state: State.Review, scheduled_days: 40 }),
  ]

  test('every term must hold', () => {
    assert.deepEqual(find(cards, 'is:new tag:noun -tag:reverse'), ['der Abend'])
  })

  test('text and field terms mix', () => {
    assert.deepEqual(find(cards, 'abend is:new'), ['der Abend'])
  })

  test('contradictory terms return nothing, not everything', () => {
    assert.deepEqual(find(cards, 'is:new is:mature'), [])
  })
})
