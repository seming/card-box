import type { Card, ReviewLogEntry, Settings } from '#src/types.ts'
import { Rating, State } from '#src/types.ts'
import { dayEnd, dayKey, dayStart, daysBetween } from '#src/lib/day.ts'

/**
 * Study statistics.
 *
 * Pure, like the queue and the merge: `now` arrives as an argument, retrievability
 * arrives as an injected function, and nothing here reads a clock or `ts-fsrs`.
 * Numbers on a chart are the third place a defect hides — a wrong retention rate
 * still renders as a perfectly plausible percentage — so all of it is testable
 * without a browser.
 *
 * Definitions follow Anki so the figures mean the same thing:
 * a card is **mature** once its interval reaches 21 days, and an answer **passes**
 * when it is anything other than Again.
 */

/** Anki's young/mature boundary, in days. */
export const MATURE_DAYS = 21

export type Bucket = 'new' | 'learning' | 'relearning' | 'young' | 'mature'

const live = (c: Card) => !c.deleted
const passed = (e: ReviewLogEntry) => e.rating !== Rating.Again

export function bucketOf(card: Card): Bucket {
  const { state, scheduled_days } = card.fsrs
  if (state === State.New) return 'new'
  if (state === State.Learning) return 'learning'
  if (state === State.Relearning) return 'relearning'
  return scheduled_days >= MATURE_DAYS ? 'mature' : 'young'
}

/**
 * The bucket an answer belongs to, judged by the interval the card carried *into*
 * the review — the same basis as Anki's `lastIvl`, so a card that matures on this
 * answer still counts as young for it.
 */
export function logBucket(e: ReviewLogEntry): 'learning' | 'relearning' | 'young' | 'mature' {
  if (e.state === State.New || e.state === State.Learning) return 'learning'
  if (e.state === State.Relearning) return 'relearning'
  return e.scheduled_days >= MATURE_DAYS ? 'mature' : 'young'
}

/* ── today ──────────────────────────────────────────────────────────────── */

export interface TodayStats {
  answers: number
  seconds: number
  again: number
  /** Share of answers that were not Again, or null when nothing was studied. */
  passRate: number | null
  newCards: number
  reviews: number
  learning: number
  relearning: number
}

export function today(log: ReviewLogEntry[], now: Date, settings: Settings): TodayStats {
  const from = dayStart(now, settings.dayStartHour).toISOString()
  const to = dayEnd(now, settings.dayStartHour).toISOString()
  const entries = log.filter((e) => e.review >= from && e.review < to)

  let seconds = 0
  let again = 0
  const counts = { newCards: 0, reviews: 0, learning: 0, relearning: 0 }

  for (const e of entries) {
    seconds += e.duration / 1000
    if (!passed(e)) again++
    if (e.state === State.New) counts.newCards++
    else if (e.state === State.Review) counts.reviews++
    else if (e.state === State.Learning) counts.learning++
    else counts.relearning++
  }

  return {
    answers: entries.length,
    seconds,
    again,
    passRate: entries.length ? (entries.length - again) / entries.length : null,
    ...counts,
  }
}

/* ── true retention ─────────────────────────────────────────────────────── */

export interface RetentionCell {
  passed: number
  total: number
}
export interface RetentionRow {
  label: string
  days: number | null
  young: RetentionCell
  mature: RetentionCell
  all: RetentionCell
}

export const RETENTION_WINDOWS: { label: string; days: number | null }[] = [
  { label: 'Today', days: 1 },
  { label: 'Week', days: 7 },
  { label: 'Month', days: 30 },
  { label: 'Year', days: 365 },
  { label: 'All time', days: null },
]

/**
 * Pass rate by card maturity over several windows.
 *
 * **Learning answers are excluded.** Retention asks whether a scheduled interval
 * held, and a card still inside its learning steps has no interval to test — Anki
 * draws the same line. Including them would inflate the number.
 */
export function trueRetention(
  log: ReviewLogEntry[],
  now: Date,
  settings: Settings,
): RetentionRow[] {
  return RETENTION_WINDOWS.map(({ label, days }) => {
    const row: RetentionRow = {
      label,
      days,
      young: { passed: 0, total: 0 },
      mature: { passed: 0, total: 0 },
      all: { passed: 0, total: 0 },
    }

    for (const e of log) {
      if (e.state !== State.Review) continue
      if (days !== null) {
        const age = daysBetween(new Date(e.review), now, settings.dayStartHour)
        if (age < 0 || age >= days) continue
      }
      const cell = e.scheduled_days >= MATURE_DAYS ? row.mature : row.young
      cell.total++
      row.all.total++
      if (passed(e)) {
        cell.passed++
        row.all.passed++
      }
    }
    return row
  })
}

