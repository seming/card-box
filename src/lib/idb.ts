import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { Card, Deck, ReviewLogEntry, Settings } from '#src/types.ts'
import { CHUNK_SIZE, DEFAULT_SETTINGS } from '#src/types.ts'

/**
 * Local store. This is the working copy: every read and write goes here first
 * and the app is fully usable with no network. GitHub is a sync target, not the
 * source of truth during a session.
 *
 * localStorage is not an option at 10,000 cards — it is synchronous, string
 * only, and capped around 5MB.
 */

const DB_NAME = 'cardbox'
const DB_VERSION = 1

interface CardboxDB extends DBSchema {
  decks: {
    key: string
    value: Deck
  }
  cards: {
    key: string
    value: Card
    indexes: {
      deckId: string
      due: string
      /** `[deckId, chunk]` — the unit that gets pushed to GitHub. */
      deckChunk: [string, number]
    }
  }
  reviews: {
    key: string
    value: ReviewLogEntry
    indexes: {
      review: string
      cardId: string
    }
  }
  /** Loose key/value: settings, sync cursors, chunk shas. */
  meta: {
    key: string
    value: unknown
  }
}

let dbPromise: Promise<IDBPDatabase<CardboxDB>> | null = null

export function db(): Promise<IDBPDatabase<CardboxDB>> {
  dbPromise ??= openDB<CardboxDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('decks', { keyPath: 'id' })

      const cards = database.createObjectStore('cards', { keyPath: 'id' })
      cards.createIndex('deckId', 'deckId')
      cards.createIndex('due', 'fsrs.due')
      cards.createIndex('deckChunk', ['deckId', 'chunk'])

      const reviews = database.createObjectStore('reviews', { keyPath: 'id' })
      reviews.createIndex('review', 'review')
      reviews.createIndex('cardId', 'cardId')

      database.createObjectStore('meta')
    },
  })
  return dbPromise
}

/* ── decks ──────────────────────────────────────────────────────────────── */

/** Live decks only. Tombstoned decks stay in the store for sync but never surface. */
export async function getDecks(): Promise<Deck[]> {
  const all = await (await db()).getAll('decks')
  return all.filter((d) => !d.deleted).sort((a, b) => a.name.localeCompare(b.name))
}

export async function getDeck(id: string): Promise<Deck | undefined> {
  return (await db()).get('decks', id)
}

export async function putDeck(deck: Deck): Promise<void> {
  await (await db()).put('decks', deck)
}

/**
 * Tombstones the deck and every card in it. Nothing is physically removed —
 * see the `deleted` field in types.ts for why.
 */
export async function deleteDeck(id: string, at: string): Promise<void> {
  const database = await db()
  const tx = database.transaction(['decks', 'cards'], 'readwrite')
  const deck = await tx.objectStore('decks').get(id)
  if (deck) await tx.objectStore('decks').put({ ...deck, deleted: true, updatedAt: at })

  const cardStore = tx.objectStore('cards')
  let cursor = await cardStore.index('deckId').openCursor(IDBKeyRange.only(id))
  while (cursor) {
    if (!cursor.value.deleted) {
      await cursor.update({ ...cursor.value, deleted: true, updatedAt: at })
    }
    cursor = await cursor.continue()
  }
  await tx.done
}

/* ── cards ──────────────────────────────────────────────────────────────── */

export async function getCard(id: string): Promise<Card | undefined> {
  return (await db()).get('cards', id)
}

export async function getCardsByDeck(deckId: string): Promise<Card[]> {
  const all = await (await db()).getAllFromIndex('cards', 'deckId', IDBKeyRange.only(deckId))
  return all.filter((c) => !c.deleted)
}

/** Every live card, across decks. Backs a review session that spans all decks. */
export async function getAllCards(): Promise<Card[]> {
  const all = await (await db()).getAll('cards')
  return all.filter((c) => !c.deleted)
}

export async function countCards(deckId: string): Promise<number> {
  // Counts tombstones too; callers that care use getCardsByDeck. Kept cheap
  // because the deck list calls it once per deck on every render.
  return (await db()).countFromIndex('cards', 'deckId', IDBKeyRange.only(deckId))
}

export async function putCard(card: Card): Promise<void> {
  await (await db()).put('cards', card)
}

/** Bulk insert in one transaction — importing 10,000 cards one call at a time is far slower. */
export async function putCards(cards: Card[]): Promise<void> {
  const database = await db()
  const tx = database.transaction('cards', 'readwrite')
  await Promise.all(cards.map((c) => tx.store.put(c)))
  await tx.done
}

export async function deleteCard(id: string, at: string): Promise<void> {
  const card = await getCard(id)
  if (!card) return
  await putCard({ ...card, deleted: true, updatedAt: at })
}

/**
 * Chunk to place a new card in: the last one, unless it is full.
 * Chunk numbers are assigned here and then frozen on the card.
 */
export async function nextChunk(deckId: string): Promise<number> {
  const database = await db()
  const index = database.transaction('cards').store.index('deckChunk')
  const last = await index.openCursor(
    IDBKeyRange.bound([deckId, -Infinity], [deckId, Infinity]),
    'prev',
  )
  if (!last) return 0
  const chunk = last.value.chunk
  const count = await database.countFromIndex('cards', 'deckChunk', IDBKeyRange.only([deckId, chunk]))
  return count < CHUNK_SIZE ? chunk : chunk + 1
}

/* ── reviews ────────────────────────────────────────────────────────────── */

/** Append-only. Existing ids are left alone so a replayed sync cannot duplicate. */
export async function appendReviews(entries: ReviewLogEntry[]): Promise<void> {
  const database = await db()
  const tx = database.transaction('reviews', 'readwrite')
  await Promise.all(
    entries.map(async (e) => {
      if (!(await tx.store.get(e.id))) await tx.store.put(e)
    }),
  )
  await tx.done
}

/** Reviews in `[from, to)`, by ISO string. Used for the daily new/review counts. */
export async function getReviewsBetween(from: string, to: string): Promise<ReviewLogEntry[]> {
  return (await db()).getAllFromIndex('reviews', 'review', IDBKeyRange.bound(from, to, false, true))
}

export async function countReviews(): Promise<number> {
  return (await db()).count('reviews')
}

/* ── meta ───────────────────────────────────────────────────────────────── */

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db()).get('meta', key) as Promise<T | undefined>
}

export async function putMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', value, key)
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await getMeta<Partial<Settings>>('settings')) ?? {}) }
}

export async function putSettings(settings: Settings): Promise<void> {
  await putMeta('settings', settings)
}
