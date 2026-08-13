import { create } from 'zustand'
import type { Card, Deck, ReviewLogEntry, Settings } from '#src/types.ts'
import { DEFAULT_SETTINGS } from '#src/types.ts'
import { dayEnd, dayStart } from '#src/lib/day.ts'
import { describe as describeSyncError } from '#src/lib/github.ts'
import { SyncError } from '#src/lib/github.ts'
import { getRepoRef, getSyncState, pendingCount, sync as runSync } from '#src/lib/sync.ts'
import {
  appendReviews,
  countCards,
  deleteReview,
  getCardsByDeck,
  getDecks,
  getReviewsBetween,
  getSettings,
  putCard,
  putSettings,
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
  recordAnswer: (previous: Card, card: Card, log: ReviewLogEntry) => Promise<void>
  /**
   * Takes back the last answer: restores the card as it was and drops the log
   * entry. Returns the restored card so the reviewer can refresh in place, or
   * null when there is nothing to undo.
   *
   * Session-scoped by design. Undoing an answer from yesterday would mean
   * rewriting history that has already synced, and a mis-tap is a
   * within-the-minute mistake.
   */
  undo: () => Promise<Card | null>
  canUndo: () => boolean
  saveSettings: (patch: Partial<Settings>) => Promise<void>

  /** True once a token and repository are stored on this device. */
  configured: boolean
  sync: {
    running: boolean
    pending: number
    lastSyncAt?: string
    error?: string
    errorKind?: string
  }
  syncNow: () => Promise<void>
  refreshPending: () => Promise<void>
  reloadConfig: () => void
}

interface UndoStep {
  previous: Card
  logId: string
}

const undoStack: UndoStep[] = []

export const useStore = create<State>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  decks: [],
  deckCounts: {},
  todayLog: [],
  ready: false,
  configured: getRepoRef() !== null,
  sync: { running: false, pending: 0 },

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

  async recordAnswer(previous, card, log) {
    await putCard(card)
    await appendReviews([log])
    undoStack.push({ previous, logId: log.id })
    set({ todayLog: [...get().todayLog, log] })
  },

  canUndo: () => undoStack.length > 0,

  async saveSettings(patch) {
    const settings = { ...get().settings, ...patch }
    await putSettings(settings)
    set({ settings })
  },

  reloadConfig() {
    set({ configured: getRepoRef() !== null })
  },

  async refreshPending() {
    if (!getRepoRef()) return
    const [pending, state] = await Promise.all([pendingCount(), getSyncState()])
    set({ sync: { ...get().sync, pending, lastSyncAt: state.lastSyncAt } })
  },

  async syncNow() {
    if (get().sync.running || !getRepoRef()) return
    set({ sync: { ...get().sync, running: true, error: undefined, errorKind: undefined } })
    try {
      await runSync()
      // Everything may have moved underneath, so the whole session is reloaded
      // rather than patched.
      await get().load()
      const state = await getSyncState()
      set({
        sync: { running: false, pending: await pendingCount(), lastSyncAt: state.lastSyncAt },
      })
    } catch (error) {
      set({
        sync: {
          ...get().sync,
          running: false,
          error: describeSyncError(error),
          errorKind: error instanceof SyncError ? error.kind : 'unknown',
        },
      })
    }
  },

  async undo() {
    const step = undoStack.pop()
    if (!step) return null
    await putCard(step.previous)
    await deleteReview(step.logId)
    set({ todayLog: get().todayLog.filter((e) => e.id !== step.logId) })
    return step.previous
  },
}))