export const rate = (cell: RetentionCell): number | null =>
  cell.total ? cell.passed / cell.total : null

/* ── future due ─────────────────────────────────────────────────────────── */

export interface DueDay {
  /** Days from today; 0 is today. */
  offset: number
  young: number
  mature: number
  cumulative: number
}

export function futureDue(
  cards: Card[],
  now: Date,
  settings: Settings,
  span = 30,
): DueDay[] {
  const days: DueDay[] = Array.from({ length: span + 1 }, (_, offset) => ({
    offset,
    young: 0,
    mature: 0,
    cumulative: 0,
  }))

  for (const card of cards) {
    if (!live(card) || card.fsrs.state === State.New) continue
    // Anything already due lands on today rather than in the past.
    const offset = Math.max(0, daysBetween(now, new Date(card.fsrs.due), settings.dayStartHour))
    if (offset > span) continue
    if (card.fsrs.scheduled_days >= MATURE_DAYS) days[offset].mature++
    else days[offset].young++
  }

  let running = 0
  for (const day of days) {
    running += day.young + day.mature
    day.cumulative = running
  }
  return days
}

/* ── calendar ───────────────────────────────────────────────────────────── */

export interface CalendarDay {
  date: string
  count: number
}

/** Answers per study day, keyed `YYYY-MM-DD`, oldest first. */
export function calendar(log: ReviewLogEntry[], settings: Settings): CalendarDay[] {
  const counts = new Map<string, number>()
  for (const e of log) {
    const key = dayKey(new Date(e.review), settings.dayStartHour)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/* ── reviews per day ────────────────────────────────────────────────────── */

export interface ReviewDay {
  date: string
  offset: number
  learning: number
  young: number
  mature: number
  relearning: number
  seconds: number
  total: number
}

/** The last `span` study days, oldest first. Empty days are present, not skipped. */
export function reviewsByDay(
  log: ReviewLogEntry[],
  now: Date,
  settings: Settings,
  span = 30,
): ReviewDay[] {
  const byDate = new Map<string, ReviewDay>()
  for (let i = span - 1; i >= 0; i--) {
    const d = dayStart(now, settings.dayStartHour)
    d.setDate(d.getDate() - i)
    const date = dayKey(d, settings.dayStartHour)
    byDate.set(date, {
      date,
      offset: -i,
      learning: 0,
      young: 0,
      mature: 0,
      relearning: 0,
      seconds: 0,
      total: 0,
    })
  }

  for (const e of log) {
    const day = byDate.get(dayKey(new Date(e.review), settings.dayStartHour))
    if (!day) continue
    day[logBucket(e)]++
    day.seconds += e.duration / 1000
    day.total++
  }
  return [...byDate.values()]
}

/* ── card counts ────────────────────────────────────────────────────────── */

export type CardCounts = Record<Bucket, number> & { total: number }

export function cardCounts(cards: Card[]): CardCounts {
  const counts: CardCounts = {
    new: 0,
    learning: 0,
    relearning: 0,
    young: 0,
    mature: 0,
    total: 0,
  }
  for (const card of cards) {
    if (!live(card)) continue
    counts[bucketOf(card)]++
    counts.total++
  }
  return counts
}

/* ── histograms ─────────────────────────────────────────────────────────── */

export interface Bin {
  /** Inclusive lower edge. */
  from: number
  /** Exclusive upper edge; Infinity on the last bin. */
  to: number
  label: string
  count: number
  /** Share of all cards at or below this bin. */
  cumulative: number
}

function histogram(values: number[], edges: number[], label: (a: number, b: number) => string): Bin[] {
  const bins: Bin[] = edges.map((from, i) => ({
    from,
    to: edges[i + 1] ?? Infinity,
    label: label(from, edges[i + 1] ?? Infinity),
    count: 0,
    cumulative: 0,
  }))
  for (const v of values) {
    // Values below the first edge fall in the first bin rather than vanishing.
    let i = bins.findIndex((b) => v >= b.from && v < b.to)
    if (i === -1) i = v < edges[0] ? 0 : bins.length - 1
    bins[i].count++
  }
  let running = 0
  for (const bin of bins) {
    running += bin.count
    bin.cumulative = values.length ? running / values.length : 0
  }
  return bins
}

const dayLabel = (a: number, b: number): string =>
  b === Infinity ? `${a}d+` : b - a === 1 ? `${a}d` : `${a}–${b - 1}d`

/** Current intervals, in days. New cards have none and are excluded. */
export function intervalHistogram(cards: Card[]): Bin[] {
  const values = cards
    .filter((c) => live(c) && c.fsrs.state !== State.New)
    .map((c) => c.fsrs.scheduled_days)
  return histogram(values, [0, 1, 2, 3, 4, 7, 14, 21, 30, 60, 90, 180, 365], dayLabel)
}

/** FSRS stability: days for recall probability to fall to 90%. */
export function stabilityHistogram(cards: Card[]): Bin[] {
  const values = cards
    .filter((c) => live(c) && c.fsrs.state !== State.New)
    .map((c) => c.fsrs.stability)
  return histogram(values, [0, 1, 2, 3, 4, 7, 14, 21, 30, 60, 90, 180, 365], dayLabel)
}

/** FSRS difficulty, 1–10. Higher means intervals grow more slowly. */
export function difficultyHistogram(cards: Card[]): Bin[] {
  const values = cards
    .filter((c) => live(c) && c.fsrs.state !== State.New)
    .map((c) => c.fsrs.difficulty)
  return histogram(
    values,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    (a, b) => (b === Infinity ? `${a}+` : `${a}`),
  )
}

/**
 * FSRS retrievability: the chance of recalling a card right now.
 *
 * `probability` is injected rather than computed here — the formula belongs to
 * `ts-fsrs`, and importing it would make this module untestable in Node for no
 * gain. `scheduler.ts` supplies it.
 */
export function retrievabilityHistogram(
  cards: Card[],
  probability: (card: Card) => number,
): Bin[] {
  const values = cards
    .filter((c) => live(c) && c.fsrs.state !== State.New)
    .map((c) => Math.round(probability(c) * 100))
  // Last edge is 90, so the top bin is 90–100% inclusive. Ending the edges at
  // 100 instead would create a bin holding only the single value 100.
  return histogram(
    values,
    [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
    (a, b) => (b === Infinity ? `${a}–100%` : `${a}–${b - 1}%`),
  )
}

/** Expected number still remembered — the sum of per-card recall probabilities. */
export function expectedRetained(cards: Card[], probability: (card: Card) => number): number {
  return cards
    .filter((c) => live(c) && c.fsrs.state !== State.New)
    .reduce((sum, c) => sum + probability(c), 0)
}

/* ── hourly ─────────────────────────────────────────────────────────────── */

export interface HourStat {
  hour: number
  count: number
  passRate: number | null
}

/** Answers and pass rate by hour of the local day. */
export function hourlyBreakdown(log: ReviewLogEntry[]): HourStat[] {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, pass: 0 }))
  for (const e of log) {
    const h = hours[new Date(e.review).getHours()]
    h.count++
    if (passed(e)) h.pass++
  }
  return hours.map(({ hour, count, pass }) => ({
    hour,
    count,
    passRate: count ? pass / count : null,
  }))
}

