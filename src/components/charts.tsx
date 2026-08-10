import { useId, useState } from 'react'

/**
 * Chart primitives.
 *
 * Plain SVG, no library. The specs are fixed rather than per-chart: bars cap at
 * 24px and never fill their band, data-ends are 4px rounded and square at the
 * baseline, touching marks are separated by a 2px gap in the surface colour
 * rather than a stroke, and grid lines are solid hairlines one step off the
 * surface.
 *
 * Colours come from CSS custom properties defined once in `index.css`, so light
 * and dark swap in one place and nothing here carries a hex.
 */

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'] as const

/** Card buckets keep one colour each, everywhere, so identity never moves. */
export const BUCKET_COLOR = {
  new: 'var(--s1)',
  learning: 'var(--s2)',
  young: 'var(--s3)',
  mature: 'var(--s4)',
  relearning: 'var(--s5)',
} as const

const GAP = 2
const MAX_BAR = 24
const PAD = { top: 8, right: 8, bottom: 22, left: 34 }

export interface Series {
  key: string
  label: string
  color: string
}

/* ── shared chrome ──────────────────────────────────────────────────────── */

export function Card({
  title,
  hint,
  children,
  table,
}: {
  title: string
  hint?: string
  children: React.ReactNode
  /** Every chart ships a table twin — values are never gated behind a tooltip. */
  table?: React.ReactNode
}) {
  const [showTable, setShowTable] = useState(false)
  return (
    <section className="rounded-lg border border-[var(--line)] p-4 dark:border-white/10">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="font-medium">{title}</h2>
          {hint && <p className="text-xs opacity-50">{hint}</p>}
        </div>
        {table && (
          <button
            className="shrink-0 text-xs underline underline-offset-2 opacity-50 hover:opacity-100"
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
        )}
      </header>
      {showTable && table ? <div className="overflow-x-auto text-sm">{table}</div> : children}
    </section>
  )
}

/** Identity channel that never depends on colour matching alone. */
export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: s.color }}
          />
          {/* Text wears ink, never the series colour. */}
          <span className="opacity-70">{s.label}</span>
        </li>
      ))}
    </ul>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm opacity-40">{children}</p>
}

function Grid({ w, ticks }: { w: number; ticks: { y: number; label: string }[] }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t.label}>
          <line
            x1={PAD.left}
            x2={w - PAD.right}
            y1={t.y}
            y2={t.y}
            stroke="var(--grid)"
            strokeWidth={1}
          />
          <text x={PAD.left - 6} y={t.y + 3.5} textAnchor="end" className="fill-[var(--muted)] text-[10px] tabular-nums">
            {t.label}
          </text>
        </g>
      ))}
    </g>
  )
}

function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [0]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10
  const out: number[] = []
  for (let v = 0; v <= max + step / 2; v += step) out.push(v)
  return out
}

/* ── stacked / grouped columns ──────────────────────────────────────────── */

export interface ColumnDatum {
  label: string
  /** Optional shorter label for the axis; the full one still reaches the tooltip. */
  axis?: string
  values: Record<string, number>
  note?: string
}

/**
 * Stacked columns. Also covers the single-series case, where the legend is
 * dropped because the title already names what is plotted.
 */
export function Columns({
  data,
  series,
  height = 150,
  format = (v: number) => String(Math.round(v)),
  axisEvery = 1,
}: {
  data: ColumnDatum[]
  series: Series[]
  height?: number
  format?: (v: number) => string
  axisEvery?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const clip = useId()
  const w = 640
  const plot = height - PAD.top - PAD.bottom
  const max = Math.max(1, ...data.map((d) => series.reduce((s, k) => s + (d.values[k.key] ?? 0), 0)))
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1]
  const band = (w - PAD.left - PAD.right) / Math.max(1, data.length)
  const barW = Math.min(MAX_BAR, band * 0.7)

  if (data.every((d) => series.every((s) => !d.values[s.key]))) {
    return <Empty>No data yet.</Empty>
  }

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }} role="img">
        <defs>
          <clipPath id={clip}>
            <rect x={PAD.left} y={PAD.top} width={w - PAD.left - PAD.right} height={plot} />
          </clipPath>
        </defs>
        <Grid
          w={w}
          ticks={ticks.map((v) => ({ y: PAD.top + plot - (v / top) * plot, label: format(v) }))}
        />

        {data.map((d, i) => {
          const x = PAD.left + band * i + (band - barW) / 2
          let y = PAD.top + plot
          return (
            <g key={d.label} clipPath={`url(#${clip})`}>
              {series.map((s) => {
                const v = d.values[s.key] ?? 0
                if (!v) return null
                const h = (v / top) * plot
                y -= h
                return (
                  <rect
                    key={s.key}
                    x={x}
                    // The 2px surface gap lives inside the segment, so touching
                    // fills separate without a stroke.
                    y={y + GAP / 2}
                    width={barW}
                    height={Math.max(0, h - GAP)}
                    rx={3}
                    fill={s.color}
                  />
                )
              })}
            </g>
          )
        })}

        {/* Hit targets span the whole band, well past the 24px mark. */}
        {data.map((d, i) => (
          <rect
            key={d.label}
            x={PAD.left + band * i}
            y={PAD.top}
            width={band}
            height={plot}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {hover !== null && (
          <rect
            x={PAD.left + band * hover}
            y={PAD.top}
            width={band}
            height={plot}
            fill="var(--text)"
            opacity={0.05}
            pointerEvents="none"
          />
        )}

        <line
          x1={PAD.left}
          x2={w - PAD.right}
          y1={PAD.top + plot}
          y2={PAD.top + plot}
          stroke="var(--axis)"
          strokeWidth={1}
        />
        {data.map((d, i) =>
          i % axisEvery === 0 ? (
            <text
              key={d.label}
              x={PAD.left + band * i + band / 2}
              y={height - 7}
              textAnchor="middle"
              className="fill-[var(--muted)] text-[10px]"
            >
              {d.axis ?? d.label}
            </text>
          ) : null,
        )}
      </svg>

      {hover !== null && <Tooltip datum={data[hover]} series={series} format={format} />}
      <Legend series={series} />
    </div>
  )
}

function Tooltip({
  datum,
  series,
  format,
}: {
  datum: ColumnDatum
  series: Series[]
  format: (v: number) => string
}) {
  const total = series.reduce((s, k) => s + (datum.values[k.key] ?? 0), 0)
  return (
    <div className="pointer-events-none absolute right-0 top-0 rounded border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-sm dark:border-white/10">
      <div className="font-medium">{datum.label}</div>
      {series
        .filter((s) => datum.values[s.key])
        .map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            <span className="opacity-60">{s.label}</span>
            <span className="ml-auto tabular-nums">{format(datum.values[s.key])}</span>
          </div>
        ))}
      {series.length > 1 && (
        <div className="mt-0.5 border-t border-[var(--line)] pt-0.5 tabular-nums dark:border-white/10">
          {format(total)} total
        </div>
      )}
      {datum.note && <div className="mt-0.5 opacity-50">{datum.note}</div>}
    </div>
  )
}

