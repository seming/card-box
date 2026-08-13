import { z } from 'zod'
import type { Card, Deck, ReviewLogEntry, Settings } from '#src/types.ts'
import { CardSchema, DeckSchema, ReviewLogEntrySchema, SettingsSchema } from '#src/types.ts'
import { GitHub, SyncError } from '#src/lib/github.ts'
import type { RepoRef } from '#src/lib/github.ts'
import {
  byChunk,
  changedChunks,
  mergeCards,
  mergeDecks,
  mergeReviews,
  mergeSettings,
  parseReviews,
  serializeCards,
  serializeReviews,
} from '#src/lib/merge.ts'
import { dayKey } from '#src/lib/day.ts'
import {
  getAllCards,
  getDecksRaw,
  getAllReviews,
  getMeta,
  getSettings,
  putCards,
  putDecks,
  appendReviews,
  putMeta,
  putSettings,
} from '#src/lib/idb.ts'

/**
 * Pull, merge, push.
 *
 * Reviewing never waits for any of this — answers reach IndexedDB first, and a
 * sync only ever copies what is already safe. A sync that fails for a month
 * leaves the other device stale; it does not lose anything.
 */

/** Remote layout. Chunk shas ride along so a pull can skip what has not moved. */
const IndexSchema = z.object({
  decks: z.array(DeckSchema).default([]),
  reviewDays: z.array(z.string()).default([]),
  settingsAt: z.string().optional(),
})
type RemoteIndex = z.infer<typeof IndexSchema>

const MetaSchema = z.object({
  deckId: z.string(),
  chunks: z.array(z.object({ n: z.number(), sha: z.string().optional(), count: z.number() })).default([]),
})

export interface SyncState {
  /** Blob shas seen last time, by path. A hint for skipping, never a source of truth. */
  shas: Record<string, string>
  lastSyncAt?: string
  settingsAt?: string
}

export interface SyncSummary {
  pulled: { cards: number; reviews: number; decks: number }
  pushed: { chunks: number; reviews: number }
  at: string
}

const TOKEN_KEY = 'cardbox.token'
const REPO_KEY = 'cardbox.repo'

/**
 * The token lives in localStorage, never in IndexedDB.
 *
 * IndexedDB is what the JSON export copies and what sync itself reads, and a
 * credential belongs in neither. It is also per device on purpose — each device
 * gets its own token so one can be revoked alone.
 */
export function getRepoRef(): RepoRef | null {
  const token = localStorage.getItem(TOKEN_KEY)
  const repo = localStorage.getItem(REPO_KEY)
  if (!token || !repo) return null
  const [owner, name] = repo.split('/')
  if (!owner || !name) return null
  return { owner, repo: name, token }
}

export function setRepoRef(owner: string, repo: string, token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(REPO_KEY, `${owner}/${repo}`)
}

export function clearRepoRef(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REPO_KEY)
}

export function getStoredRepo(): string {
  return localStorage.getItem(REPO_KEY) ?? ''
}

export async function getSyncState(): Promise<SyncState> {
  return (await getMeta<SyncState>('sync')) ?? { shas: {} }
}

/** Parses what came back, dropping anything malformed rather than failing the sync. */
function parseAll<T>(schema: z.ZodType<T>, items: unknown[], what: string): T[] {
  const out: T[] = []
  for (const item of items) {
    const result = schema.safeParse(item)
    if (result.success) out.push(result.data)
    else console.warn(`sync: skipping malformed ${what}`, result.error.issues[0]?.message)
  }
  return out
}

const cardsPath = (deckId: string, chunk: number) =>
  `decks/${deckId}/cards-${String(chunk).padStart(3, '0')}.json`
const metaPath = (deckId: string) => `decks/${deckId}/meta.json`
const reviewsPath = (day: string) => `reviews/${day}.jsonl`