/* ── answer buttons ─────────────────────────────────────────────────────── */

export interface ButtonStat {
  rating: 1 | 2 | 3 | 4
  label: string
  learning: number
  young: number
  mature: number
  total: number
}

const BUTTONS: { rating: 1 | 2 | 3 | 4; label: string }[] = [
  { rating: Rating.Again, label: 'Again' },
  { rating: Rating.Hard, label: 'Hard' },
  { rating: Rating.Good, label: 'Good' },
  { rating: Rating.Easy, label: 'Easy' },
]

/** How often each button was pressed, split by the card's maturity at the time. */
export function answerButtons(log: ReviewLogEntry[]): ButtonStat[] {
  const rows: ButtonStat[] = BUTTONS.map((b) => ({
    ...b,
    learning: 0,
    young: 0,
    mature: 0,
    total: 0,
  }))
  for (const e of log) {
    const row = rows.find((r) => r.rating === e.rating)
    if (!row) continue
    const bucket = logBucket(e)
    // Relearning counts as learning here, as it does in Anki's breakdown.
    if (bucket === 'learning' || bucket === 'relearning') row.learning++
    else row[bucket]++
    row.total++
  }
  return rows
}

/* ── formatting ─────────────────────────────────────────────────────────── */

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`
}

export const percent = (v: number | null, digits = 0): string =>
  v === null ? '—' : `${(v * 100).toFixed(digits)}%`
