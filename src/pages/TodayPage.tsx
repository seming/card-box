import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Card } from '#src/types.ts'
import { queueCounts, nextDue } from '#src/lib/queue.ts'
import type { QueueCounts } from '#src/lib/queue.ts'
import { formatInterval } from '#src/lib/scheduler.ts'
import { useStore } from '#src/store/useStore.ts'

interface Row {
  id: string
  name: string
  counts: QueueCounts
  next: Date | null
}

export default function TodayPage() {
  const { decks, settings, todayLog, loadDeckCards } = useStore()
  const [rows, setRows] = useState<Row[]>([])
  const now = new Date()

  useEffect(() => {
    let cancelled = false
    async function build() {
      const built = await Promise.all(
        decks.map(async (deck) => {
          const cards: Card[] = await loadDeckCards(deck.id)
          const input = { cards, todayLog, settings, now: new Date() }
          return { id: deck.id, name: deck.name, counts: queueCounts(input), next: nextDue(cards, new Date()) }
        }),
      )
      if (!cancelled) setRows(built)
    }
    void build()
    return () => {
      cancelled = true
    }
    // `now` is intentionally excluded — recomputing on every render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decks, todayLog, settings, loadDeckCards])

  const total = rows.reduce((n, r) => n + r.counts.total, 0)
  const unseen = rows.reduce((n, r) => n + r.counts.unseen, 0)
  const newToday = rows.reduce((n, r) => n + r.counts.new, 0)
  /** Only worth mentioning when today's limit will not clear the backlog. */
  const hasBacklog = unseen > newToday

  if (decks.length === 0) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="text-sm opacity-60">
          No cards yet. Start from a bundled German B1 deck, or import your own CSV, TSV or
          Excel file — the sheet, header row and columns are detected for you.
        </p>
        <div className="flex gap-2">
          <Link
            to="/import"
            className="inline-block rounded bg-[var(--accent)] px-4 py-2 text-sm text-[var(--on-accent)]"
          >
            Get a deck
          </Link>
          <Link to="/manage" className="inline-block rounded border border-[var(--line)] px-4 py-2 text-sm">
            Add by hand
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="text-sm opacity-60">
          {total > 0 ? `${total} cards to review` : 'Nothing due right now'}
        </p>
      </header>

      {total > 0 && (
        <Link
          to="/review"
          className="block rounded-lg bg-[var(--accent)] py-4 text-center text-lg font-medium text-[var(--on-accent)]"
        >
          Start reviewing
        </Link>
      )}

      {/* Each deck is its own entry point — tapping one reviews just that deck,
          which is the whole reason the /review/:deckId route exists.

          Every row is a link, including decks with nothing due. An earlier
          version made those inert, which read as a broken tap: the row was
          visibly there and pressing it did nothing at all. The review screen
          already explains an empty queue, so let it. */}
      <ul className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)]">
        {rows.map((row) => {
          const due = row.counts.total > 0
          const capped = row.counts.unseen > 0 && row.counts.new === 0
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{row.name}</span>
                <span className="text-sm tabular-nums">
                  {due ? (
                    <>
                      {row.counts.learning > 0 && (
                        <span className="text-orange-600">{row.counts.learning} learning</span>
                      )}
                      {row.counts.learning > 0 &&
                        (row.counts.review > 0 || row.counts.new > 0) &&
                        ' · '}
                      {row.counts.review > 0 && <span>{row.counts.review} review</span>}
                      {row.counts.review > 0 && row.counts.new > 0 && ' · '}
                      {row.counts.new > 0 && (
                        <span className="text-blue-700">{row.counts.new} new</span>
                      )}
                      <span className="ml-2 opacity-30">›</span>
                    </>
                  ) : capped ? (
                    <span className="opacity-50">done for today ›</span>
                  ) : row.next ? (
                    <span className="opacity-50">next in {formatInterval(+row.next - +now)} ›</span>
                  ) : (
                    <span className="opacity-50">no cards ›</span>
                  )}
                </span>
              </div>
              {row.counts.unseen > row.counts.new && (
                <p className="mt-1 text-xs opacity-50">
                  {capped
                    ? `${row.counts.unseen} still to introduce · daily limit of ${settings.newPerDay} reached`
                    : `${row.counts.unseen} not yet introduced · ${settings.newPerDay}/day → ${Math.ceil(
                        row.counts.unseen / Math.max(1, settings.newPerDay),
                      )} days`}
                </p>
              )}
            </>
          )

          return (
            <li key={row.id}>
              <Link
                to={`/review/${row.id}`}
                className={`block px-4 py-3 active:bg-[var(--line)] ${due ? '' : 'opacity-70'}`}
              >
                {body}
              </Link>
            </li>
          )
        })}
      </ul>

      {/* PRD §7: the backlog must be visible, not discovered months later. */}
      {hasBacklog && (
        <p className="text-xs opacity-50">
          {unseen} cards have never been shown. Raise the daily new limit in settings if that pace is
          too slow.
        </p>
      )}
    </section>
  )
}