/* ── horizontal stacked bar (part-to-whole) ─────────────────────────────── */

export function StackedBar({
  parts,
}: {
  parts: { key: string; label: string; color: string; value: number }[]
}) {
  const total = parts.reduce((s, p) => s + p.value, 0)
  if (!total) return <Empty>No cards yet.</Empty>

  return (
    <div>
      <div className="flex h-6 w-full overflow-hidden rounded" style={{ gap: GAP }}>
        {parts
          .filter((p) => p.value)
          .map((p) => (
            <div
              key={p.key}
              title={`${p.label}: ${p.value}`}
              style={{ background: p.color, flexGrow: p.value }}
            />
          ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: p.color }}
            />
            <span className="opacity-70">{p.label}</span>
            <span className="ml-auto tabular-nums">{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ── calendar heatmap ───────────────────────────────────────────────────── */

/** Sequential blue, light → dark. One hue; magnitude is lightness. */
const HEAT = [
  'var(--heat-0)',
  'var(--heat-1)',
  'var(--heat-2)',
  'var(--heat-3)',
  'var(--heat-4)',
]

export function Heatmap({
  days,
  weeks = 26,
  today,
}: {
  days: Map<string, number>
  weeks?: number
  today: Date
}) {
  const max = Math.max(1, ...days.values())
  const cells: { date: string; count: number; col: number; row: number }[] = []

  // Right-aligned on today, walking back week by week.
  const end = new Date(today)
  end.setHours(12, 0, 0, 0)
  end.setDate(end.getDate() + (6 - end.getDay()))

  for (let i = weeks * 7 - 1; i >= 0; i--) {
    const d = new Date(end)
    d.setDate(d.getDate() - i)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const idx = weeks * 7 - 1 - i
    cells.push({ date, count: days.get(date) ?? 0, col: Math.floor(idx / 7), row: idx % 7 })
  }

  const size = 10
  const step = size + 3
  const w = weeks * step
  const h = 7 * step

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: Math.max(320, w), height: h }} role="img">
        {cells.map((c) => (
          <rect
            key={c.date}
            x={c.col * step}
            y={c.row * step}
            width={size}
            height={size}
            rx={2}
            fill={c.count === 0 ? HEAT[0] : HEAT[Math.min(4, 1 + Math.floor((c.count / max) * 3.99))]}
          >
            <title>{`${c.date} — ${c.count} card${c.count === 1 ? '' : 's'}`}</title>
          </rect>
        ))}
      </svg>
      <div className="mt-2 flex items-center gap-1.5 text-xs opacity-50">
        <span>Less</span>
        {HEAT.map((c) => (
          <span key={c} className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} />
        ))}
        <span>More</span>
        <span className="ml-auto tabular-nums">peak {max}/day</span>
      </div>
    </div>
  )
}

/* ── table twin ─────────────────────────────────────────────────────────── */

export function Table({
  head,
  rows,
}: {
  head: string[]
  rows: (string | number)[][]
}) {
  return (
    <table className="w-full text-left">
      <thead className="text-xs opacity-60">
        <tr>
          {head.map((h, i) => (
            <th key={h} className={`py-1 ${i ? 'text-right' : ''}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--line)]">
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((cell, j) => (
              <td key={j} className={`py-1 ${j ? 'text-right tabular-nums' : ''}`}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* ── stat tile ──────────────────────────────────────────────────────────── */

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-[var(--line)] p-3 dark:border-white/10">
      <div className="text-xs opacity-60">{label}</div>
      {/* Proportional figures: tabular-nums makes a big number look loose. */}
      <div className="mt-0.5 text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs opacity-50">{sub}</div>}
    </div>
  )
}
