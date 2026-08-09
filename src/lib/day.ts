/**
 * Study-day boundaries.
 *
 * A study day runs from 04:00 local time to 04:00 the next day, matching Anki's
 * default. Midnight would split a late-night session across two days, so the
 * same cards would come due twice within one sitting.
 *
 * Every function here is pure and takes `now` explicitly so it can be tested
 * without faking the clock.
 */

export const DAY_START_HOUR = 4

/** Start of the study day that contains `now`. */
export function dayStart(now: Date, startHour: number = DAY_START_HOUR): Date {
  const d = new Date(now.getTime())
  if (d.getHours() < startHour) d.setDate(d.getDate() - 1)
  d.setHours(startHour, 0, 0, 0)
  return d
}

/**
 * End of the study day that contains `now` — exclusive.
 * Derived by adding one calendar day to the start, so it stays correct across
 * daylight-saving transitions where a day is not 24 hours long.
 */
export function dayEnd(now: Date, startHour: number = DAY_START_HOUR): Date {
  const d = dayStart(now, startHour)
  d.setDate(d.getDate() + 1)
  return d
}

/**
 * Calendar key of the study day, `YYYY-MM-DD` in local time.
 * This names the review-log file: `reviews/2026-08-08.jsonl`.
 */
export function dayKey(now: Date, startHour: number = DAY_START_HOUR): string {
  const d = dayStart(now, startHour)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** True when both instants fall in the same study day. */
export function isSameDay(a: Date, b: Date, startHour: number = DAY_START_HOUR): boolean {
  return dayStart(a, startHour).getTime() === dayStart(b, startHour).getTime()
}

/** Whole study days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: Date, to: Date, startHour: number = DAY_START_HOUR): number {
  const a = dayStart(from, startHour)
  const b = dayStart(to, startHour)
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}
