import { z } from 'zod'

/**
 * Schemas for everything that crosses a persistence boundary — IndexedDB and
 * the JSON files in `cardbox-data`. Parse on the way in; never trust a file.
 *
 * Dates are ISO-8601 strings here. `ts-fsrs` works in `Date` objects, and
 * `lib/scheduler.ts` owns that conversion so nothing else has to think about it.
 */

const isoDate = z.iso.datetime()

/**
 * Card lifecycle state. Values match `ts-fsrs`'s `State` enum exactly, and also
 * the `review_state` column the FSRS optimizer expects — so the review log
 * exports with no translation table. `lib/scheduler.ts` asserts the match.
 */
export const State = { New: 0, Learning: 1, Review: 2, Relearning: 3 } as const
export type StateValue = (typeof State)[keyof typeof State]

/** Answer button. Values match `ts-fsrs`'s `Rating` enum and the optimizer's `review_rating`. */
export const Rating = { Manual: 0, Again: 1, Hard: 2, Good: 3, Easy: 4 } as const
export type RatingValue = (typeof Rating)[keyof typeof Rating]

const stateSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
const ratingSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])

/** Scheduling state, mirroring `ts-fsrs`'s `Card` with dates serialized. */
export const CardFsrsSchema = z.object({
  due: isoDate,
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number(),
  scheduled_days: z.number(),
  learning_steps: z.number().int().nonnegative(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  state: stateSchema,
  last_review: isoDate.optional(),
})
export type CardFsrs = z.infer<typeof CardFsrsSchema>

export const CardSchema = z.object({
  id: z.string().min(1),
  deckId: z.string().min(1),
  /**
   * The note this card belongs to. The two directions of one word share it,
   * which is what lets the queue hold a sibling back so both do not turn up in
   * the same session — being shown the answer minutes before the question is
   * not a review.
   *
   * Optional: cards created before notes existed fall back to their own id and
   * behave as a note of one.
   */
  noteId: z.string().min(1).optional(),
  /**
   * Which `cards-NNN.json` file this card lives in. Assigned once at creation
   * and never recomputed — deriving it from a hash would re-shuffle every card
   * the moment the chunk size changed.
   */
  chunk: z.number().int().nonnegative(),

  front: z.string(),
  back: z.string(),
  example: z.string().optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** BCP-47 tag, e.g. `en-US`. Reserved for text-to-speech in phase 2. */
  lang: z.string().optional(),

  fsrs: CardFsrsSchema,

  createdAt: isoDate,
  /** Merge key. On conflict the later `updatedAt` wins, per card. */
  updatedAt: isoDate,
  /**
   * Taken out of rotation until explicitly restored. Survives forever, unlike
   * burying — the card for a word you have decided not to learn, or one that is
   * broken and not yet fixed.
   */
  suspended: z.boolean().optional(),
  /**
   * Held back until this instant, then returns on its own. Manual burying: "not
   * this session". Sibling burying is derived from the log instead and stores
   * nothing, but a manual choice has nowhere else to live.
   */
  buriedUntil: isoDate.optional(),

  /**
   * Tombstone. Deleted cards are kept, not removed — otherwise a card deleted
   * on one device reappears the next time the other device syncs.
   */
  deleted: z.boolean().optional(),
})
export type Card = z.infer<typeof CardSchema>

export const DeckSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deleted: z.boolean().optional(),
})
export type Deck = z.infer<typeof DeckSchema>

/**
 * One answered card. Append-only and never deleted: this is the sole input to
 * FSRS parameter optimization, and the daily new/review counts are derived from
 * it rather than from a separate counter that would need its own merge rules.
 */
export const ReviewLogEntrySchema = z.object({
  id: z.string().min(1),
  cardId: z.string().min(1),
  deckId: z.string().min(1),

  rating: ratingSchema,
  /** The state the card was in *before* this answer. */
  state: stateSchema,
  due: isoDate,
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number(),
  last_elapsed_days: z.number(),
  scheduled_days: z.number(),
  learning_steps: z.number().int().nonnegative(),
  review: isoDate,

  /**
   * Milliseconds from showing the card to pressing a rating, clamped to 60s so
   * that walking away does not register as an hour of thinking. Optional to the
   * optimizer, but it cannot be reconstructed later, so it is recorded from the
   * first release.
   */
  duration: z.number().int().nonnegative(),
})
export type ReviewLogEntry = z.infer<typeof ReviewLogEntrySchema>

/**
 * A learning step: `1m`, `10m`, `2h`, `1d`. `ts-fsrs` types these as a template
 * literal, so `z.custom` is used to carry that type through while still
 * validating the shape at runtime — a plain `z.string()` would force a cast at
 * the call site and lose the check.
 */
export type Step = `${number}m` | `${number}h` | `${number}d`

const stepSchema = z.custom<Step>(
  (v) => typeof v === 'string' && /^\d+(\.\d+)?[mhd]$/.test(v),
  { message: 'Step must look like 1m, 10m, 2h or 1d' },
)

/** Synced via `settings.json`. The GitHub token is deliberately not here — it stays device-local. */
export const SettingsSchema = z.object({
  requestRetention: z.number().min(0.7).max(0.99).default(0.9),
  maximumInterval: z.number().int().positive().default(36500),
  learningSteps: z.array(stepSchema).default(['1m', '10m']),
  relearningSteps: z.array(stepSchema).default(['10m']),
  newPerDay: z.number().int().nonnegative().default(20),

  /**
   * Burying: hold the other cards of a note until the next study day.
   *
   * Three switches, keyed on the queue the *buried* card sits in, matching
   * Anki's `bury_new` / `bury_reviews` / `bury_interday_learning` — including
   * its defaults, which are all off.
   *
   * Off suits Anki's median user, who mostly has one card per note. It is wrong
   * for a deck built with reverse cards: there every note has a sibling, so both
   * directions run the same day and the second is a copying exercise. Turn
   * `buryNew` on for such a deck.
   */
  buryNew: z.boolean().default(false),
  buryReviews: z.boolean().default(false),
  /**
   * Learning cards that crossed a day boundary. With 1m/10m steps almost nothing
   * lands here, so this exists for parity rather than effect.
   */
  buryInterdayLearning: z.boolean().default(false),
  reviewsPerDay: z.number().int().nonnegative().default(200),
  dayStartHour: z.number().int().min(0).max(23).default(4),
  /** Optimized FSRS weights. Empty until the optimizer has been run; see PRD §5. */
  w: z.array(z.number()).optional(),
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/** Cards per `cards-NNN.json`. See HANDOFF §9 — this is an estimate, not a measurement. */
export const CHUNK_SIZE = 500
