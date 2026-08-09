import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Card } from '#src/types.ts'
import { buildQueue, nextDue } from '#src/lib/queue.ts'
import { answer, formatInterval, preview, GRADES, GRADE_LABEL } from '#src/lib/scheduler.ts'
import type { GradeValue } from '#src/lib/scheduler.ts'
import { getAllCards, getCardsByDeck } from '#src/lib/idb.ts'
import { useStore } from '#src/store/useStore.ts'

/** Colour per rating. Again is the only one that has to stand out. */
const GRADE_STYLE: Record<GradeValue, string> = {
  1: 'bg-red-600',
  2: 'bg-neutral-500',
  3: 'bg-emerald-600',
  4: 'bg-blue-600',
}

export default function ReviewPage() {
  const { deckId } = useParams()
  const { settings, todayLog, recordAnswer } = useStore()

  const [cards, setCards] = useState<Card[] | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [tick, setTick] = useState(0)
  const [done, setDone] = useState(0)
  const shownAt = useRef(new Date())

  // Fixed for the session so the queue does not reshuffle under the reviewer
  // between answers.
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31))

  useEffect(() => {
    void (deckId ? getCardsByDeck(deckId) : getAllCards()).then(setCards)
  }, [deckId])

  const queue = useMemo(() => {
    if (!cards) return []
    return buildQueue({ cards, todayLog, settings, now: new Date(), seed })
    // `tick` forces a rebuild when a learning step comes due.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, todayLog, settings, seed, tick])

  const current = queue[0] ?? null

  // Intervals are frozen at reveal time. Recomputing them on every render would
  // make the numbers drift while the reviewer is reading them.
  const options = useMemo(
    () => (current && revealed ? preview(current, new Date(), settings) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.id, revealed, settings],
  )

  useEffect(() => {
    shownAt.current = new Date()
    setRevealed(false)
  }, [current?.id])

  // With an empty queue a learning card may still be minutes away. Poll so it
  // appears on its own instead of demanding a manual refresh.
  useEffect(() => {
    if (current || !cards) return
    const timer = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(timer)
  }, [current, cards])

  const rate = useCallback(
    async (grade: GradeValue) => {
      if (!current || !revealed) return
      const now = new Date()
      const result = answer(current, grade, now, shownAt.current, settings)
      await recordAnswer(result.card, result.log)
      setCards((prev) => prev?.map((c) => (c.id === result.card.id ? result.card : c)) ?? null)
      setDone((n) => n + 1)
    },
    [current, revealed, settings, recordAnswer],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (!revealed) setRevealed(true)
        return
      }
      const n = Number(e.key)
      if (revealed && n >= 1 && n <= 4) void rate(n as GradeValue)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [revealed, rate])

  if (!cards) return <p className="text-sm opacity-50">Loading…</p>

  if (!current) {
    const next = nextDue(cards, new Date())
    const soon = next && +next > Date.now()
    return (
      <section className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold">
          {done > 0 ? 'Session complete' : 'Nothing due'}
        </h1>
        {done > 0 && <p className="text-sm opacity-60">{done} cards reviewed.</p>}
        {soon && (
          <p className="text-sm opacity-60">Next card in {formatInterval(+next - Date.now())}.</p>
        )}
        <Link to="/" className="inline-block rounded bg-black px-4 py-2 text-sm text-white">
          Back to Today
        </Link>
      </section>
    )
  }

  const remaining = queue.length
  const progress = done + remaining > 0 ? done / (done + remaining) : 0

  return (
    <section className="flex flex-1 flex-col">
      <div className="mb-6 flex items-center gap-3 text-xs opacity-60">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-black/10">
          <div className="h-full bg-black/50 transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
        <span className="tabular-nums">{remaining} left</span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <p className="text-3xl font-medium leading-snug">{current.front}</p>

        {revealed && (
          <div className="w-full space-y-3 border-t border-black/10 pt-6">
            <p className="text-2xl">{current.back}</p>
            {current.example && <p className="text-base opacity-70">{current.example}</p>}
            {current.note && <p className="text-sm opacity-50">{current.note}</p>}
            {current.tags.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                {current.tags.map((t) => (
                  <span key={t} className="rounded-full bg-black/5 px-2 py-0.5 text-xs opacity-60">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Kept low on the screen: this is where a thumb reaches on a phone. */}
      <div className="mt-8">
        {!revealed ? (
          <button
            className="w-full rounded-lg bg-black py-4 text-lg font-medium text-white"
            onClick={() => setRevealed(true)}
          >
            Show answer
          </button>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {GRADES.map((grade) => (
              <button
                key={grade}
                className={`rounded-lg py-3 text-white ${GRADE_STYLE[grade]}`}
                onClick={() => void rate(grade)}
              >
                <span className="block text-sm font-medium">{GRADE_LABEL[grade]}</span>
                {/* The predicted interval is what makes the choice meaningful. */}
                <span className="block text-xs opacity-80 tabular-nums">
                  {options?.[grade].interval}
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="mt-3 hidden text-center text-xs opacity-40 sm:block">
          space to reveal · 1–4 to rate
        </p>
      </div>
    </section>
  )
}
