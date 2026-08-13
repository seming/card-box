import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeCards,
  mergeDecks,
  mergeReviews,
  mergeSettings,
  byChunk,
  changedChunks,
  serializeCards,
  serializeReviews,
  parseReviews,
} from '../src/lib/merge.ts'
import { State, Rating, SettingsSchema } from '../src/types.ts'

/**
 * The scenario this whole module exists for is "divergent reviews": two devices
 * study different cards offline, both sync, and nothing is lost. It is also the
 * one failure that is invisible — no crash, no wrong-looking screen, just an
 * evening quietly gone.
 */

const T = {
  early: '2026-08-10T08:00:00.000Z',
  mid: '2026-08-10T12:00:00.000Z',
  late: '2026-08-10T20:00:00.000Z',
}

const card = (id, over = {}) => {
  const { updatedAt = T.mid, chunk = 0, fsrs = {}, ...rest } = over
  return {
    id,
    deckId: 'd1',
    chunk,
    front: `front-${id}`,
    back: `back-${id}`,
    tags: [],
    fsrs: {
      due: T.mid,
      stability: 1,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      state: State.New,
      ...fsrs,
    },
    createdAt: T.early,
    updatedAt,
    ...rest,
  }
}

/** A card as it looks after being answered: new schedule, fresh updatedAt. */
const answered = (id, at, over = {}) =>
  card(id, { updatedAt: at, fsrs: { state: State.Review, reps: 1, scheduled_days: 4, due: at }, ...over })

const entry = (id, over = {}) => ({
  id,
  cardId: over.cardId ?? `c${id}`,
  deckId: 'd1',
  rating: Rating.Good,
  state: State.New,
  due: T.mid,
  stability: 1,
  difficulty: 5,
  elapsed_days: 0,
  last_elapsed_days: 0,
  scheduled_days: 1,
  learning_steps: 0,
  review: over.review ?? T.mid,
  duration: 3000,
  ...over,
})

describe('divergent reviews — the scenario sync exists for', () => {
  test('three cards on one device and five on the other all survive', () => {
    const base = ['1', '2', '3', '4', '5', '6', '7', '8'].map((id) => card(id))

    // The laptop worked through 1–3 this morning; the phone did 4–8 tonight,
    // offline. Neither knows about the other.
    const laptop = base.map((c) => (['1', '2', '3'].includes(c.id) ? answered(c.id, T.mid) : c))
    const phone = base.map((c) => (['4', '5'].includes(c.id) ? answered(c.id, T.late) : c))

    const { merged } = mergeCards(phone, laptop)
    const byId = new Map(merged.map((c) => [c.id, c]))

    assert.equal(merged.length, 8, 'no card invented or lost')
    for (const id of ['1', '2', '3']) {
      assert.equal(byId.get(id).fsrs.reps, 1, `card ${id} keeps the laptop's answer`)
    }
    for (const id of ['4', '5']) {
      assert.equal(byId.get(id).fsrs.reps, 1, `card ${id} keeps the phone's answer`)
    }
    for (const id of ['6', '7', '8']) {
      assert.equal(byId.get(id).fsrs.reps, 0, `card ${id} was untouched by both`)
    }
  })

  test('the review log keeps every answer from both sides', () => {
    const laptop = ['a', 'b', 'c'].map((id) => entry(id))
    const phone = ['d', 'e'].map((id) => entry(id))
    const { merged } = mergeReviews(phone, laptop)
    assert.equal(merged.length, 5)
    assert.deepEqual(merged.map((e) => e.id).sort(), ['a', 'b', 'c', 'd', 'e'])
  })

  test('merging is order-independent — either device reaches the same answer', () => {
    const laptop = [answered('1', T.mid), card('2')]
    const phone = [card('1'), answered('2', T.late)]

    const a = mergeCards(laptop, phone).merged.sort((x, y) => x.id.localeCompare(y.id))
    const b = mergeCards(phone, laptop).merged.sort((x, y) => x.id.localeCompare(y.id))
    assert.deepEqual(a, b)
  })

  test('merging twice changes nothing the second time', () => {
    const laptop = [answered('1', T.mid), card('2')]
    const phone = [card('1'), answered('2', T.late)]
    const once = mergeCards(laptop, phone).merged
    const twice = mergeCards(once, phone).merged
    assert.deepEqual(
      once.sort((x, y) => x.id.localeCompare(y.id)),
      twice.sort((x, y) => x.id.localeCompare(y.id)),
    )
  })
})

