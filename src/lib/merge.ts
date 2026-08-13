import type { Card, Deck, ReviewLogEntry, Settings } from '#src/types.ts'

/**
 * Reconciling two devices.
 *
 * Pure, and the most heavily tested module here — a merge bug does not crash or
 * look wrong. It silently drops an evening's reviews, and the schedule quietly
 * drifts for weeks before anything feels off.
 *
 * The rule is per record, never per file: last write wins on `updatedAt`. That
 * is what lets "three cards on the phone, five different ones on the laptop"
 * survive as eight, where a whole-file choice would discard one side.
 */

export interface MergeStats {
  fromLocal: number
  fromRemote: number
  unchanged: number
}

export interface MergeResult<T> {
  merged: T[]
  stats: MergeStats
}

interface Versioned {
  id: string
  updatedAt: string
}

/**
 * Union by id, keeping whichever side was written last.
 *
 * **Ties are broken by content, not by which side is "remote."** Preferring the
 * remote copy looks reasonable and is wrong: whichever device syncs second calls
 * the other one remote, so the two would settle on different records and never
 * converge. Comparing the serialized record picks arbitrarily but identically on
 * both devices, which is the property that matters.
 *
 * A tie means the same millisecond on two devices for one record — rare, and
 * exactly the case that would otherwise diverge silently.
 */
function mergeById<T extends Versioned>(local: T[], remote: T[]): MergeResult<T> {
  const byId = new Map<string, T>()
  const stats: MergeStats = { fromLocal: 0, fromRemote: 0, unchanged: 0 }

  for (const item of local) byId.set(item.id, item)

  for (const item of remote) {
    const mine = byId.get(item.id)
    if (!mine) {
      byId.set(item.id, item)
      stats.fromRemote++
      continue
    }

    if (item.updatedAt > mine.updatedAt) {
      byId.set(item.id, item)
      stats.fromRemote++
    } else if (item.updatedAt < mine.updatedAt) {
      stats.fromLocal++
    } else {
      const a = JSON.stringify(mine)
      const b = JSON.stringify(item)
      if (a === b) stats.unchanged++
      else {
        if (b > a) byId.set(item.id, item)
        stats.unchanged++
      }
    }
  }

  return { merged: [...byId.values()], stats }
}

/**
 * Cards from both devices.
 *
 * Deletion is just another edit — a tombstone carries `updatedAt` like anything
 * else, so a card deleted on one device stays deleted, and a card edited *after*
 * being deleted comes back. Both follow from the same rule; neither is special-cased.
 */
export function mergeCards(local: Card[], remote: Card[]): MergeResult<Card> {
  return mergeById(local, remote)
}

export function mergeDecks(local: Deck[], remote: Deck[]): MergeResult<Deck> {
  return mergeById(local, remote)
}

/**
 * Review log entries.
 *
 * A plain union by id, with no comparison: the log is append-only and an entry
 * is never edited, so two copies of an id are the same answer seen twice. Nothing
 * is ever dropped — this is the record parameter optimization will read, and the
 * daily counts derive from it.
 */
export function mergeReviews(
  local: ReviewLogEntry[],
  remote: ReviewLogEntry[],
): MergeResult<ReviewLogEntry> {
  const byId = new Map<string, ReviewLogEntry>()
  const stats: MergeStats = { fromLocal: local.length, fromRemote: 0, unchanged: 0 }

  for (const e of local) byId.set(e.id, e)
  for (const e of remote) {
    if (byId.has(e.id)) stats.unchanged++
    else {
      byId.set(e.id, e)
      stats.fromRemote++
    }
  }

  return {
    merged: [...byId.values()].sort((a, b) => a.review.localeCompare(b.review) || a.id.localeCompare(b.id)),
    stats,
  }
}

/**
 * Settings are merged whole rather than per field: they are a handful of numbers
 * changed rarely and deliberately, and a field-wise merge would produce a
 * combination neither device ever chose.
 */
export function mergeSettings(
  local: Settings,
  remote: Settings,
  localAt?: string,
  remoteAt?: string,
): Settings {
  if (!remoteAt) return local
  if (!localAt) return remote
  return remoteAt >= localAt ? remote : local
}

/** Cards grouped by the chunk file they belong to. */
export function byChunk(cards: Card[]): Map<number, Card[]> {
  const out = new Map<number, Card[]>()
  for (const card of cards) {
    const list = out.get(card.chunk)
    if (list) list.push(card)
    else out.set(card.chunk, [card])
  }
  return out
}

/**
 * Which chunks differ between the merge result and what was already on the
 * remote, so a sync uploads only what changed.
 *
 * Compared by content, not by a dirty flag: a flag can be set by a write that
 * changed nothing, and after a merge the local copy may already equal the remote.
 */
export function changedChunks(
  merged: Map<number, Card[]>,
  remote: Map<number, Card[]>,
): number[] {
  const out: number[] = []
  for (const [chunk, cards] of merged) {
    const theirs = remote.get(chunk)
    if (!theirs || !sameCards(cards, theirs)) out.push(chunk)
  }
  return out.sort((a, b) => a - b)
}

function sameCards(a: Card[], b: Card[]): boolean {
  if (a.length !== b.length) return false
  const byId = new Map(b.map((c) => [c.id, c]))
  return a.every((card) => byId.get(card.id)?.updatedAt === card.updatedAt)
}

/** Stable serialization, so an unchanged chunk produces an identical file. */
export function serializeCards(cards: Card[]): string {
  return JSON.stringify([...cards].sort((a, b) => a.id.localeCompare(b.id)), null, 1)
}

export function serializeReviews(entries: ReviewLogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

export function parseReviews(text: string): ReviewLogEntry[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReviewLogEntry)
}
