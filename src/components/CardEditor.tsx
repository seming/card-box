import { useEffect, useState } from 'react'
import type { Card } from '#src/types.ts'
import { nowIso } from '#src/lib/id.ts'
import { deleteCard } from '#src/lib/idb.ts'
import { formatInterval } from '#src/lib/scheduler.ts'
import { bucketOf } from '#src/lib/stats.ts'

/**
 * Editing one card, as a sheet over whatever opened it.
 *
 * The same component serves the browser and the review screen, because "I can
 * see the mistake but not fix it" is the same problem in both places.
 */

export default function CardEditor({
  card,
  onClose,
  onSave,
  onSuspend,
  onBury,
  onDeleted,
}: {
  card: Card
  onClose: () => void
  onSave: (card: Card) => Promise<void>
  onSuspend: (card: Card) => Promise<void>
  onBury: (card: Card) => Promise<void>
  onDeleted: () => void
}) {
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)
  const [example, setExample] = useState(card.example ?? '')
  const [note, setNote] = useState(card.note ?? '')
  const [tags, setTags] = useState(card.tags.join(' '))
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Reset when a different card opens in the same sheet.
  useEffect(() => {
    setFront(card.front)
    setBack(card.back)
    setExample(card.example ?? '')
    setNote(card.note ?? '')
    setTags(card.tags.join(' '))
    setConfirmDelete(false)
  }, [card.id, card.front, card.back, card.example, card.note, card.tags])

  const dirty =
    front !== card.front ||
    back !== card.back ||
    example !== (card.example ?? '') ||
    note !== (card.note ?? '') ||
    tags !== card.tags.join(' ')

  async function save() {
    if (!front.trim() || !back.trim()) return
    await onSave({
      ...card,
      front: front.trim(),
      back: back.trim(),
      example: example.trim() || undefined,
      note: note.trim() || undefined,
      tags: tags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean),
      updatedAt: nowIso(),
    })
    onClose()
  }

  const buried = (card.buriedUntil ?? '') > new Date().toISOString()
  const due = new Date(card.fsrs.due)
  const ahead = +due - Date.now()

  return (
    <div className="fixed inset-0 z-10 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="max-h-[88dvh] overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-5"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Edit card</h2>
          <button className="text-sm opacity-50" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="space-y-3 text-sm">
          {(
            [
              ['Front', front, setFront, true],
              ['Back', back, setBack, true],
              ['Example', example, setExample, false],
              ['Note', note, setNote, false],
              ['Tags', tags, setTags, false],
            ] as const
          ).map(([label, value, set, required]) => (
            <label key={label} className="block space-y-1">
              <span className="opacity-60">
                {label}
                {required && <span className="text-red-600"> *</span>}
              </span>
              <input
                className="w-full rounded border border-[var(--line)] px-3 py-2"
                value={value}
                onChange={(e) => set(e.target.value)}
                placeholder={label === 'Tags' ? 'space separated' : undefined}
              />
            </label>
          ))}
        </div>

        {/* What the scheduler currently thinks, so an edit is made with eyes open. */}
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-[var(--line)] p-3 text-xs">
          {(
            [
              ['State', card.suspended ? 'Suspended' : buried ? 'Buried' : bucketOf(card)],
              ['Due', ahead > 0 ? `in ${formatInterval(ahead)}` : 'now'],
              ['Interval', `${card.fsrs.scheduled_days}d`],
              ['Reviews', String(card.fsrs.reps)],
              ['Lapses', String(card.fsrs.lapses)],
              ['Difficulty', card.fsrs.difficulty.toFixed(1)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="opacity-50">{k}</dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 flex flex-wrap gap-2 text-sm">
          <button
            className="rounded bg-[var(--accent)] px-4 py-2 text-[var(--on-accent)] disabled:opacity-30"
            disabled={!dirty || !front.trim() || !back.trim()}
            onClick={() => void save()}
          >
            Save
          </button>
          <button
            className="rounded border border-[var(--line)] px-3 py-2"
            onClick={() => void onSuspend(card)}
          >
            {card.suspended ? 'Unsuspend' : 'Suspend'}
          </button>
          {!card.suspended && !buried && (
            <button
              className="rounded border border-[var(--line)] px-3 py-2"
              onClick={() => void onBury(card)}
            >
              Bury till tomorrow
            </button>
          )}
          <button
            className="ml-auto rounded px-3 py-2 text-red-600"
            onClick={() => {
              if (!confirmDelete) return setConfirmDelete(true)
              void deleteCard(card.id, nowIso()).then(onDeleted)
            }}
          >
            {confirmDelete ? 'Really delete?' : 'Delete'}
          </button>
        </div>

        <p className="mt-3 text-xs opacity-40">
          Suspending takes a card out until you put it back. Burying only hides it for the rest of
          today. Neither loses its scheduling.
        </p>
      </div>
    </div>
  )
}