describe('the same card answered on both devices', () => {
  test('the later answer wins the schedule', () => {
    const local = [answered('1', T.mid, { fsrs: { scheduled_days: 4, state: State.Review, reps: 1 } })]
    const remote = [answered('1', T.late, { fsrs: { scheduled_days: 30, state: State.Review, reps: 1 } })]
    const { merged } = mergeCards(local, remote)
    assert.equal(merged[0].fsrs.scheduled_days, 30)
  })

  test('and the earlier one loses even when it is the remote', () => {
    const local = [answered('1', T.late, { fsrs: { scheduled_days: 30, state: State.Review, reps: 1 } })]
    const remote = [answered('1', T.mid, { fsrs: { scheduled_days: 4, state: State.Review, reps: 1 } })]
    assert.equal(mergeCards(local, remote).merged[0].fsrs.scheduled_days, 30)
  })

  test('an exact tie resolves the same way from either side', () => {
    // Preferring "remote" on a tie would make each device keep whatever the
    // other sent, so the two would never converge. Content decides instead.
    const a = [card('1', { updatedAt: T.mid, front: 'A' })]
    const b = [card('1', { updatedAt: T.mid, front: 'B' })]
    assert.equal(mergeCards(a, b).merged[0].front, mergeCards(b, a).merged[0].front)
  })

  test('identical records on both sides are left alone', () => {
    const same = card('1', { updatedAt: T.mid })
    assert.deepEqual(mergeCards([same], [same]).merged, [same])
  })

  test('both log entries survive even though one schedule is discarded', () => {
    // Nothing is lost for optimization; only the schedule has to pick one.
    const local = [entry('x', { cardId: '1', review: T.mid })]
    const remote = [entry('y', { cardId: '1', review: T.late })]
    assert.equal(mergeReviews(local, remote).merged.length, 2)
  })
})

describe('deletion', () => {
  test('a card deleted on one device stays deleted', () => {
    const local = [card('1', { updatedAt: T.late, deleted: true })]
    const remote = [card('1', { updatedAt: T.mid })]
    assert.equal(mergeCards(local, remote).merged[0].deleted, true)
  })

  test('deleting is not special — an edit made afterwards brings it back', () => {
    const local = [card('1', { updatedAt: T.mid, deleted: true })]
    const remote = [card('1', { updatedAt: T.late, front: 'fixed' })]
    const [merged] = mergeCards(local, remote).merged
    assert.equal(merged.deleted, undefined)
    assert.equal(merged.front, 'fixed')
  })

  test('a tombstone the other side has never seen is carried over', () => {
    const { merged } = mergeCards([], [card('1', { deleted: true })])
    assert.equal(merged.length, 1, 'dropping it would resurrect the card on the next sync')
    assert.equal(merged[0].deleted, true)
  })

  test('suspension merges like any other edit', () => {
    const local = [card('1', { updatedAt: T.mid })]
    const remote = [card('1', { updatedAt: T.late, suspended: true })]
    assert.equal(mergeCards(local, remote).merged[0].suspended, true)
  })
})

describe('decks', () => {
  const deck = (id, over = {}) => ({
    id,
    name: `deck-${id}`,
    createdAt: T.early,
    updatedAt: T.mid,
    ...over,
  })

  test('a deck created on one device appears on the other', () => {
    assert.equal(mergeDecks([deck('a')], [deck('b')]).merged.length, 2)
  })

  test('a rename follows the later write', () => {
    const local = [deck('a', { name: 'old', updatedAt: T.mid })]
    const remote = [deck('a', { name: 'new', updatedAt: T.late })]
    assert.equal(mergeDecks(local, remote).merged[0].name, 'new')
  })
})

