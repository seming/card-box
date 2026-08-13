import type { Card, ReviewLogEntry, Settings } from '#src/types.ts'
import { State } from '#src/types.ts'
import { dayEnd, dayStart } from '#src/lib/day.ts'

/**
 * Deciding which cards to show, and in what order.
 *
 * Pure on purpose: `now` and `seed` come in as arguments and nothing here reads
 * a clock, a random source, or a store. That is what lets `node --test` cover it
 * without a browser — and this is one of the two places where a defect is
 * invisible in the UI, so it has to be covered.
 *
 * Deliberately does not import `ts-fsrs`. Only `state` and `fsrs.due` matter
 * here, both of which live on our own `Card`.
 */

export interface QueueInput {
  cards: Card[]
  /** Reviews already logged in the current study day. Drives the daily limits. */
  todayLog: ReviewLogEntry[]
  settings: Settings
  now: Date
  /** Fixed seed keeps ordering deterministic in tests. */
  seed?: number
}

export interface QueueCounts {
  /** Learning or relearning and due right now. Never capped — these are mid-flight. */
  learning: number
  /** Review cards due today, after the daily cap. */
  review: number
  /** New cards that will be introduced today, after the daily cap. */
  new: number
  /** Every card never studied, ignoring the cap. Surfaces the size of a backlog. */
  unseen: number
  total: number
}

/** Deterministic PRNG so a shuffled order can still be asserted in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const live = (c: Card) => !c.deleted

/** Suspended forever, or buried until a moment that has not arrived. */
export function isHeld(c: Card, now: Date): boolean {
  if (c.suspended) return true
  return c.buriedUntil !== undefined && c.buriedUntil > now.toISOString()
}

/**
 * The note a card belongs to. Cards created before notes existed have no
 * `noteId` and stand alone, which is the correct fallback: nothing to bury.
 */
export const noteOf = (c: Card): string => c.noteId ?? c.id

/**
 * Notes whose other direction has already been answered today.
 *
 * Showing `das Skigebiet → 스키장` and then `스키장 → das Skigebiet` an hour later
 * is not two reviews; the second one is a copying exercise. Anki calls this
 * burying siblings and does it by default, and the reverse cards this app
 * generates make it necessary rather than optional.
 *
 * Derived from the log rather than stored, like the daily limits — so it needs
 * no state of its own and survives a sync without merge rules.
 */
function buriedNotes(cards: Card[], todayLog: ReviewLogEntry[]): Map<string, Set<string>> {
  const noteByCard = new Map(cards.map((c) => [c.id, noteOf(c)]))
  const answered = new Map<string, Set<string>>()
  for (const entry of todayLog) {
    const note = noteByCard.get(entry.cardId)
    if (note === undefined) continue
    const seen = answered.get(note)
    if (seen) seen.add(entry.cardId)
    else answered.set(note, new Set([entry.cardId]))
  }
  return answered
}

/**
 * How much of today's allowance is left, for one deck or across all of them.
 *
 * Counted from the review log rather than a stored counter: the log syncs, so
 * two devices add up for free, and a separate counter would need merge rules of
 * its own for no benefit.
 *
 * Learning repeats do not consume anything. A lapsed card that comes back three
 * times in one session is one review, not four — same as Anki.
 *
 * **Pass `deckId`.** The limits are per deck, as they are in Anki. Counting
 * globally means finishing one deck silently blocks every other one — a deck
 * imported minutes ago would report "done for today" without ever being seen.
 */
export function remainingToday(
  todayLog: ReviewLogEntry[],
  settings: Settings,
  deckId?: string,
): { newLeft: number; reviewLeft: number } {
  let newDone = 0
  let reviewDone = 0
  for (const entry of todayLog) {
    if (deckId !== undefined && entry.deckId !== deckId) continue
    if (entry.state === State.New) newDone++
    else if (entry.state === State.Review) reviewDone++
  }
  return {
    newLeft: Math.max(0, settings.newPerDay - newDone),
    reviewLeft: Math.max(0, settings.reviewsPerDay - reviewDone),
  }
}

/** Reviews belonging to the study day that contains `now`. */
export function todaysReviews(log: ReviewLogEntry[], now: Date, settings: Settings): ReviewLogEntry[] {
  const from = dayStart(now, settings.dayStartHour).toISOString()
  const to = dayEnd(now, settings.dayStartHour).toISOString()
  return log.filter((e) => e.review >= from && e.review < to)
}

