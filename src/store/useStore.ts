import { create } from 'zustand'
import type { Card, Deck, ReviewLogEntry, Settings } from '#src/types.ts'
import { DEFAULT_SETTINGS } from '#src/types.ts'
import { dayEnd, dayStart } from '#src/lib/day.ts'
import {
  appendReviews,
  countCards,
  getCardsByDeck,
  getDecks,
  getReviewsBetween,
  getSettings,
  putCard,
} from '#src/lib/idb.ts'

/**
 * Shared app state. Deliberately thin — IndexedDB is the source of truth and
 * this only caches what more than one screen needs.
 *
 * `todayLog` is the day's reviews, which is what the daily limits are computed
 * from. Loading it once per session and appending in memory avoids re-reading
 * the log after every answer.
 */

interface State {
  settings: Settings
  decks: Deck[]
  deckCounts: Record<string, number>
  todayLog: ReviewLogEntry[]
  ready: boolean

  load: () => Promise<void>
  refreshDecks: () => Promise<void>
  loadDeckCards: (deckId: string) => Promise<Card[]>
  /** Persists the answered card and its log entry, and keeps `todayLog` current. */
  recordAnswer: (card: Card, log: ReviewLogEntry) => Promise<void>
}

export const useStore = create<State>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  decks: [],
  deckCounts: {},
  todayLog: [],
  ready: false,

  async load() {
    const settings = await getSettings()
    const now = new Date()
    const todayLog = await getReviewsBetween(
      dayStart(now, settings.dayStartHour).toISOString(),
      dayEnd(now, settings.dayStartHour).toISOString(),
    )
    set({ settings, todayLog, ready: true })
    await get().refreshDecks()
  },

  async refreshDecks() {
    const decks = await getDecks()
    const counts = await Promise.all(decks.map(async (d) => [d.id, await countCards(d.id)] as const))
    set({ decks, deckCounts: Object.fromEntries(counts) })
  },

  loadDeckCards(deckId) {
    return getCardsByDeck(deckId)
  },

  async recordAnswer(card, log) {
    await putCard(card)
    await appendReviews([log])
    set({ todayLog: [...get().todayLog, log] })
  },
}))
