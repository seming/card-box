import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQueue,
  queueCounts,
  remainingToday,
  todaysReviews,
  nextDue,
  noteOf,
} from '../src/lib/queue.ts'
import { State, Rating, SettingsSchema } from '../src/types.ts'

const settings = SettingsSchema.parse({})
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0)

let n = 0
function card(state, dueAt, extra = {}) {
  n++
  const iso = dueAt instanceof Date ? dueAt.toISOString() : dueAt
  return {
    id: extra.id ?? `c${String(n).padStart(3, '0')}`,
    deckId: 'd1',
    chunk: 0,
    front: `front ${n}`,
    back: `back ${n}`,
    tags: [],
    fsrs: {
      due: iso,
      stability: 1,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: state === State.New ? 0 : 1,
      lapses: 0,
      state,
    },
    createdAt: extra.createdAt ?? `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

function logEntry(state, reviewAt, deckId = 'd1') {
  n++
  return {
    id: `l${n}`,
    cardId: `c${n}`,
    deckId,
    rating: Rating.Good,
    state,
    due: reviewAt.toISOString(),
    stability: 1,
    difficulty: 5,
    elapsed_days: 0,
    last_elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 0,
    review: reviewAt.toISOString(),
    duration: 3000,
  }
}

const input = (cards, now, todayLog = [], over = {}) => ({
  cards,
  todayLog,
  settings: { ...settings, ...over },
  now,
  seed: 42,
})

describe('remainingToday', () => {
  test('starts at the configured limits', () => {
    assert.deepEqual(remainingToday([], settings), { newLeft: 20, reviewLeft: 200 })
  })

  test('new answers consume the new allowance', () => {
    const log = [logEntry(State.New, at(2026, 8, 8, 10)), logEntry(State.New, at(2026, 8, 8, 11))]
    assert.equal(remainingToday(log, settings).newLeft, 18)
    assert.equal(remainingToday(log, settings).reviewLeft, 200)
  })

  test('review answers consume the review allowance', () => {
    const log = [logEntry(State.Review, at(2026, 8, 8, 10))]
    assert.equal(remainingToday(log, settings).reviewLeft, 199)
    assert.equal(remainingToday(log, settings).newLeft, 20)
  })

  test('learning repeats consume nothing', () => {
    const log = [
      logEntry(State.Learning, at(2026, 8, 8, 10)),
      logEntry(State.Learning, at(2026, 8, 8, 10, 5)),
      logEntry(State.Relearning, at(2026, 8, 8, 10, 6)),
    ]
    assert.deepEqual(remainingToday(log, settings), { newLeft: 20, reviewLeft: 200 })
  })

  test('never goes negative', () => {
    const log = Array.from({ length: 30 }, () => logEntry(State.New, at(2026, 8, 8, 10)))
    assert.equal(remainingToday(log, settings).newLeft, 0)
  })
})

describe('todaysReviews', () => {
  test('3am belongs to the previous study day', () => {
    const log = [
      logEntry(State.Review, at(2026, 8, 8, 3, 0)), // still 8/7's study day
      logEntry(State.Review, at(2026, 8, 8, 5, 0)), // 8/8
    ]
    const now = at(2026, 8, 8, 12, 0)
    assert.equal(todaysReviews(log, now, settings).length, 1)
  })

  test('a late-night session counts toward the day it started in', () => {
    const log = [logEntry(State.Review, at(2026, 8, 8, 23, 30))]
    // 01:00 the next morning is still the same study day
    assert.equal(todaysReviews(log, at(2026, 8, 9, 1, 0), settings).length, 1)
    // 05:00 is a new one
    assert.equal(todaysReviews(log, at(2026, 8, 9, 5, 0), settings).length, 0)
  })
})

describe('buildQueue — ordering', () => {
  test('due learning cards come before reviews and new cards', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      card(State.New, now),
      card(State.Review, at(2026, 8, 8, 6, 0)),
      card(State.Learning, at(2026, 8, 8, 11, 55), { id: 'learn' }),
    ]
    assert.equal(buildQueue(input(cards, now))[0].id, 'learn')
  })

  test('relearning is treated like learning', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      card(State.Review, at(2026, 8, 8, 6, 0)),
      card(State.Relearning, at(2026, 8, 8, 11, 0), { id: 'relearn' }),
    ]
    assert.equal(buildQueue(input(cards, now))[0].id, 'relearn')
  })

  test('a learning step scheduled later today is not shown yet', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [card(State.Learning, at(2026, 8, 8, 23, 0), { id: 'later' })]
    assert.equal(buildQueue(input(cards, now)).length, 0)
  })

  test('learning cards are ordered by due time', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      card(State.Learning, at(2026, 8, 8, 11, 50), { id: 'b' }),
      card(State.Learning, at(2026, 8, 8, 11, 10), { id: 'a' }),
    ]
    assert.deepEqual(
      buildQueue(input(cards, now)).map((c) => c.id),
      ['a', 'b'],
    )
  })

  test('reviews due tomorrow are excluded', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      card(State.Review, at(2026, 8, 8, 20, 0), { id: 'today' }),
      card(State.Review, at(2026, 8, 9, 12, 0), { id: 'tomorrow' }),
    ]
    assert.deepEqual(
      buildQueue(input(cards, now)).map((c) => c.id),
      ['today'],
    )
  })

  test('a review due later tonight still counts as today', () => {
    // The study day runs to 04:00, so 02:00 tomorrow is still "today".
    const now = at(2026, 8, 8, 22, 0)
    const cards = [card(State.Review, at(2026, 8, 9, 2, 0), { id: 'small-hours' })]
    assert.equal(buildQueue(input(cards, now)).length, 1)
  })

  test('deleted cards never appear', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      card(State.Review, at(2026, 8, 8, 6, 0), { id: 'gone', deleted: true }),
      card(State.New, now, { id: 'kept' }),
    ]
    assert.deepEqual(
      buildQueue(input(cards, now)).map((c) => c.id),
      ['kept'],
    )
  })

  test('new cards follow creation order', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      card(State.New, now, { id: 'second', createdAt: '2026-02-01T00:00:00.000Z' }),
      card(State.New, now, { id: 'first', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    assert.deepEqual(
      buildQueue(input(cards, now)).map((c) => c.id),
      ['first', 'second'],
    )
  })

  test('is deterministic for a given seed', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 12 }, () => card(State.Review, at(2026, 8, 8, 6, 0)))
    const a = buildQueue(input(cards, now)).map((c) => c.id)
    const b = buildQueue(input(cards, now)).map((c) => c.id)
    assert.deepEqual(a, b)
  })

  test('cards due at the same second are not always in insertion order', () => {
    const now = at(2026, 8, 8, 12, 0)
    const due = at(2026, 8, 8, 6, 0)
    const cards = Array.from({ length: 20 }, (_, i) =>
      card(State.Review, due, { id: `r${String(i).padStart(2, '0')}` }),
    )
    const order = buildQueue(input(cards, now)).map((c) => c.id)
    assert.notDeepEqual(order, cards.map((c) => c.id))
    assert.deepEqual([...order].sort(), cards.map((c) => c.id).sort())
  })
})

describe('buildQueue — daily limits', () => {
  test('caps new cards at the limit', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 50 }, () => card(State.New, now))
    assert.equal(buildQueue(input(cards, now)).length, 20)
  })

  test('respects new cards already answered today', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 50 }, () => card(State.New, now))
    const log = Array.from({ length: 15 }, () => logEntry(State.New, at(2026, 8, 8, 10)))
    assert.equal(buildQueue(input(cards, now, log)).length, 5)
  })

  test('caps reviews at the limit', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 300 }, () => card(State.Review, at(2026, 8, 8, 6, 0)))
    assert.equal(buildQueue(input(cards, now)).length, 200)
  })

  test('learning cards ignore the limits entirely', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 5 }, () => card(State.Learning, at(2026, 8, 8, 11)))
    const log = [
      ...Array.from({ length: 20 }, () => logEntry(State.New, at(2026, 8, 8, 10))),
      ...Array.from({ length: 200 }, () => logEntry(State.Review, at(2026, 8, 8, 10))),
    ]
    assert.equal(buildQueue(input(cards, now, log)).length, 5)
  })

  test('yesterday’s answers do not count against today', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 50 }, () => card(State.New, now))
    const log = Array.from({ length: 20 }, () => logEntry(State.New, at(2026, 8, 7, 10)))
    // todaysReviews is the caller's job; passing yesterday's entries unfiltered
    // would wrongly zero the allowance, which is what this guards.
    assert.equal(buildQueue(input(cards, now, todaysReviews(log, now, settings))).length, 20)
  })

  test('a zero limit disables new cards', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 10 }, () => card(State.New, now))
    assert.equal(buildQueue(input(cards, now, [], { newPerDay: 0 })).length, 0)
  })
})

describe('buildQueue — interleaving', () => {
  test('new cards are spread through reviews, not appended', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      ...Array.from({ length: 20 }, (_, i) =>
        card(State.Review, at(2026, 8, 8, 6, 0), { id: `r${String(i).padStart(2, '0')}` }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        card(State.New, now, { id: `n${i}`, createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
      ),
    ]
    const order = buildQueue(input(cards, now)).map((c) => c.id)
    const positions = order.flatMap((id, i) => (id.startsWith('n') ? [i] : []))

    assert.equal(order.length, 24)
    assert.equal(positions.length, 4)
    // The last new card lands well before the end rather than being tacked on.
    assert.ok(positions[3] < 20, `last new card at ${positions[3]}, expected < 20`)
    // And they are not bunched at the very front either.
    assert.ok(positions[3] - positions[0] >= 12, `spread was only ${positions[3] - positions[0]}`)
  })

  test('new cards alone still come back', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 3 }, () => card(State.New, now))
    assert.equal(buildQueue(input(cards, now)).length, 3)
  })

  test('reviews alone still come back', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 3 }, () => card(State.Review, at(2026, 8, 8, 6)))
    assert.equal(buildQueue(input(cards, now)).length, 3)
  })

  test('no card is lost or duplicated', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      ...Array.from({ length: 7 }, () => card(State.Review, at(2026, 8, 8, 6))),
      ...Array.from({ length: 5 }, () => card(State.New, now)),
      ...Array.from({ length: 2 }, () => card(State.Learning, at(2026, 8, 8, 11))),
    ]
    const ids = buildQueue(input(cards, now)).map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(ids.length, 14)
  })
})

describe('queueCounts', () => {
  test('agrees with the queue it describes', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      ...Array.from({ length: 30 }, () => card(State.Review, at(2026, 8, 8, 6))),
      ...Array.from({ length: 40 }, () => card(State.New, now)),
      ...Array.from({ length: 3 }, () => card(State.Learning, at(2026, 8, 8, 11))),
    ]
    const counts = queueCounts(input(cards, now))
    assert.deepEqual(
      { learning: counts.learning, review: counts.review, new: counts.new },
      { learning: 3, review: 30, new: 20 },
    )
    assert.equal(counts.total, buildQueue(input(cards, now)).length)
  })

  test('unseen reports the whole backlog, ignoring the daily cap', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = Array.from({ length: 342 }, () => card(State.New, now))
    const counts = queueCounts(input(cards, now))
    assert.equal(counts.unseen, 342)
    assert.equal(counts.new, 20)
  })
})

describe('nextDue', () => {
  test('null when nothing is scheduled', () => {
    assert.equal(nextDue([card(State.New, at(2026, 8, 8, 12))], at(2026, 8, 8, 12)), null)
  })

  test('returns the soonest future due date', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [
      card(State.Review, at(2026, 8, 12, 5)),
      card(State.Review, at(2026, 8, 10, 5), { id: 'soonest' }),
    ]
    assert.deepEqual(nextDue(cards, now), at(2026, 8, 10, 5))
  })

  test('returns now when something is already due', () => {
    const now = at(2026, 8, 8, 12, 0)
    assert.deepEqual(nextDue([card(State.Review, at(2026, 8, 8, 6))], now), now)
  })

  test('ignores deleted cards', () => {
    const now = at(2026, 8, 8, 12, 0)
    const cards = [card(State.Review, at(2026, 8, 9, 5), { deleted: true })]
    assert.equal(nextDue(cards, now), null)
  })
})


describe('daily limits are per deck', () => {
  // Regression: the limits used to be counted across every deck at once, so
  // finishing one deck made a deck imported minutes later report "done for
  // today" without ever having been seen.
  const now = at(2026, 8, 8, 12, 0)

  test('one deck’s answers do not consume another’s allowance', () => {
    const deckA = Array.from({ length: 5 }, () => card(State.New, now, { deckId: 'A' }))
    const deckB = Array.from({ length: 30 }, () => card(State.New, now, { deckId: 'B' }))
    const log = Array.from({ length: 20 }, () => logEntry(State.New, at(2026, 8, 8, 10), 'A'))

    const counts = queueCounts(input([...deckA, ...deckB], now, log))
    assert.equal(counts.new, 20, 'deck B should still get its full allowance')
    assert.equal(buildQueue(input([...deckA, ...deckB], now, log)).length, 20)
  })

  test('a freshly imported deck is reviewable on a day already spent elsewhere', () => {
    const spent = Array.from({ length: 20 }, () => logEntry(State.New, at(2026, 8, 8, 10), 'old'))
    const imported = Array.from({ length: 312 }, () => card(State.New, now, { deckId: 'new' }))

    const counts = queueCounts(input(imported, now, spent))
    assert.equal(counts.new, 20)
    assert.equal(counts.total, 20)
    assert.equal(counts.unseen, 312)
  })

  test('the exhausted deck really is exhausted', () => {
    const deckA = Array.from({ length: 5 }, () => card(State.New, now, { deckId: 'A' }))
    const log = Array.from({ length: 20 }, () => logEntry(State.New, at(2026, 8, 8, 10), 'A'))
    assert.equal(queueCounts(input(deckA, now, log)).total, 0)
  })

  test('remainingToday scopes to a deck when asked', () => {
    const log = [
      ...Array.from({ length: 20 }, () => logEntry(State.New, at(2026, 8, 8, 10), 'A')),
      ...Array.from({ length: 3 }, () => logEntry(State.New, at(2026, 8, 8, 10), 'B')),
    ]
    assert.equal(remainingToday(log, settings, 'A').newLeft, 0)
    assert.equal(remainingToday(log, settings, 'B').newLeft, 17)
    assert.equal(remainingToday(log, settings).newLeft, 0, 'unscoped still counts everything')
  })

  test('review limits are per deck too', () => {
    const deckB = Array.from({ length: 10 }, () => card(State.Review, at(2026, 8, 8, 6), { deckId: 'B' }))
    const log = Array.from({ length: 200 }, () => logEntry(State.Review, at(2026, 8, 8, 10), 'A'))
    assert.equal(queueCounts(input(deckB, now, log)).review, 10)
  })

  test('learning cards from every deck still come first', () => {
    const cards = [
      card(State.Review, at(2026, 8, 8, 6), { deckId: 'A', id: 'rev' }),
      card(State.Learning, at(2026, 8, 8, 11), { deckId: 'B', id: 'learn' }),
    ]
    assert.equal(buildQueue(input(cards, now)).map((c) => c.id)[0], 'learn')
  })
})


describe('burying siblings', () => {
  // The two directions of one word share a noteId. Seeing the answer an hour
  // before the question is not a review, so only one direction runs per day.
  const now = at(2026, 8, 8, 12, 0)

  const pair = (noteId, extra = {}) => [
    card(State.New, now, { noteId, id: `${noteId}-fwd`, ...extra }),
    card(State.New, now, { noteId, id: `${noteId}-rev`, ...extra }),
  ]

  test('noteOf falls back to the card id when there is no note', () => {
    const lone = card(State.New, now, { id: 'solo' })
    assert.equal(noteOf(lone), 'solo')
    assert.equal(noteOf(card(State.New, now, { id: 'x', noteId: 'n1' })), 'n1')
  })

  test('only one direction of a word enters the queue', () => {
    const queue = buildQueue(input(pair('n1'), now))
    assert.equal(queue.length, 1)
  })

  test('ten words yield ten cards, not twenty', () => {
    const cards = Array.from({ length: 10 }, (_, i) => pair(`n${i}`)).flat()
    assert.equal(cards.length, 20)
    assert.equal(buildQueue(input(cards, now)).length, 10)
  })

  test('answering one direction buries the other for the rest of the day', () => {
    // Realistic state: answering the forward card moved it to Learning with a
    // due time later today, so it is out of the queue on its own. The question
    // is only whether the mirror steps in to replace it. It must not.
    const cards = [
      card(State.Learning, at(2026, 8, 8, 12, 10), { noteId: 'n1', id: 'n1-fwd' }),
      card(State.New, now, { noteId: 'n1', id: 'n1-rev' }),
    ]
    const log = [{ ...logEntry(State.New, at(2026, 8, 8, 11, 59)), cardId: 'n1-fwd' }]
    assert.deepEqual(buildQueue(input(cards, now, log)).map((c) => c.id), [])
  })

  test('the answered card returns when its own step comes due', () => {
    const cards = [
      card(State.Learning, at(2026, 8, 8, 11, 55), { noteId: 'n1', id: 'n1-fwd' }),
      card(State.New, now, { noteId: 'n1', id: 'n1-rev' }),
    ]
    const log = [{ ...logEntry(State.New, at(2026, 8, 8, 11, 45)), cardId: 'n1-fwd' }]
    // The forward card is due again; the mirror stays buried behind it.
    assert.deepEqual(buildQueue(input(cards, now, log)).map((c) => c.id), ['n1-fwd'])
  })

  test('a learning card still returns within its own steps', () => {
    // Buried by a sibling, never by itself — otherwise 'Again' would drop the
    // card out of the session entirely.
    const c = card(State.Learning, at(2026, 8, 8, 11, 55), { noteId: 'n1', id: 'n1-fwd' })
    const log = [{ ...logEntry(State.Learning, at(2026, 8, 8, 11, 50)), cardId: 'n1-fwd' }]
    assert.equal(buildQueue(input([c], now, log)).length, 1)
  })

  test('the sibling comes back the next day', () => {
    const cards = pair('n1')
    const yesterday = [{ ...logEntry(State.New, at(2026, 8, 7, 10)), cardId: 'n1-fwd' }]
    const tomorrow = at(2026, 8, 9, 12, 0)
    // The caller scopes the log to the current study day; yesterday's is gone.
    assert.equal(buildQueue(input(cards, tomorrow, todaysReviews(yesterday, tomorrow, settings))).length, 1)
  })

  test('unrelated cards are untouched', () => {
    const cards = [...pair('n1'), card(State.New, now, { noteId: 'n2', id: 'other' })]
    const ids = buildQueue(input(cards, now)).map((c) => c.id)
    assert.equal(ids.length, 2)
    assert.ok(ids.includes('other'))
  })

  test('counts agree with the queue', () => {
    const cards = Array.from({ length: 10 }, (_, i) => pair(`n${i}`)).flat()
    assert.equal(queueCounts(input(cards, now)).total, buildQueue(input(cards, now)).length)
  })

  test('unseen counts words, not sides, once burying is on', () => {
    const cards = Array.from({ length: 10 }, (_, i) => pair(`n${i}`)).flat()
    assert.equal(queueCounts(input(cards, now)).unseen, 10)
  })

  test('turning it off shows both directions', () => {
    const cards = pair('n1')
    assert.equal(buildQueue(input(cards, now, [], { burySiblings: false })).length, 2)
  })

  test('cards without a noteId are never buried by each other', () => {
    // Legacy cards stand alone; two of them must not suppress one another.
    const cards = [card(State.New, now, { id: 'a' }), card(State.New, now, { id: 'b' })]
    assert.equal(buildQueue(input(cards, now)).length, 2)
  })

  test('burying does not leak across decks', () => {
    const cards = [
      card(State.New, now, { noteId: 'n1', id: 'A-fwd', deckId: 'A' }),
      card(State.New, now, { noteId: 'n1', id: 'B-fwd', deckId: 'B' }),
    ]
    assert.equal(buildQueue(input(cards, now)).length, 2)
  })
})
