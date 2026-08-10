import { useCallback, useEffect, useState } from 'react'
import type { Card, Deck } from '#src/types.ts'
import { CHUNK_SIZE } from '#src/types.ts'
import { newId, nowIso } from '#src/lib/id.ts'
import { dayEnd, dayKey, dayStart } from '#src/lib/day.ts'
import { emptyFsrs } from '#src/lib/scheduler.ts'
import { useStore } from '#src/store/useStore.ts'
import {
  countCards,
  deleteCard,
  deleteDeck,
  getCardsByDeck,
  getDecks,
  nextChunk,
  putCard,
  putDeck,
} from '#src/lib/idb.ts'

/**
 * Temporary card entry, carried over from stage 1.
 *
 * Stage 3 replaces this with proper deck and card screens and stage 4 adds file
 * import; until then it is the only way to get cards in, so it stays.
 */

function newCard(deckId: string, chunk: number, front: string, back: string): Card {
  const at = nowIso()
  return {
    id: newId(),
    deckId,
    chunk,
    front,
    back,
    tags: [],
    fsrs: emptyFsrs(new Date(at)),
    createdAt: at,
    updatedAt: at,
  }
}

export default function ManagePage() {
  // Today reads decks from the store, so every mutation here has to tell it.
  const refreshStore = useStore((s) => s.refreshDecks)
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const [decks, setDecks] = useState<Deck[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [deckName, setDeckName] = useState('')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')

  const now = new Date()

  const refreshDecks = useCallback(async () => {
    const list = await getDecks()
    setDecks(list)
    setCounts(Object.fromEntries(await Promise.all(list.map(async (d) => [d.id, await countCards(d.id)]))))
    await refreshStore()
  }, [refreshStore])

  const refreshCards = useCallback(async (deckId: string | null) => {
    setCards(deckId ? await getCardsByDeck(deckId) : [])
  }, [])

  useEffect(() => {
    void refreshDecks()
  }, [refreshDecks])

  useEffect(() => {
    void refreshCards(selected)
  }, [selected, refreshCards])

  async function addDeck() {
    const name = deckName.trim()
    if (!name) return
    const at = nowIso()
    const deck: Deck = { id: newId(), name, createdAt: at, updatedAt: at }
    await putDeck(deck)
    setDeckName('')
    setSelected(deck.id)
    await refreshDecks()
  }

  async function removeDeck(id: string) {
    await deleteDeck(id, nowIso())
    if (selected === id) setSelected(null)
    await refreshDecks()
  }

  async function addCard() {
    if (!selected || !front.trim() || !back.trim()) return
    const chunk = await nextChunk(selected)
    await putCard(newCard(selected, chunk, front.trim(), back.trim()))
    setFront('')
    setBack('')
    await Promise.all([refreshCards(selected), refreshDecks()])
  }

  async function removeCard(id: string) {
    await deleteCard(id, nowIso())
    await Promise.all([refreshCards(selected), refreshDecks()])
  }

  /** Fills a deck past one chunk so chunk assignment can be seen working. */
  async function seed(n: number) {
    if (!selected) return
    for (let i = 0; i < n; i++) {
      const chunk = await nextChunk(selected)
      await putCard(newCard(selected, chunk, `word ${i + 1}`, `meaning ${i + 1}`))
    }
    await Promise.all([refreshCards(selected), refreshDecks()])
  }

  const chunksInUse = [...new Set(cards.map((c) => c.chunk))].sort((a, b) => a - b)

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Manage</h1>
        <p className="text-sm opacity-60">
          Temporary. Stage 3 replaces this with real deck and card screens, and stage 4 adds file
          import — until then this is how cards get in.
        </p>
      </header>

      {/* Minimal settings until stage 5 builds the real screen. The burying
          switches ship off, matching Anki — but a deck of reverse cards needs
          "new" on, so there has to be a way to turn it on. */}
      <section className="space-y-3 rounded-lg border border-black/10 p-4 text-sm">
        <h2 className="font-medium">Settings</h2>

        <div className="space-y-2">
          <p className="text-xs opacity-50">
            Burying holds the other cards of a note until the next day. Anki ships all three
            off; turn on <strong>new</strong> if your deck has reverse cards.
          </p>
          {(
            [
              ['buryNew', 'Bury new siblings'],
              ['buryReviews', 'Bury review siblings'],
              ['buryInterdayLearning', 'Bury interday learning siblings'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings[key]}
                onChange={(e) => void saveSettings({ [key]: e.target.checked })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="flex flex-wrap gap-4 pt-1">
          <label className="flex items-center gap-2">
            <span className="opacity-60">New / day</span>
            <input
              type="number"
              min={0}
              className="w-20 rounded border border-black/20 px-2 py-1"
              value={settings.newPerDay}
              onChange={(e) => void saveSettings({ newPerDay: Math.max(0, Number(e.target.value)) })}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="opacity-60">Reviews / day</span>
            <input
              type="number"
              min={0}
              className="w-20 rounded border border-black/20 px-2 py-1"
              value={settings.reviewsPerDay}
              onChange={(e) =>
                void saveSettings({ reviewsPerDay: Math.max(0, Number(e.target.value)) })
              }
            />
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-black/10 p-4 text-sm space-y-1">
        <h2 className="font-medium">Study day</h2>
        <p>
          Now <code>{now.toLocaleString()}</code>
        </p>
        <p>
          Runs <code>{dayStart(now).toLocaleString()}</code> →{' '}
          <code>{dayEnd(now).toLocaleString()}</code>
        </p>
        <p>
          Review log file <code>reviews/{dayKey(now)}.jsonl</code>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Decks</h2>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded border border-black/20 px-3 py-2"
            placeholder="New deck name"
            value={deckName}
            onChange={(e) => setDeckName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addDeck()}
          />
          <button className="rounded bg-black px-4 py-2 text-white" onClick={() => void addDeck()}>
            Add
          </button>
        </div>

        {decks.length === 0 ? (
          <p className="text-sm opacity-60">No decks yet.</p>
        ) : (
          <ul className="divide-y divide-black/10 rounded border border-black/10">
            {decks.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                <button
                  className={`flex-1 text-left ${selected === d.id ? 'font-medium' : ''}`}
                  onClick={() => setSelected(d.id)}
                >
                  {d.name}
                  <span className="ml-2 text-sm opacity-60">{counts[d.id] ?? 0} cards</span>
                </button>
                <button className="text-sm opacity-60 hover:opacity-100" onClick={() => void removeDeck(d.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <section className="space-y-3">
          <h2 className="font-medium">
            Cards
            {chunksInUse.length > 0 && (
              <span className="ml-2 text-sm font-normal opacity-60">
                chunk{chunksInUse.length > 1 ? 's' : ''} {chunksInUse.join(', ')} · {CHUNK_SIZE} per chunk
              </span>
            )}
          </h2>

          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-black/20 px-3 py-2"
              placeholder="Front"
              value={front}
              onChange={(e) => setFront(e.target.value)}
            />
            <input
              className="flex-1 rounded border border-black/20 px-3 py-2"
              placeholder="Back"
              value={back}
              onChange={(e) => setBack(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addCard()}
            />
            <button className="rounded bg-black px-4 py-2 text-white" onClick={() => void addCard()}>
              Add
            </button>
          </div>

          <div className="flex gap-2 text-sm">
            <button className="rounded border border-black/20 px-3 py-1" onClick={() => void seed(600)}>
              Seed 600 (crosses a chunk)
            </button>
          </div>

          {cards.length === 0 ? (
            <p className="text-sm opacity-60">No cards in this deck.</p>
          ) : (
            <ul className="divide-y divide-black/10 rounded border border-black/10">
              {cards.slice(0, 50).map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="flex-1">
                    {c.front} — {c.back}
                  </span>
                  <span className="opacity-40">#{c.chunk}</span>
                  <button className="opacity-60 hover:opacity-100" onClick={() => void removeCard(c.id)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          {cards.length > 50 && (
            <p className="text-sm opacity-60">
              Showing 50 of {cards.length}. Virtual scrolling arrives in stage 3.
            </p>
          )}
        </section>
      )}
    </div>
  )
}
