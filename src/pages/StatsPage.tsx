import { useEffect, useMemo, useState } from 'react'
import type { Card as CardType, ReviewLogEntry } from '#src/types.ts'
import { getAllCards, getCardsByDeck, getReviewsBetween } from '#src/lib/idb.ts'
import { useStore } from '#src/store/useStore.ts'
import { retrievabilityOf } from '#src/lib/scheduler.ts'
import {
  answerButtons,
  calendar,
  cardCounts,
  difficultyHistogram,
  expectedRetained,
  formatDuration,
  futureDue,
  hourlyBreakdown,
  intervalHistogram,
  percent,
  rate,
  retrievabilityHistogram,
  reviewsByDay,
  stabilityHistogram,
  today as todayStats,
  trueRetention,
} from '#src/lib/stats.ts'
import type { Bin } from '#src/lib/stats.ts'
import {
  BUCKET_COLOR,
  Card,
  Columns,
  Empty,
  Heatmap,
  Stat,
  StackedBar,
  Table,
} from '#src/components/charts.tsx'
import type { Series } from '#src/components/charts.tsx'

/**
 * Statistics, following Anki's set. Card Ease is absent on purpose: it measures
 * SM-2's ease factor, and FSRS has no such number — Anki hides it too when FSRS
 * is on. Stability, difficulty and retrievability take its place.
 */

const RANGES = [
  { label: '1 month', days: 30 },
  { label: '3 months', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'All', days: null },
] as const

const REVIEW_SERIES: Series[] = [
  { key: 'learning', label: 'Learning', color: BUCKET_COLOR.learning },
  { key: 'young', label: 'Young', color: BUCKET_COLOR.young },
  { key: 'mature', label: 'Mature', color: BUCKET_COLOR.mature },
  { key: 'relearning', label: 'Relearning', color: BUCKET_COLOR.relearning },
]

const DUE_SERIES: Series[] = [
  { key: 'young', label: 'Young', color: BUCKET_COLOR.young },
  { key: 'mature', label: 'Mature', color: BUCKET_COLOR.mature },
]

const BUTTON_SERIES: Series[] = [
  { key: 'learning', label: 'Learning', color: BUCKET_COLOR.learning },
  { key: 'young', label: 'Young', color: BUCKET_COLOR.young },
  { key: 'mature', label: 'Mature', color: BUCKET_COLOR.mature },
]

const ONE = [{ key: 'v', label: '', color: 'var(--s1)' }]

/** A histogram renders as single-series columns; the cumulative share rides the tooltip. */
function binColumns(bins: Bin[]) {
  // Every other tick: at a dozen-plus bins the labels ("30–59d") collide, and a
  // clipped axis is worse than a sparse one. The tooltip and table carry the rest.
  const sparse = bins.length > 8
  return bins.map((b, i) => ({
    label: b.label,
    axis: !sparse || i % 2 === 0 ? b.label : '',
    values: { v: b.count },
    note: `${percent(b.cumulative)} at or below`,
  }))
}

const binTable = (bins: Bin[], unit: string) => (
  <Table
    head={[unit, 'Cards', 'Cumulative']}
    rows={bins.map((b) => [b.label, b.count, percent(b.cumulative)])}
  />
)