describe('reviews', () => {
  test('duplicate ids collapse — a replayed sync cannot double the log', () => {
    const e = entry('a')
    assert.equal(mergeReviews([e], [e]).merged.length, 1)
  })

  test('sorted by time, so the file is stable across syncs', () => {
    const merged = mergeReviews(
      [entry('b', { review: T.late })],
      [entry('a', { review: T.early })],
    ).merged
    assert.deepEqual(merged.map((e) => e.id), ['a', 'b'])
  })

  test('entries at the same instant still sort deterministically', () => {
    const merged = mergeReviews(
      [entry('z', { review: T.mid }), entry('a', { review: T.mid })],
      [],
    ).merged
    assert.deepEqual(merged.map((e) => e.id), ['a', 'z'])
  })

  test('counts what came from where', () => {
    const { stats } = mergeReviews([entry('a')], [entry('a'), entry('b')])
    assert.deepEqual(stats, { fromLocal: 1, fromRemote: 1, unchanged: 1 })
  })
})

describe('settings', () => {
  const base = SettingsSchema.parse({})

  test('the later write wins as a whole', () => {
    const local = { ...base, newPerDay: 20 }
    const remote = { ...base, newPerDay: 40 }
    assert.equal(mergeSettings(local, remote, T.mid, T.late).newPerDay, 40)
    assert.equal(mergeSettings(local, remote, T.late, T.mid).newPerDay, 20)
  })

  test('fields are never mixed — the result is a state some device actually chose', () => {
    const local = { ...base, newPerDay: 40, buryNew: false }
    const remote = { ...base, newPerDay: 20, buryNew: true }
    const merged = mergeSettings(local, remote, T.mid, T.late)
    assert.deepEqual({ n: merged.newPerDay, b: merged.buryNew }, { n: 20, b: true })
  })

  test('with nothing on the remote, local stands', () => {
    assert.equal(mergeSettings({ ...base, newPerDay: 40 }, base, T.mid, undefined).newPerDay, 40)
  })
})

describe('chunks', () => {
  test('groups by the file a card belongs to', () => {
    const grouped = byChunk([card('1', { chunk: 0 }), card('2', { chunk: 1 }), card('3', { chunk: 0 })])
    assert.deepEqual([...grouped.keys()].sort(), [0, 1])
    assert.equal(grouped.get(0).length, 2)
  })

  test('an unchanged chunk is not uploaded', () => {
    const same = new Map([[0, [card('1')]]])
    assert.deepEqual(changedChunks(same, new Map([[0, [card('1')]]])), [])
  })

  test('a chunk whose card was edited is uploaded', () => {
    const merged = new Map([[0, [card('1', { updatedAt: T.late })]]])
    const remote = new Map([[0, [card('1', { updatedAt: T.mid })]]])
    assert.deepEqual(changedChunks(merged, remote), [0])
  })

  test('a chunk the remote has never seen is uploaded', () => {
    assert.deepEqual(changedChunks(new Map([[3, [card('1')]]]), new Map()), [3])
  })

  test('a chunk that gained a card is uploaded', () => {
    const merged = new Map([[0, [card('1'), card('2')]]])
    const remote = new Map([[0, [card('1')]]])
    assert.deepEqual(changedChunks(merged, remote), [0])
  })

  test('only the touched chunk moves', () => {
    const merged = new Map([
      [0, [card('1')]],
      [1, [card('2', { chunk: 1, updatedAt: T.late })]],
      [2, [card('3', { chunk: 2 })]],
    ])
    const remote = new Map([
      [0, [card('1')]],
      [1, [card('2', { chunk: 1, updatedAt: T.mid })]],
      [2, [card('3', { chunk: 2 })]],
    ])
    assert.deepEqual(changedChunks(merged, remote), [1])
  })
})

describe('serialization', () => {
  test('card order does not change the file', () => {
    const a = serializeCards([card('1'), card('2')])
    const b = serializeCards([card('2'), card('1')])
    assert.equal(a, b, 'an unchanged chunk must not look changed')
  })

  test('reviews round-trip through JSONL', () => {
    const entries = [entry('a'), entry('b', { review: T.late })]
    assert.deepEqual(parseReviews(serializeReviews(entries)), entries)
  })

  test('a trailing newline and blank lines are tolerated', () => {
    assert.equal(parseReviews('\n' + serializeReviews([entry('a')]) + '\n').length, 1)
  })

  test('an empty log is an empty file, not a broken one', () => {
    assert.deepEqual(parseReviews(''), [])
  })
})
