import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MATURE_DAYS,
  bucketOf,
  logBucket,
  today,
  trueRetention,
  rate,
  futureDue,
  calendar,
  reviewsByDay,
  cardCounts,
  intervalHistogram,
  difficultyHistogram,
  retrievabilityHistogram,
  expectedRetained,
  hourlyBreakdown,
  answerButtons,
  formatDuration,
  percent,
} from '../src/lib/stats.ts'
import { State, Rating, SettingsSchema } from '../src/types.ts'

const settings = SettingsSchema.parse({})
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0, 0)
const NOW = at(2026, 8, 10, 12)

let n = 0
const card = (over = {}) => {
  n++
  // `fsrs` is pulled out of the overrides so the spread below cannot clobber the
  // merged object — an earlier version did exactly that and silently dropped
  // state and scheduled_days, which made two assertions pass for the wrong reason.
  const { state = State.Review, scheduled_days = 5, fsrs = {}, ...rest } = over
  return {
    id: `c${n}`,
    deckId: 'd1',
    chunk: 0,
    front: `f${n}`,
    back: `b${n}`,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...rest,
    fsrs: {
      due: NOW.toISOString(),
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
  }
}

const entry = (over = {}) => {
  n++
  const when = over.at ?? at(2026, 8, 10, 10)
  return {
    id: `l${n}`,
    cardId: `c${n}`,
    deckId: 'd1',
    rating: Rating.Good,
    state: State.Review,
    due: when.toISOString(),
    stability: 10,
    difficulty: 5,
    elapsed_days: 5,
    last_elapsed_days: 5,
    scheduled_days: 5,
    learning_steps: 0,
    review: when.toISOString(),
    duration: 4000,
    ...(({ at: _drop, ...rest }) => rest)(over),
  }
}

describe('bucketOf', () => {
  test('splits young and mature at 21 days, Anki’s boundary', () => {
    assert.equal(MATURE_DAYS, 21)
    assert.equal(bucketOf(card({ scheduled_days: 20 })), 'young')
    assert.equal(bucketOf(card({ scheduled_days: 21 })), 'mature')
  })

  test('state wins over interval', () => {
    assert.equal(bucketOf(card({ state: State.New, scheduled_days: 0 })), 'new')
    assert.equal(bucketOf(card({ state: State.Learning, scheduled_days: 99 })), 'learning')
    assert.equal(bucketOf(card({ state: State.Relearning, scheduled_days: 99 })), 'relearning')
  })
})

describe('logBucket', () => {
  test('classifies by the interval carried into the review', () => {
    // A card maturing on this very answer still counts as young for it.
    assert.equal(logBucket(entry({ scheduled_days: 20 })), 'young')
    assert.equal(logBucket(entry({ scheduled_days: 21 })), 'mature')
  })

  test('a first answer on a new card is learning', () => {
    assert.equal(logBucket(entry({ state: State.New, scheduled_days: 0 })), 'learning')
  })

  test('relearning is its own bucket', () => {
    assert.equal(logBucket(entry({ state: State.Relearning })), 'relearning')
  })
})

describe('today', () => {
  test('empty log', () => {
    const t = today([], NOW, settings)
    assert.equal(t.answers, 0)
    assert.equal(t.passRate, null)
  })

  test('counts answers, seconds and Agains', () => {
    const log = [
      entry({ duration: 3000 }),
      entry({ duration: 5000, rating: Rating.Again }),
      entry({ duration: 2000, rating: Rating.Easy }),
    ]
    const t = today(log, NOW, settings)
    assert.equal(t.answers, 3)
    assert.equal(t.seconds, 10)
    assert.equal(t.again, 1)
    assert.equal(t.passRate, 2 / 3)
  })

  test('splits by the state answered from', () => {
    const log = [
      entry({ state: State.New }),
      entry({ state: State.New }),
      entry({ state: State.Review }),
      entry({ state: State.Learning }),
      entry({ state: State.Relearning }),
    ]
    const t = today(log, NOW, settings)
    assert.deepEqual(
      { n: t.newCards, r: t.reviews, l: t.learning, rl: t.relearning },
      { n: 2, r: 1, l: 1, rl: 1 },
    )
  })

  test('respects the 4am study day', () => {
    const log = [
      entry({ at: at(2026, 8, 10, 3) }), // still the 9th
      entry({ at: at(2026, 8, 10, 5) }), // the 10th
    ]
    assert.equal(today(log, NOW, settings).answers, 1)
  })

  test('a late-night session counts as the day it started', () => {
    const log = [entry({ at: at(2026, 8, 10, 23, 30) })]
    assert.equal(today(log, at(2026, 8, 11, 1), settings).answers, 1)
    assert.equal(today(log, at(2026, 8, 11, 5), settings).answers, 0)
  })
})

describe('trueRetention', () => {
  const rows = (log, now = NOW) => Object.fromEntries(
    trueRetention(log, now, settings).map((r) => [r.label, r]),
  )

  test('learning answers are excluded — they have no interval to test', () => {
    const log = [
      entry({ state: State.Learning, rating: Rating.Again }),
      entry({ state: State.New, rating: Rating.Again }),
      entry({ state: State.Review, rating: Rating.Good }),
    ]
    const r = rows(log)['Today']
    assert.equal(r.all.total, 1, 'only the review answer counts')
    assert.equal(rate(r.all), 1)
  })

  test('splits young from mature', () => {
    const log = [
      entry({ scheduled_days: 5, rating: Rating.Good }),
      entry({ scheduled_days: 5, rating: Rating.Again }),
      entry({ scheduled_days: 40, rating: Rating.Good }),
      entry({ scheduled_days: 40, rating: Rating.Good }),
    ]
    const r = rows(log)['Today']
    assert.equal(rate(r.young), 0.5)
    assert.equal(rate(r.mature), 1)
    assert.equal(rate(r.all), 0.75)
  })

  test('windows widen', () => {
    const log = [
      entry({ at: at(2026, 8, 10, 10) }),
      entry({ at: at(2026, 8, 7, 10) }),
      entry({ at: at(2026, 7, 20, 10) }),
      entry({ at: at(2025, 9, 1, 10) }),
    ]
    const r = rows(log)
    assert.equal(r['Today'].all.total, 1)
    assert.equal(r['Week'].all.total, 2)
    assert.equal(r['Month'].all.total, 3)
    assert.equal(r['Year'].all.total, 4)
    assert.equal(r['All time'].all.total, 4)
  })

  test('future-dated entries are not counted', () => {
    const log = [entry({ at: at(2026, 8, 20, 10) })]
    assert.equal(rows(log)['Week'].all.total, 0)
    assert.equal(rows(log)['All time'].all.total, 1)
  })

  test('rate is null with no data, never NaN', () => {
    assert.equal(rate({ passed: 0, total: 0 }), null)
    assert.equal(percent(null), '—')
  })
})

describe('futureDue', () => {
  test('buckets by days ahead', () => {
    const cards = [
      card({ fsrs: { due: at(2026, 8, 10, 12).toISOString() } }),
      card({ fsrs: { due: at(2026, 8, 12, 12).toISOString() } }),
      card({ fsrs: { due: at(2026, 8, 12, 12).toISOString() }, scheduled_days: 40 }),
    ]
    const days = futureDue(cards, NOW, settings)
    assert.equal(days[0].young, 1)
    assert.equal(days[2].young, 1)
    assert.equal(days[2].mature, 1)
  })

  test('overdue cards pile onto today rather than the past', () => {
    const cards = [card({ fsrs: { due: at(2026, 8, 1, 12).toISOString() } })]
    assert.equal(futureDue(cards, NOW, settings)[0].young, 1)
  })

  test('new cards have no due date and are skipped', () => {
    const cards = [card({ state: State.New })]
    assert.equal(futureDue(cards, NOW, settings).reduce((s, d) => s + d.young + d.mature, 0), 0)
  })

  test('cumulative accrues across the span', () => {
    const cards = [
      card({ fsrs: { due: at(2026, 8, 11, 12).toISOString() } }),
      card({ fsrs: { due: at(2026, 8, 13, 12).toISOString() } }),
    ]
    const days = futureDue(cards, NOW, settings)
    assert.equal(days[0].cumulative, 0)
    assert.equal(days[1].cumulative, 1)
    assert.equal(days[3].cumulative, 2)
  })

  test('deleted cards are excluded', () => {
    const cards = [card({ deleted: true })]
    assert.equal(futureDue(cards, NOW, settings)[0].young, 0)
  })
})

describe('calendar', () => {
  test('counts per study day, sorted', () => {
    const log = [
      entry({ at: at(2026, 8, 10, 10) }),
      entry({ at: at(2026, 8, 10, 11) }),
      entry({ at: at(2026, 8, 8, 10) }),
    ]
    assert.deepEqual(calendar(log, settings), [
      { date: '2026-08-08', count: 1 },
      { date: '2026-08-10', count: 2 },
    ])
  })

  test('3am belongs to the previous date', () => {
    const log = [entry({ at: at(2026, 8, 10, 3) })]
    assert.equal(calendar(log, settings)[0].date, '2026-08-09')
  })
})

describe('reviewsByDay', () => {
  test('returns the whole span, including empty days', () => {
    const days = reviewsByDay([], NOW, settings, 7)
    assert.equal(days.length, 7)
    assert.ok(days.every((d) => d.total === 0))
  })

  test('oldest first, ending today', () => {
    const days = reviewsByDay([], NOW, settings, 3)
    assert.deepEqual(days.map((d) => d.date), ['2026-08-08', '2026-08-09', '2026-08-10'])
  })

  test('splits by bucket and sums time', () => {
    const log = [
      entry({ at: at(2026, 8, 10, 10), state: State.New, duration: 3000 }),
      entry({ at: at(2026, 8, 10, 10), scheduled_days: 5, duration: 2000 }),
      entry({ at: at(2026, 8, 10, 10), scheduled_days: 40, duration: 1000 }),
      entry({ at: at(2026, 8, 10, 10), state: State.Relearning, duration: 4000 }),
    ]
    const day = reviewsByDay(log, NOW, settings, 3).at(-1)
    assert.deepEqual(
      { l: day.learning, y: day.young, m: day.mature, r: day.relearning },
      { l: 1, y: 1, m: 1, r: 1 },
    )
    assert.equal(day.seconds, 10)
    assert.equal(day.total, 4)
  })

  test('entries outside the span are ignored', () => {
    const log = [entry({ at: at(2026, 1, 1, 10) })]
    assert.equal(reviewsByDay(log, NOW, settings, 7).reduce((s, d) => s + d.total, 0), 0)
  })
})

describe('cardCounts', () => {
  test('counts every bucket and the total', () => {
    const cards = [
      card({ state: State.New }),
      card({ state: State.Learning }),
      card({ state: State.Relearning }),
      card({ scheduled_days: 5 }),
      card({ scheduled_days: 40 }),
      card({ deleted: true }),
    ]
    const c = cardCounts(cards)
    assert.deepEqual(
      { n: c.new, l: c.learning, r: c.relearning, y: c.young, m: c.mature, t: c.total },
      { n: 1, l: 1, r: 1, y: 1, m: 1, t: 5 },
    )
  })
})

describe('histograms', () => {
  test('intervals bin and accumulate to 1', () => {
    const cards = [
      card({ scheduled_days: 1 }),
      card({ scheduled_days: 1 }),
      card({ scheduled_days: 100 }),
    ]
    const bins = intervalHistogram(cards)
    assert.equal(bins.reduce((s, b) => s + b.count, 0), 3)
    assert.equal(bins.at(-1).cumulative, 1)
  })

  test('new cards are excluded — they have no interval', () => {
    assert.equal(intervalHistogram([card({ state: State.New })]).reduce((s, b) => s + b.count, 0), 0)
  })

  test('a value past the last edge lands in the final bin, not nowhere', () => {
    const bins = intervalHistogram([card({ scheduled_days: 9999 })])
    assert.equal(bins.at(-1).count, 1)
  })

  test('difficulty spans 1 to 10', () => {
    const bins = difficultyHistogram([card({ fsrs: { difficulty: 1 } }), card({ fsrs: { difficulty: 10 } })])
    assert.equal(bins[0].count, 1)
    assert.equal(bins.at(-1).count, 1)
  })

  test('retrievability uses the injected probability', () => {
    const cards = [card(), card()]
    const bins = retrievabilityHistogram(cards, () => 0.95)
    assert.equal(bins.at(-1).label, '90–100%')
    assert.equal(bins.at(-1).count, 2, '95% lands in the top bin')
    assert.equal(retrievabilityHistogram([card()], () => 0.05)[0].count, 1)
  })

  test('expectedRetained sums probabilities', () => {
    const cards = [card(), card(), card({ state: State.New })]
    assert.equal(expectedRetained(cards, () => 0.5), 1)
  })

  test('empty input gives zero cumulative, not NaN', () => {
    assert.ok(intervalHistogram([]).every((b) => b.cumulative === 0))
  })
})

describe('hourlyBreakdown', () => {
  test('always returns 24 hours', () => {
    assert.equal(hourlyBreakdown([]).length, 24)
    assert.ok(hourlyBreakdown([]).every((h) => h.passRate === null))
  })

  test('counts and scores by local hour', () => {
    const log = [
      entry({ at: at(2026, 8, 10, 9), rating: Rating.Good }),
      entry({ at: at(2026, 8, 10, 9), rating: Rating.Again }),
      entry({ at: at(2026, 8, 10, 21), rating: Rating.Good }),
    ]
    const hours = hourlyBreakdown(log)
    assert.equal(hours[9].count, 2)
    assert.equal(hours[9].passRate, 0.5)
    assert.equal(hours[21].passRate, 1)
  })
})

describe('answerButtons', () => {
  test('four rows in Again–Easy order', () => {
    assert.deepEqual(answerButtons([]).map((r) => r.label), ['Again', 'Hard', 'Good', 'Easy'])
  })

  test('counts by button and maturity', () => {
    const log = [
      entry({ rating: Rating.Good, scheduled_days: 5 }),
      entry({ rating: Rating.Good, scheduled_days: 40 }),
      entry({ rating: Rating.Again, state: State.New }),
      entry({ rating: Rating.Again, state: State.Relearning }),
    ]
    const rows = Object.fromEntries(answerButtons(log).map((r) => [r.label, r]))
    assert.deepEqual(
      { y: rows.Good.young, m: rows.Good.mature, t: rows.Good.total },
      { y: 1, m: 1, t: 2 },
    )
    // Relearning folds into learning here, as Anki's breakdown does.
    assert.equal(rows.Again.learning, 2)
  })

  test('Manual ratings are ignored', () => {
    assert.equal(answerButtons([entry({ rating: Rating.Manual })]).reduce((s, r) => s + r.total, 0), 0)
  })
})

describe('formatting', () => {
  test('durations', () => {
    assert.equal(formatDuration(45), '45s')
    assert.equal(formatDuration(90), '2m')
    assert.equal(formatDuration(3600), '1.0h')
    assert.equal(formatDuration(36000 * 2), '20h')
  })

  test('percentages', () => {
    assert.equal(percent(0.9), '90%')
    assert.equal(percent(0.905, 1), '90.5%')
    assert.equal(percent(null), '—')
  })
})