export async function sync(now = new Date()): Promise<SyncSummary> {
  const ref = getRepoRef()
  if (!ref) throw new SyncError('no-token', 'No token')
  const api = new GitHub(ref)

  const state = await getSyncState()
  const shas = { ...state.shas }
  const summary: SyncSummary = {
    pulled: { cards: 0, reviews: 0, decks: 0 },
    pushed: { chunks: 0, reviews: 0 },
    at: now.toISOString(),
  }

  /* ── index ─────────────────────────────────────────────────────────── */

  const indexFile = await api.get('index.json')
  const remoteIndex: RemoteIndex = indexFile
    ? IndexSchema.parse(JSON.parse(indexFile.text))
    : { decks: [], reviewDays: [] }

  const localDecks = await getDecksRaw()
  const decks = mergeDecks(localDecks, remoteIndex.decks)
  summary.pulled.decks = decks.stats.fromRemote

  /* ── settings ──────────────────────────────────────────────────────── */

  const localSettings = await getSettings()
  const localSettingsAt = state.settingsAt
  let settings = localSettings
  const settingsFile = await api.get('settings.json')
  if (settingsFile) {
    const parsed = SettingsSchema.safeParse(JSON.parse(settingsFile.text))
    if (parsed.success) {
      settings = mergeSettings(localSettings, parsed.data, localSettingsAt, remoteIndex.settingsAt)
      if (settings !== localSettings) await putSettings(settings)
    }
  }

  /* ── cards, deck by deck ───────────────────────────────────────────── */

  const localCards = await getAllCards({ includeDeleted: true })
  const localByDeck = new Map<string, Card[]>()
  for (const card of localCards) {
    const list = localByDeck.get(card.deckId)
    if (list) list.push(card)
    else localByDeck.set(card.deckId, [card])
  }

  const deckIds = new Set([...localByDeck.keys(), ...decks.merged.map((d) => d.id)])
  const toWrite: { path: string; text: string; sha?: string; message: string }[] = []
  const mergedCards: Card[] = []

  for (const deckId of deckIds) {
    const mine = localByDeck.get(deckId) ?? []
    const metaFile = await api.get(metaPath(deckId))
    const remoteMeta = metaFile
      ? MetaSchema.parse(JSON.parse(metaFile.text))
      : { deckId, chunks: [] as { n: number; sha?: string; count: number }[] }

    // Fetch only the chunks whose sha moved. The recorded sha is a hint: when it
    // disagrees with what the API reports, refetch rather than trust it. That is
    // what makes it safe to write this repository from outside the app.
    const remoteCards: Card[] = []
    const remoteByChunk = new Map<number, Card[]>()
    for (const chunk of remoteMeta.chunks) {
      const path = cardsPath(deckId, chunk.n)
      const file = await api.get(path)
      if (!file) continue
      shas[path] = file.sha
      const parsed = parseAll(CardSchema, JSON.parse(file.text) as unknown[], 'card')
      remoteCards.push(...parsed)
      remoteByChunk.set(chunk.n, parsed)
    }

    const merged = mergeCards(mine, remoteCards)
    summary.pulled.cards += merged.stats.fromRemote
    mergedCards.push(...merged.merged)

    const mergedByChunk = byChunk(merged.merged)
    for (const chunk of changedChunks(mergedByChunk, remoteByChunk)) {
      const path = cardsPath(deckId, chunk)
      const cards = mergedByChunk.get(chunk) ?? []
      toWrite.push({
        path,
        text: serializeCards(cards),
        sha: shas[path],
        message: `Update ${cards.length} cards`,
      })
    }

    // meta.json is written after its chunks — see the write order below.
    const chunkList = [...mergedByChunk.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, cards]) => ({ n, sha: shas[cardsPath(deckId, n)], count: cards.length }))
    const metaText = JSON.stringify({ deckId, chunks: chunkList }, null, 1)
    if (!metaFile || metaFile.text !== metaText) {
      toWrite.push({
        path: metaPath(deckId),
        text: metaText,
        sha: metaFile?.sha,
        message: `Update ${deckId} index`,
      })
    }
  }

  if (mergedCards.length) await putCards(mergedCards)
  if (decks.stats.fromRemote) await putDecks(decks.merged)

  /* ── review log ────────────────────────────────────────────────────── */

  const localReviews = await getAllReviews()
  const localDays = new Map<string, ReviewLogEntry[]>()
  for (const entry of localReviews) {
    const day = dayKey(new Date(entry.review), settings.dayStartHour)
    const list = localDays.get(day)
    if (list) list.push(entry)
    else localDays.set(day, [entry])
  }

  const days = new Set([...localDays.keys(), ...remoteIndex.reviewDays])
  const pulledReviews: ReviewLogEntry[] = []

  for (const day of days) {
    const path = reviewsPath(day)
    const mine = localDays.get(day) ?? []

    // Past days never change again, so a day already synced is skipped entirely.
    const isToday = day === dayKey(now, settings.dayStartHour)
    const settled = !isToday && shas[path] !== undefined && mine.length > 0
    if (settled) continue

    const file = await api.get(path)
    const theirs = file ? parseAll(ReviewLogEntrySchema, parseReviews(file.text), 'review') : []
    const merged = mergeReviews(mine, theirs)
    if (merged.stats.fromRemote) pulledReviews.push(...merged.merged.filter((e) => !mine.some((m) => m.id === e.id)))

    const text = serializeReviews(merged.merged)
    if (!file || file.text !== text) {
      toWrite.push({ path, text, sha: file?.sha, message: `Review log ${day}` })
    } else if (file) {
      shas[path] = file.sha
    }
  }

  if (pulledReviews.length) {
    await appendReviews(pulledReviews)
    summary.pulled.reviews = pulledReviews.length
  }

  /* ── write ─────────────────────────────────────────────────────────── */

  /**
   * Chunks first, then each deck's meta.json, then index.json.
   *
   * meta.json declares which chunks are valid, so writing it last means an
   * interruption leaves undeclared files that the next attempt overwrites. The
   * reverse order would point at files that do not exist.
   */
  const order = (path: string) => (path.endsWith('cards-000.json') || path.includes('cards-') ? 0 : 1)
  toWrite.sort((a, b) => order(a.path) - order(b.path))

  for (const file of toWrite) {
    const sha = await putWithRetry(api, file.path, file.text, file.message, file.sha ?? shas[file.path])
    shas[file.path] = sha
    if (file.path.includes('cards-')) summary.pushed.chunks++
    if (file.path.startsWith('reviews/')) summary.pushed.reviews++
  }

  /**
   * Settings before the index, because the index carries their timestamp.
   *
   * That timestamp only moves when the file actually changes. Stamping `now`
   * every run made index.json differ on every sync, so an idle sync still
   * produced a commit — a slow drip of empty history that would have made the
   * repository useless as a record of what changed.
   */
  const settingsText = JSON.stringify(settings, null, 1)
  let settingsAt = state.settingsAt ?? remoteIndex.settingsAt
  if (!settingsFile || settingsFile.text !== settingsText) {
    shas['settings.json'] = await putWithRetry(
      api,
      'settings.json',
      settingsText,
      'Update settings',
      settingsFile?.sha,
    )
    settingsAt = now.toISOString()
  }

  const indexText = JSON.stringify(
    {
      decks: decks.merged,
      reviewDays: [...days].sort(),
      ...(settingsAt ? { settingsAt } : {}),
    },
    null,
    1,
  )
  if (!indexFile || indexFile.text !== indexText) {
    shas['index.json'] = await putWithRetry(api, 'index.json', indexText, 'Update index', indexFile?.sha)
  }

  await putMeta('sync', { shas, lastSyncAt: summary.at, settingsAt })
  return summary
}

