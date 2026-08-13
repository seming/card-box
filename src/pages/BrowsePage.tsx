import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Card } from '#src/types.ts'
import { State } from '#src/types.ts'
import { getAllCards, getCardsByDeck, putCard } from '#src/lib/idb.ts'
import { useStore } from '#src/store/useStore.ts'
import { nowIso } from '#src/lib/id.ts'
import { QUICK_FILTERS, search } from '#src/lib/search.ts'
import { bucketOf } from '#src/lib/stats.ts'
import { dayEnd } from '#src/lib/day.ts'
import CardEditor from '#src/components/CardEditor.tsx'

/**
 * The card browser.
 *
 * Rows are virtualized because a deck can be ten thousand cards and this screen
 * is the one that would otherwise try to render all of them. Search runs over
 * the in-memory list — even ten thousand cards is a few megabytes, and an
 * IndexedDB index cannot answer `prop:lapses>=8` anyway.
 */

const BUCKET_LABEL: Record<string, string> = {
  new: 'New',
  learning: 'Learning',
  relearning: 'Relearning',
  young: 'Young',
  mature: 'Mature',
}

const ROW = 60

export default function BrowsePage() {
  const { decks, settings } = useStore()
  const [deckId, setDeckId] = useState('')
  const [query, setQuery] = useState('')
  const [cards, setCards] = useState<Card[] | null>(null)
  const [selected, setSelected] = useState<Card | null>(null)
  const parent = useRef<HTMLDivElement>(null)
  const now = useMemo(() => new Date(), [])

  const load = useCallback(async () => {
    setCards(deckId ? await getCardsByDeck(deckId) : await getAllCards())
  }, [deckId])

  useEffect(() => {
    void load()
  }, [load])

  const deckNames = useMemo(() => new Map(decks.map((d) => [d.id, d.name])), [decks])

  const results = useMemo(() => {
    if (!cards) return []
    // Sorted by front: ids are uuids and a bulk import stamps one createdAt on
    // every card, so the stored order carries no meaning worth preserving.
    return search(cards, query, { now, deckNames }).sort((a, b) =>
      a.front.localeCompare(b.front, undefined, { sensitivity: 'base' }),
    )
  }, [cards, query, now, deckNames])

  const virtual = useVirtualizer({
    count: results.length,
    getScrollElement: () => parent.current,
    estimateSize: () => ROW,
    overscan: 12,
  })

  /** Writes the card and refreshes in place, so the list does not jump. */
  const save = useCallback(async (card: Card) => {
    await putCard(card)
    setCards((prev) => prev?.map((c) => (c.id === card.id ? card : c)) ?? null)
    setSelected((s) => (s && s.id === card.id ? card : s))
  }, [])

  async function toggleSuspend(card: Card) {
    await save({ ...card, suspended: !card.suspended, updatedAt: nowIso() })
  }

  async function buryToday(card: Card) {
    await save({
      ...card,
      buriedUntil: dayEnd(new Date(), settings.dayStartHour).toISOString(),
      updatedAt: nowIso(),
    })
  }

  if (!cards) return <p className="text-sm opacity-50">Loading…</p>

  return (
    <section className="flex flex-1 flex-col gap-3">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Browse</h1>
        <p className="text-sm opacity-60">
          {results.length === cards.length
            ? `${cards.length} cards`
            : `${results.length} of ${cards.length}`}
        </p>
      </header>

      <div className="flex gap-2">
        <select
          className="rounded border border-[var(--line)] px-2 py-2 text-sm"
          value={deckId}
          onChange={(e) => setDeckId(e.target.value)}
        >
          <option value="">All decks</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <input
          className="min-w-0 flex-1 rounded border border-[var(--line)] px-3 py-2 text-sm"
          placeholder="Search — tag:noun  is:due  prop:ivl>=21"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="px-2 text-sm opacity-50" onClick={() => setQuery('')}>
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {QUICK_FILTERS.map((f) => {
          const on = query.includes(f.query)
          return (
            <button
              key={f.label}
              className={`rounded-full px-2.5 py-1 text-xs ${
                on ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-[var(--line)] opacity-70'
              }`}
              onClick={() =>
                setQuery((q) =>
                  on ? q.replace(f.query, '').replace(/\s+/g, ' ').trim() : `${q} ${f.query}`.trim(),
                )
              }
            >
              {f.label}
            </button>
          )
        })}
      </div>

      {results.length === 0 ? (
        <p className="py-10 text-center text-sm opacity-40">
          {cards.length === 0 ? 'No cards yet.' : 'Nothing matches that search.'}
        </p>
      ) : (
        // A definite height, not flex-1: the virtualiser measures its scroll
        // container, and one that grows with its content reports the whole list
        // and renders every row.
        <div
          ref={parent}
          className="overflow-y-auto rounded-lg border border-[var(--line)]"
          style={{ height: 'calc(100dvh - 20rem)', minHeight: 220 }}
        >
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const card = results[item.index]
              const held = card.suspended || (card.buriedUntil ?? '') > now.toISOString()
              return (
                <button
                  key={card.id}
                  className={`absolute left-0 flex w-full items-center gap-3 border-b border-[var(--line)] px-3 text-left ${
                    held ? 'opacity-40' : ''
                  }`}
                  style={{ top: item.start, height: ROW }}
                  onClick={() => setSelected(card)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{card.front}</span>
                    <span className="block truncate text-xs opacity-50">{card.back}</span>
                  </span>
                  <span className="shrink-0 text-xs opacity-40">
                    {card.suspended
                      ? 'suspended'
                      : held
                        ? 'buried'
                        : BUCKET_LABEL[bucketOf(card)]}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {selected && (
        <CardEditor
          card={selected}
          onClose={() => setSelected(null)}
          onSave={save}
          onSuspend={toggleSuspend}
          onBury={buryToday}
          onDeleted={() => {
            setSelected(null)
            void load()
          }}
        />
      )}
    </section>
  )
}

/** Cards never studied, for the empty-search hint. Kept here to avoid a second pass. */
export const isUnseen = (c: Card) => c.fsrs.state === State.New
