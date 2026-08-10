import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating as FsrsRating,
  State as FsrsState,
} from 'ts-fsrs'
import type { Card as FsrsCard, FSRS, Grade } from 'ts-fsrs'
import type { Card, CardFsrs, ReviewLogEntry, Settings } from '#src/types.ts'
import { Rating, State } from '#src/types.ts'
import { newId } from '#src/lib/id.ts'

/**
 * The only place that talks to `ts-fsrs`.
 *
 * Two things live here so nothing else has to know about them: the `Date` ↔ ISO
 * conversion at the JSON boundary, and the scheduling call itself. Keeping the
 * library behind one file is what makes a future algorithm or parameter change
 * a single-file edit.
 */

/**
 * Our `State` / `Rating` constants are declared independently in types.ts so that
 * pure modules (queue, merge) never have to import `ts-fsrs`. That only works
 * while the numbers agree — and they also have to agree with the FSRS
 * optimizer's `review_state` / `review_rating` columns, which is what lets the
 * review log export with no translation table. Check it rather than trust it.
 */
function assertEnumsAligned(): void {
  const mismatches: string[] = []
  if (State.New !== FsrsState.New) mismatches.push('State.New')
  if (State.Learning !== FsrsState.Learning) mismatches.push('State.Learning')
  if (State.Review !== FsrsState.Review) mismatches.push('State.Review')
  if (State.Relearning !== FsrsState.Relearning) mismatches.push('State.Relearning')
  if (Rating.Again !== FsrsRating.Again) mismatches.push('Rating.Again')
  if (Rating.Hard !== FsrsRating.Hard) mismatches.push('Rating.Hard')
  if (Rating.Good !== FsrsRating.Good) mismatches.push('Rating.Good')
  if (Rating.Easy !== FsrsRating.Easy) mismatches.push('Rating.Easy')
  if (mismatches.length) {
    throw new Error(
      `ts-fsrs enum values drifted from types.ts: ${mismatches.join(', ')}. ` +
        'Review-log export and every stored card depend on these matching.',
    )
  }
}
assertEnumsAligned()

export function scheduler(settings: Settings): FSRS {
  return fsrs(
    generatorParameters({
      request_retention: settings.requestRetention,
      maximum_interval: settings.maximumInterval,
      enable_short_term: true,
      learning_steps: settings.learningSteps,
      relearning_steps: settings.relearningSteps,
      ...(settings.w?.length ? { w: settings.w } : {}),
    }),
  )
}

/* ── serialization ──────────────────────────────────────────────────────── */

export function toFsrs(f: CardFsrs): FsrsCard {
  return {
    due: new Date(f.due),
    stability: f.stability,
    difficulty: f.difficulty,
    elapsed_days: f.elapsed_days,
    scheduled_days: f.scheduled_days,
    learning_steps: f.learning_steps,
    reps: f.reps,
    lapses: f.lapses,
    state: f.state as FsrsState,
    last_review: f.last_review ? new Date(f.last_review) : undefined,
  }
}

export function fromFsrs(c: FsrsCard): CardFsrs {
  return {
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as CardFsrs['state'],
    ...(c.last_review ? { last_review: c.last_review.toISOString() } : {}),
  }
}

/** Scheduling state for a brand-new card. */
export function emptyFsrs(now: Date): CardFsrs {
  return fromFsrs(createEmptyCard(now))
}

/* ── answering ──────────────────────────────────────────────────────────── */

export const GRADES = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const
export type GradeValue = (typeof GRADES)[number]

export const GRADE_LABEL: Record<GradeValue, string> = {
  [Rating.Again]: 'Again',
  [Rating.Hard]: 'Hard',
  [Rating.Good]: 'Good',
  [Rating.Easy]: 'Easy',
}

/**
 * What each button would do, without committing to any of them. Shown under the
 * four buttons — seeing the cost of "Again" next to the reward of "Easy" is what
 * makes the rating a real choice rather than a guess.
 */
export function preview(
  card: Card,
  now: Date,
  settings: Settings,
): Record<GradeValue, { due: Date; interval: string }> {
  const log = scheduler(settings).repeat(toFsrs(card.fsrs), now)
  const out = {} as Record<GradeValue, { due: Date; interval: string }>
  for (const grade of GRADES) {
    const due = log[grade as Grade].card.due
    out[grade] = { due, interval: formatInterval(due.getTime() - now.getTime()) }
  }
  return out
}

/** Cap on a single review's recorded duration — see types.ts. */
export const MAX_DURATION_MS = 60_000

/**
 * Apply an answer. Returns the updated card and the log entry to append; the
 * caller persists both. `shownAt` is when the front went on screen, so the
 * duration covers reading and recalling, not just the button press.
 */
export function answer(
  card: Card,
  grade: GradeValue,
  now: Date,
  shownAt: Date,
  settings: Settings,
): { card: Card; log: ReviewLogEntry } {
  const before = toFsrs(card.fsrs)
  const { card: after, log } = scheduler(settings).next(before, now, grade as Grade)

  return {
    card: { ...card, fsrs: fromFsrs(after), updatedAt: now.toISOString() },
    log: {
      id: newId(),
      cardId: card.id,
      deckId: card.deckId,
      rating: grade,
      state: log.state as ReviewLogEntry['state'],
      due: log.due.toISOString(),
      stability: log.stability,
      difficulty: log.difficulty,
      elapsed_days: log.elapsed_days,
      last_elapsed_days: log.last_elapsed_days,
      scheduled_days: log.scheduled_days,
      learning_steps: log.learning_steps,
      review: log.review.toISOString(),
      duration: Math.min(Math.max(0, now.getTime() - shownAt.getTime()), MAX_DURATION_MS),
    },
  }
}

/**
 * A card's current recall probability, per FSRS.
 *
 * Returned as a closure so `lib/stats.ts` can stay free of `ts-fsrs` and keep
 * running under `node --test`. The formula belongs to the library — FSRS-6 makes
 * the decay a learned parameter, so hand-rolling it would drift the moment the
 * weights are optimized.
 */
export function retrievabilityOf(settings: Settings, now: Date): (card: Card) => number {
  const f = scheduler(settings)
  return (card) => f.get_retrievability(toFsrs(card.fsrs), now, false)
}

/* ── formatting ─────────────────────────────────────────────────────────── */

/** Anki-style compact interval: `<1m`, `10m`, `5h`, `4d`, `2.1mo`, `1.4y`. */
export function formatInterval(ms: number): string {
  const minutes = ms / 60_000
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${Math.round(minutes)}m`

  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)}h`

  const days = hours / 24
  if (days < 30) return `${Math.round(days)}d`

  const months = days / 30.4375
  if (months < 12) return `${months.toFixed(1)}mo`

  return `${(days / 365.25).toFixed(1)}y`
}
