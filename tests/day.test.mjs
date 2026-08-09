import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DAY_START_HOUR,
  dayStart,
  dayEnd,
  dayKey,
  isSameDay,
  daysBetween,
} from '../src/lib/day.ts'

// Dates are built from local components on purpose: the study day is a local
// concept, and these assertions must hold in any timezone the owner travels to.
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0)

describe('dayStart', () => {
  test('defaults to 4am', () => {
    assert.equal(DAY_START_HOUR, 4)
  })

  test('before 4am belongs to the previous day', () => {
    assert.deepEqual(dayStart(at(2026, 8, 8, 3, 59)), at(2026, 8, 7, 4))
  })

  test('exactly 4am starts the new day', () => {
    assert.deepEqual(dayStart(at(2026, 8, 8, 4, 0)), at(2026, 8, 8, 4))
  })

  test('midnight belongs to the previous day', () => {
    assert.deepEqual(dayStart(at(2026, 8, 8, 0, 0)), at(2026, 8, 7, 4))
  })

  test('late evening belongs to the current day', () => {
    assert.deepEqual(dayStart(at(2026, 8, 8, 23, 30)), at(2026, 8, 8, 4))
  })

  test('crosses a month boundary', () => {
    assert.deepEqual(dayStart(at(2026, 9, 1, 2, 0)), at(2026, 8, 31, 4))
  })

  test('crosses a year boundary', () => {
    assert.deepEqual(dayStart(at(2027, 1, 1, 1, 0)), at(2026, 12, 31, 4))
  })

  test('does not mutate its argument', () => {
    const now = at(2026, 8, 8, 3, 0)
    const copy = new Date(now.getTime())
    dayStart(now)
    assert.deepEqual(now, copy)
  })

  test('honours a custom start hour', () => {
    assert.deepEqual(dayStart(at(2026, 8, 8, 3, 0), 0), at(2026, 8, 8, 0))
    assert.deepEqual(dayStart(at(2026, 8, 8, 5, 0), 6), at(2026, 8, 7, 6))
  })
})

describe('dayEnd', () => {
  test('is the next day start', () => {
    assert.deepEqual(dayEnd(at(2026, 8, 8, 10, 0)), at(2026, 8, 9, 4))
  })

  test('3am and 10am on the same study day share an end', () => {
    assert.deepEqual(dayEnd(at(2026, 8, 8, 3, 0)), dayEnd(at(2026, 8, 7, 10, 0)))
  })

  test('is strictly after the start', () => {
    const now = at(2026, 8, 8, 12, 0)
    assert.ok(dayEnd(now).getTime() > dayStart(now).getTime())
  })
})

describe('dayKey', () => {
  test('3am reports the previous date', () => {
    assert.equal(dayKey(at(2026, 8, 8, 3, 0)), '2026-08-07')
  })

  test('5am reports the current date', () => {
    assert.equal(dayKey(at(2026, 8, 8, 5, 0)), '2026-08-08')
  })

  test('pads single-digit month and day', () => {
    assert.equal(dayKey(at(2026, 1, 5, 12, 0)), '2026-01-05')
  })

  test('matches the review-log filename format', () => {
    assert.match(dayKey(at(2026, 8, 8, 12, 0)), /^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('isSameDay', () => {
  test('10pm and 3am the next morning are one study day', () => {
    assert.equal(isSameDay(at(2026, 8, 8, 22, 0), at(2026, 8, 9, 3, 0)), true)
  })

  test('3am and 5am the same morning are different study days', () => {
    assert.equal(isSameDay(at(2026, 8, 8, 3, 0), at(2026, 8, 8, 5, 0)), false)
  })
})

describe('daysBetween', () => {
  test('counts study days, not calendar days', () => {
    // 8th 22:00 → 9th 03:00 is the same study day.
    assert.equal(daysBetween(at(2026, 8, 8, 22, 0), at(2026, 8, 9, 3, 0)), 0)
    assert.equal(daysBetween(at(2026, 8, 8, 22, 0), at(2026, 8, 9, 5, 0)), 1)
  })

  test('is negative when going backwards', () => {
    assert.equal(daysBetween(at(2026, 8, 10, 12, 0), at(2026, 8, 8, 12, 0)), -2)
  })
})