function partition(
  cards: Card[],
  now: Date,
  settings: Settings,
  answeredNotes: Map<string, Set<string>>,
) {
  const nowIso = now.toISOString()
  const endIso = dayEnd(now, settings.dayStartHour).toISOString()

  const learning: Card[] = []
  const review: Card[] = []
  const fresh: Card[] = []
  let unseen = 0

  // At most one card per note per build, for the queues where burying is on.
  // Anki reaches the same place by burying at answer time; deriving it here
  // keeps the counts honest before the first answer.
  const claimed = new Set<string>()

  for (const card of cards) {
    if (!live(card)) continue
    // Suspended and buried cards leave the queue entirely, and do not consume a
    // daily allowance — the same way Anki treats them.
    if (isHeld(card, now)) continue

    const { state, due } = card.fsrs

    /**
     * Whether burying applies is keyed on the queue *this* card sits in, not on
     * the card that was answered — matching Anki's wording: "bury new siblings"
     * delays other **new** cards of the note.
     */
    const buryThis =
      state === State.New
        ? settings.buryNew
        : state === State.Review
          ? settings.buryReviews
          : // Learning or relearning: only counts as interday once its step
            // crosses into a later study day.
            settings.buryInterdayLearning && due >= endIso

    if (buryThis) {
      const sameNote = answeredNotes.get(noteOf(card))
      // Buried only by a *sibling*. A learning card returning within its own
      // steps must still appear, so a card is never buried by itself.
      if (sameNote && !sameNote.has(card.id)) continue
      if (claimed.has(noteOf(card))) continue
      claimed.add(noteOf(card))
    }

    if (state === State.New) {
      unseen++
      fresh.push(card)
    } else if (state === State.Learning || state === State.Relearning) {
      // Strictly due now. A step scheduled for later today surfaces when the
      // clock reaches it, which is how Anki behaves.
      if (due <= nowIso) learning.push(card)
    } else if (due < endIso) {
      review.push(card)
    }
  }
  return { learning, review, fresh, unseen }
}

/**
 * Spread `extra` through `base` instead of appending it.
 *
 * Anki's default is "mix with reviews", and the reason is workload: twenty new
 * cards in a row at the end of a session is where people quit. Even spacing
 * keeps the hard items apart.
 */
function interleave<T>(base: T[], extra: T[]): T[] {
  if (extra.length === 0) return base
  if (base.length === 0) return extra

  const out: T[] = []
  const gap = base.length / extra.length
  let next = 0
  let placed = 0

  for (let i = 0; i < base.length; i++) {
    while (placed < extra.length && i >= next) {
      out.push(extra[placed++])
      next = placed * gap
    }
    out.push(base[i])
  }
  while (placed < extra.length) out.push(extra[placed++])
  return out
}

/**
 * The cards to study now, in order.
 *
 * 1. Learning and relearning cards that are due — always first, always uncapped.
 *    They are mid-flight and dropping them would break the learning steps.
 * 2. Review cards due before tomorrow's 04:00, earliest first, capped.
 * 3. New cards in creation order, capped — interleaved into 2 rather than appended.
 */
/** Splits cards by deck so each deck gets its own allowance. */
function byDeck(cards: Card[]): Map<string, Card[]> {
  const groups = new Map<string, Card[]>()
  for (const card of cards) {
    const group = groups.get(card.deckId)
    if (group) group.push(card)
    else groups.set(card.deckId, [card])
  }
  return groups
}

function deckQueue(
  cards: Card[],
  deckId: string,
  input: QueueInput,
  rand: () => number,
): { learning: Card[]; rest: Card[] } {
  const { todayLog, settings, now } = input
  const { learning, review, fresh } = partition(
    cards,
    now,
    settings,
    buriedNotes(cards, todayLog),
  )
  const { newLeft, reviewLeft } = remainingToday(todayLog, settings, deckId)

  learning.sort((a, b) => a.fsrs.due.localeCompare(b.fsrs.due))

  // Random tiebreak so a batch imported in one second is not always reviewed in
  // import order. Assigned before sorting so the comparator stays consistent.
  const jitter = new Map(review.map((c) => [c.id, rand()]))
  review.sort(
    (a, b) =>
      a.fsrs.due.localeCompare(b.fsrs.due) || (jitter.get(a.id) ?? 0) - (jitter.get(b.id) ?? 0),
  )

  fresh.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  return {
    learning,
    rest: interleave(review.slice(0, reviewLeft), fresh.slice(0, newLeft)),
  }
}

export function buildQueue(input: QueueInput): Card[] {
  const rand = mulberry32(input.seed ?? 0)
  const learning: Card[] = []
  const rest: Card[] = []

  for (const [deckId, cards] of byDeck(input.cards)) {
    const q = deckQueue(cards, deckId, input, rand)
    learning.push(...q.learning)
    rest.push(...q.rest)
  }

  // Learning cards come first across every deck — they are mid-flight and the
  // steps break if they wait.
  learning.sort((a, b) => a.fsrs.due.localeCompare(b.fsrs.due))
  return [...learning, ...rest]
}

/** Counts for the Today screen. Same rules as `buildQueue`, without materializing it. */
export function queueCounts(input: QueueInput): QueueCounts {
  const { todayLog, settings, now } = input
  const counts: QueueCounts = { learning: 0, review: 0, new: 0, unseen: 0, total: 0 }

  for (const [deckId, cards] of byDeck(input.cards)) {
    const { learning, review, fresh, unseen } = partition(
      cards,
      now,
      settings,
      buriedNotes(cards, todayLog),
    )
    const { newLeft, reviewLeft } = remainingToday(todayLog, settings, deckId)

    counts.learning += learning.length
    counts.review += Math.min(review.length, reviewLeft)
    counts.new += Math.min(fresh.length, newLeft)
    counts.unseen += unseen
  }
  counts.total = counts.learning + counts.review + counts.new
  return counts
}

/** When the next card becomes due, or null if none is scheduled. For the empty state. */
export function nextDue(cards: Card[], now: Date): Date | null {
  const nowIso = now.toISOString()
  let soonest: string | null = null
  for (const card of cards) {
    if (!live(card) || isHeld(card, now) || card.fsrs.state === State.New) continue
    if (card.fsrs.due <= nowIso) return now
    if (soonest === null || card.fsrs.due < soonest) soonest = card.fsrs.due
  }
  return soonest ? new Date(soonest) : null
}