/**
 * A conflict means another device wrote between our read and our write. Re-read
 * to pick up its sha and try again; the merge already happened, so the content
 * is correct either way.
 */
async function putWithRetry(
  api: GitHub,
  path: string,
  text: string,
  message: string,
  sha: string | undefined,
  attempt = 0,
): Promise<string> {
  try {
    return await api.put(path, text, message, sha)
  } catch (error) {
    if (error instanceof SyncError && error.kind === 'conflict' && attempt < 3) {
      const current = await api.get(path)
      return putWithRetry(api, path, text, message, current?.sha, attempt + 1)
    }
    throw error
  }
}

/** Everything written locally but not yet on the remote, for the status line. */
export async function pendingCount(): Promise<number> {
  const state = await getSyncState()
  if (!state.lastSyncAt) {
    const cards = await getAllCards({ includeDeleted: true })
    return cards.length
  }
  const since = state.lastSyncAt
  const [cards, reviews, decks] = await Promise.all([
    getAllCards({ includeDeleted: true }),
    getAllReviews(),
    getDecksRaw(),
  ])
  return (
    cards.filter((c) => c.updatedAt > since).length +
    reviews.filter((r) => r.review > since).length +
    decks.filter((d: Deck) => d.updatedAt > since).length
  )
}

export type { Settings }