export default function StatsPage() {
  const { decks, settings } = useStore()
  const [deckId, setDeckId] = useState<string>('')
  const [rangeDays, setRangeDays] = useState<number | null>(365)

  const [cards, setCards] = useState<CardType[] | null>(null)
  const [log, setLog] = useState<ReviewLogEntry[] | null>(null)
  const now = useMemo(() => new Date(), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [c, l] = await Promise.all([
        deckId ? getCardsByDeck(deckId) : getAllCards(),
        // Whole history; the range control narrows it below, so switching range
        // never refetches.
        getReviewsBetween('0000', '9999'),
      ])
      if (!cancelled) {
        setCards(c)
        setLog(deckId ? l.filter((e) => e.deckId === deckId) : l)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [deckId])

  const scoped = useMemo(() => {
    if (!log) return []
    if (rangeDays === null) return log
    const from = new Date(now)
    from.setDate(from.getDate() - rangeDays)
    const iso = from.toISOString()
    return log.filter((e) => e.review >= iso)
  }, [log, rangeDays, now])

  const probability = useMemo(() => retrievabilityOf(settings, now), [settings, now])

  if (!cards || !log) return <p className="text-sm opacity-50">Loading…</p>

  const t = todayStats(log, now, settings)
  const retention = trueRetention(scoped, now, settings)
  const counts = cardCounts(cards)
  const due = futureDue(cards, now, settings, 30)
  const daily = reviewsByDay(scoped, now, settings, Math.min(rangeDays ?? 90, 90))
  const heat = new Map(calendar(scoped, settings).map((d) => [d.date, d.count]))
  const hours = hourlyBreakdown(scoped)
  const buttons = answerButtons(scoped)
  const intervals = intervalHistogram(cards)
  const stability = stabilityHistogram(cards)
  const difficulty = difficultyHistogram(cards)
  const retrievability = retrievabilityHistogram(cards, probability)
  const retained = expectedRetained(cards, probability)

  const backlog = due[0].young + due[0].mature
  const dueTotal = due.reduce((s, d) => s + d.young + d.mature, 0)

  return (
    <section className="space-y-4 pb-4">
      <h1 className="text-2xl font-semibold">Statistics</h1>

      {/* One filter row above everything it scopes — never per chart. */}
      <div className="flex flex-wrap gap-2 text-sm">
        <select
          className="rounded border border-[var(--line)] px-2 py-1.5 dark:border-white/20"
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
        <div className="flex overflow-hidden rounded border border-[var(--line)]">
          {RANGES.map((r) => (
            <button
              key={r.label}
              className={`px-2.5 py-1.5 text-xs ${
                rangeDays === r.days ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'opacity-60'
              }`}
              onClick={() => setRangeDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {log.length === 0 && (
        <p className="rounded-lg border border-[var(--line)] p-4 text-sm opacity-60 dark:border-white/10">
          Nothing studied yet. These fill in as you review — retention needs a couple of weeks
          before it means anything.
        </p>
      )}

      {/* Today: headline numbers, so stat tiles rather than a chart. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Studied today" value={String(t.answers)} sub={`${t.newCards} new · ${t.reviews} review`} />
        <Stat label="Time today" value={formatDuration(t.seconds)} sub={t.answers ? `${formatDuration(t.seconds / t.answers)} per card` : undefined} />
        <Stat label="Again today" value={String(t.again)} sub={t.answers ? percent(t.again / t.answers) + ' of answers' : undefined} />
        <Stat label="Pass rate today" value={percent(t.passRate)} sub="not Again" />
      </div>

      <Card
        title="True retention"
        hint="How often a scheduled interval held. Learning answers are excluded — they have no interval to test."
      >
        <Table
          head={['Period', 'Young', 'Mature', 'All', 'Reviews']}
          rows={retention.map((r) => [
            r.label,
            percent(rate(r.young)),
            percent(rate(r.mature)),
            percent(rate(r.all)),
            r.all.total,
          ])}
        />
      </Card>

      <Card
        title="Future due"
        hint={`${backlog} due now · ${dueTotal} over 30 days · ${(dueTotal / 30).toFixed(1)} a day on average`}
        table={
          <Table
            head={['Day', 'Young', 'Mature', 'Cumulative']}
            rows={due.map((d) => [d.offset === 0 ? 'Today' : `+${d.offset}d`, d.young, d.mature, d.cumulative])}
          />
        }
      >
        <Columns
          data={due.map((d) => ({
            label: d.offset === 0 ? 'Today' : `In ${d.offset} day${d.offset === 1 ? '' : 's'}`,
            axis: d.offset % 5 === 0 ? String(d.offset) : '',
            values: { young: d.young, mature: d.mature },
            note: `${d.cumulative} cumulative`,
          }))}
          series={DUE_SERIES}
        />
      </Card>

      <Card title="Calendar" hint="Answers per day">
        {scoped.length ? <Heatmap days={heat} today={now} /> : <Empty>No reviews yet.</Empty>}
      </Card>

      <Card
        title="Reviews"
        hint="Answers per day, by the card's maturity going in"
        table={
          <Table
            head={['Date', 'Learning', 'Young', 'Mature', 'Relearning', 'Total']}
            rows={daily.map((d) => [d.date, d.learning, d.young, d.mature, d.relearning, d.total])}
          />
        }
      >
        <Columns
          data={daily.map((d) => ({
            label: d.date,
            axis: '',
            values: { learning: d.learning, young: d.young, mature: d.mature, relearning: d.relearning },
          }))}
          series={REVIEW_SERIES}
        />
      </Card>

      <Card
        title="Review time"
        hint="Minutes per day"
        table={
          <Table
            head={['Date', 'Time', 'Cards']}
            rows={daily.map((d) => [d.date, formatDuration(d.seconds), d.total])}
          />
        }
      >
        <Columns
          data={daily.map((d) => ({ label: d.date, axis: '', values: { v: d.seconds / 60 } }))}
          series={ONE}
          format={(v) => `${Math.round(v)}m`}
        />
      </Card>

      <Card
        title="Card counts"
        hint={`${counts.total} cards`}
        table={
          <Table
            head={['Bucket', 'Cards']}
            rows={[
              ['New', counts.new],
              ['Learning', counts.learning],
              ['Relearning', counts.relearning],
              ['Young', counts.young],
              ['Mature', counts.mature],
              ['Suspended', counts.suspended],
            ]}
          />
        }
      >
        <StackedBar
          parts={[
            { key: 'new', label: 'New', color: BUCKET_COLOR.new, value: counts.new },
            { key: 'learning', label: 'Learning', color: BUCKET_COLOR.learning, value: counts.learning },
            { key: 'relearning', label: 'Relearning', color: BUCKET_COLOR.relearning, value: counts.relearning },
            { key: 'young', label: 'Young', color: BUCKET_COLOR.young, value: counts.young },
            { key: 'mature', label: 'Mature', color: BUCKET_COLOR.mature, value: counts.mature },
            { key: 'suspended', label: 'Suspended', color: 'var(--axis)', value: counts.suspended },
          ]}
        />
      </Card>

      <Card
        title="Answer buttons"
        hint="Which button, split by the card's maturity"
        table={
          <Table
            head={['Button', 'Learning', 'Young', 'Mature', 'Total']}
            rows={buttons.map((b) => [b.label, b.learning, b.young, b.mature, b.total])}
          />
        }
      >
        <Columns
          data={buttons.map((b) => ({
            label: b.label,
            values: { learning: b.learning, young: b.young, mature: b.mature },
          }))}
          series={BUTTON_SERIES}
        />
      </Card>

      {/* Anki draws count and pass rate on one plot with two y-axes. Two scales on
          one frame invent a relationship, so these are two charts. */}
      <Card
        title="Hourly breakdown"
        hint="When you study"
        table={
          <Table
            head={['Hour', 'Answers', 'Pass rate']}
            rows={hours.map((h) => [`${h.hour}:00`, h.count, percent(h.passRate)])}
          />
        }
      >
        <Columns
          data={hours.map((h) => ({ label: `${h.hour}:00`, axis: h.hour % 3 === 0 ? String(h.hour) : '', values: { v: h.count } }))}
          series={ONE}
        />
      </Card>

      <Card title="Hourly pass rate" hint="Share not Again, by hour">
        <Columns
          data={hours.map((h) => ({
            label: `${h.hour}:00`,
            axis: h.hour % 3 === 0 ? String(h.hour) : '',
            values: { v: (h.passRate ?? 0) * 100 },
            note: `${h.count} answers`,
          }))}
          series={ONE}
          format={(v) => `${Math.round(v)}%`}
        />
      </Card>

      <Card title="Review intervals" hint="Current interval per card" table={binTable(intervals, 'Interval')}>
        <Columns data={binColumns(intervals)} series={ONE} />
      </Card>

      <Card
        title="Card stability"
        hint="Days for recall probability to fall to 90%"
        table={binTable(stability, 'Stability')}
      >
        <Columns data={binColumns(stability)} series={ONE} />
      </Card>

      <Card
        title="Card difficulty"
        hint="1–10. Higher means intervals grow more slowly."
        table={binTable(difficulty, 'Difficulty')}
      >
        <Columns data={binColumns(difficulty)} series={ONE} />
      </Card>

      <Card
        title="Card retrievability"
        hint={`Chance of recall right now · about ${Math.round(retained)} of ${counts.total - counts.new} still remembered`}
        table={binTable(retrievability, 'Retrievability')}
      >
        <Columns data={binColumns(retrievability)} series={ONE} />
      </Card>

      <p className="text-xs opacity-40">
        Card Ease is not shown: it measures SM-2's ease factor, which FSRS does not have.
        Stability, difficulty and retrievability replace it.
      </p>
    </section>
  )
}
