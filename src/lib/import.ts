import type { Card } from '#src/types.ts'
import { CHUNK_SIZE } from '#src/types.ts'

/**
 * Turning parsed rows into cards.
 *
 * Pure: ids, timestamps and the starting scheduling state are injected, so the
 * whole mapping is testable without a clock, a uuid source or `ts-fsrs`.
 */

/** Column index per field, or null when the field is not mapped. */
export interface ColumnMapping {
  front: number | null
  back: number | null
  example: number | null
  note: number | null
  /** Any number of columns; each becomes a tag. */
  tags: number[]
}

export type DuplicateMode = 'skip' | 'overwrite' | 'allow'

export interface ImportOptions {
  mapping: ColumnMapping
  /**
   * Also create the mirror card, back → front.
   *
   * Recognising a word and producing it are different skills, and only the second
   * forces the article and the spelling. Doubles the card count.
   */
  reverse: boolean
  duplicates: DuplicateMode
  /** BCP-47 tag stored on every card, reserved for text-to-speech. */
  lang?: string
  /** Applied to every card on top of the mapped tag columns. */
  extraTags?: string[]
}

export interface Deps {
  deckId: string
  newId: () => string
  now: string
  /** Scheduling state for a fresh card — `emptyFsrs` from the scheduler. */
  emptyFsrs: () => Card['fsrs']
  /** Fronts already in the deck, for duplicate detection. */
  existing?: Map<string, Card>
  /** Chunk to start filling, so an import continues where the deck left off. */
  startChunk?: number
  /** Cards already in `startChunk`. */
  startChunkCount?: number
}

export interface ImportResult {
  cards: Card[]
  /** Rows skipped because front or back was empty. */
  emptyRows: number
  /** Rows skipped as duplicates. */
  duplicates: number
  /** Cards that replace an existing one, under `overwrite`. */
  overwritten: number
}

const cell = (row: string[], index: number | null): string =>
  index === null ? '' : (row[index] ?? '').trim()

/** Duplicate detection ignores case and surrounding whitespace, nothing else. */
export function dedupeKey(front: string): string {
  return front.trim().toLowerCase()
}

export function buildCards(rows: string[][], options: ImportOptions, deps: Deps): ImportResult {
  const { mapping, reverse, duplicates, lang, extraTags = [] } = options
  const existing = deps.existing ?? new Map<string, Card>()

  const cards: Card[] = []
  let emptyRows = 0
  let duplicateCount = 0
  let overwritten = 0

  // Chunk numbers are assigned here and frozen on the card, continuing from
  // whatever the deck already holds rather than restarting at zero.
  let chunk = deps.startChunk ?? 0
  let inChunk = deps.startChunkCount ?? 0
  const takeChunk = (): number => {
    if (inChunk >= CHUNK_SIZE) {
      chunk++
      inChunk = 0
    }
    inChunk++
    return chunk
  }

  // Guards against duplicates inside the file itself, not just against the deck.
  const seen = new Set<string>()

  for (const row of rows) {
    const front = cell(row, mapping.front)
    const back = cell(row, mapping.back)
    if (!front || !back) {
      emptyRows++
      continue
    }

    const tags = [...mapping.tags.map((i) => cell(row, i)), ...extraTags]
      .flatMap((t) => t.split(/[\s,]+/))
      .map((t) => t.trim())
      .filter(Boolean)

    const example = cell(row, mapping.example) || undefined
    const note = cell(row, mapping.note) || undefined

    // Both directions belong to one note, so the queue can keep them apart.
    const noteId = deps.newId()
    const make = (f: string, b: string, extra: string[]): Card => ({
      id: deps.newId(),
      noteId,
      deckId: deps.deckId,
      chunk: takeChunk(),
      front: f,
      back: b,
      ...(example ? { example } : {}),
      ...(note ? { note } : {}),
      tags: [...new Set([...tags, ...extra])],
      ...(lang ? { lang } : {}),
      fsrs: deps.emptyFsrs(),
      createdAt: deps.now,
      updatedAt: deps.now,
    })

    const key = dedupeKey(front)
    const clash = existing.get(key) ?? (seen.has(key) ? ({} as Card) : undefined)

    if (clash && duplicates !== 'allow') {
      if (duplicates === 'skip') {
        duplicateCount++
        continue
      }
      overwritten++
    }
    seen.add(key)

    // The forward card keeps the row's own tags; the mirror is marked so it can
    // be found, suspended or deleted later without touching the originals.
    cards.push(make(front, back, []))
    if (reverse) cards.push(make(back, front, ['reverse']))
  }

  return { cards, emptyRows, duplicates: duplicateCount, overwritten }
}

/** Column names for the mapping UI, falling back to `Column 3` when a header cell is blank. */
export function headerLabels(headerRow: string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => headerRow[i]?.trim() || `Column ${i + 1}`)
}

/**
 * A first guess at the mapping so the common case needs no clicking.
 * Matches on common header names in English, Korean and German.
 */
export function guessMapping(headers: string[]): ColumnMapping {
  const find = (patterns: RegExp[]): number | null => {
    for (const pattern of patterns) {
      const i = headers.findIndex((h) => pattern.test(h.trim()))
      if (i !== -1) return i
    }
    return null
  }

  const front = find([/^(front|term|word|question|단어|표현|독일어|german|deutsch)$/i, /(word|단어|독일어)/i])
  const back = find([/^(back|meaning|answer|뜻|의미|해석|korean|english)$/i, /(뜻|meaning|번역)/i])
  const example = find([/^(example|sentence|예문|beispiel)$/i, /(예문|example)/i])
  const note = find([/^(note|memo|hint|메모|비고|주의|포인트)$/i, /(포인트|주의|비고|note)/i])

  const used = new Set([front, back, example, note].filter((i): i is number => i !== null))
  const tags = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => !used.has(i) && /^(tag|tags|태그|teil|category|분류|유형)/i.test(h.trim()))
    .map(({ i }) => i)

  return { front, back, example, note, tags }
}
