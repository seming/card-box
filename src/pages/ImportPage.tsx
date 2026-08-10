import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Card, Deck } from '#src/types.ts'
import { CHUNK_SIZE } from '#src/types.ts'
import { newId, nowIso } from '#src/lib/id.ts'
import { emptyFsrs } from '#src/lib/scheduler.ts'
import { detectDelimiter, guessHeaderRow, parseCsv, squareUp } from '#src/lib/csv.ts'
import type { Delimiter } from '#src/lib/csv.ts'
import { looksLikeXlsx, readXlsx } from '#src/lib/xlsx.ts'
import type { Sheet } from '#src/lib/xlsx.ts'
import { buildCards, dedupeKey, guessMapping, headerLabels } from '#src/lib/import.ts'
import type { ColumnMapping, DuplicateMode } from '#src/lib/import.ts'
import { getCardsByDeck, nextChunk, putCards, putDeck } from '#src/lib/idb.ts'
import { useStore } from '#src/store/useStore.ts'
import { SAMPLE_DECKS, fetchSample } from '#src/lib/samples.ts'
import type { SampleDeck } from '#src/lib/samples.ts'

/**
 * Import: file or paste → choose sheet and header → map columns → preview → go.
 *
 * The three choices at the top exist because real files need them. The workbook
 * this was built for has four sheets, only two of which hold cards, and two
 * decorative title rows above the actual header.
 */

type Source = { kind: 'sheets'; sheets: Sheet[] } | { kind: 'rows'; rows: string[][] } | null

const FIELDS = [
  { key: 'front', label: 'Front', required: true },
  { key: 'back', label: 'Back', required: true },
  { key: 'example', label: 'Example', required: false },
  { key: 'note', label: 'Note', required: false },
] as const

export default function ImportPage() {
  const navigate = useNavigate()
  const { decks, refreshDecks, settings, saveSettings } = useStore()
  const fileInput = useRef<HTMLInputElement>(null)

  const [source, setSource] = useState<Source>(null)
  const [fileName, setFileName] = useState('')
  const [sheetIndex, setSheetIndex] = useState(0)
  const [headerRow, setHeaderRow] = useState(0)
  const [delimiter, setDelimiter] = useState<Delimiter>(',')
  const [pasted, setPasted] = useState('')

  const [mapping, setMapping] = useState<ColumnMapping>({
    front: null,
    back: null,
    example: null,
    note: null,
    tags: [],
  })
  const [reverse, setReverse] = useState(true)
  const [duplicates, setDuplicates] = useState<DuplicateMode>('skip')
  const [lang, setLang] = useState('')
  const [deckChoice, setDeckChoice] = useState('__new__')
  const [deckName, setDeckName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const rows = useMemo(() => {
    if (!source) return []
    return source.kind === 'sheets' ? (source.sheets[sheetIndex]?.rows ?? []) : source.rows
  }, [source, sheetIndex])

  const width = useMemo(() => rows.reduce((n, r) => Math.max(n, r.length), 0), [rows])
  const square = useMemo(() => squareUp(rows, width), [rows, width])
  const headers = useMemo(
    () => headerLabels(square[headerRow] ?? [], width),
    [square, headerRow, width],
  )
  const body = useMemo(() => square.slice(headerRow + 1), [square, headerRow])

  /** Re-guesses the header row and mapping whenever the underlying table changes. */
  function adopt(next: Source, nextSheet = 0) {
    const table =
      next?.kind === 'sheets' ? (next.sheets[nextSheet]?.rows ?? []) : (next?.rows ?? [])
    const w = table.reduce((n, r) => Math.max(n, r.length), 0)
    const guessedHeader = guessHeaderRow(table)
    const labels = headerLabels(squareUp(table, w)[guessedHeader] ?? [], w)
    setSource(next)
    setSheetIndex(nextSheet)
    setHeaderRow(guessedHeader)
    setMapping(guessMapping(labels))
    setError('')
  }

  async function onFile(file: File) {
    setFileName(file.name)
    try {
      const buffer = new Uint8Array(await file.arrayBuffer())
      if (looksLikeXlsx(buffer)) {
        const sheets = readXlsx(buffer)
        if (sheets.length === 0) throw new Error('No sheets found in that workbook.')
        // Land on the sheet that looks most like a card table.
        const best = sheets.reduce(
          (bestIndex, sheet, i) => (sheet.rows.length > sheets[bestIndex].rows.length ? i : bestIndex),
          0,
        )
        adopt({ kind: 'sheets', sheets }, best)
      } else {
        const text = new TextDecoder().decode(buffer)
        const d = detectDelimiter(text)
        setDelimiter(d)
        adopt({ kind: 'rows', rows: parseCsv(text, d) })
      }
    } catch (e) {
      setSource(null)
      setError(e instanceof Error ? e.message : 'Could not read that file.')
    }
  }

  async function loadSample(deck: SampleDeck) {
    try {
      const text = await fetchSample(deck)
      setFileName(deck.name)
      setPasted('')
      const d = detectDelimiter(text)
      setDelimiter(d)
      // Same path a chosen file takes, so the preview and the count on the
      // button are the real ones — then the known column layout is applied.
      adopt({ kind: 'rows', rows: parseCsv(text, d) })
      setMapping(deck.mapping)
      setLang(deck.lang)
      setReverse(deck.reverse)
      setDeckName(deck.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that deck.')
    }
  }

  function onPaste(text: string) {
    setPasted(text)
    setFileName('')
    if (!text.trim()) {
      setSource(null)
      return
    }
    const d = detectDelimiter(text)
    setDelimiter(d)
    adopt({ kind: 'rows', rows: parseCsv(text, d) })
  }

  function setField(field: (typeof FIELDS)[number]['key'], value: number | null) {
    setMapping((m) => ({ ...m, [field]: value }))
  }

  function toggleTag(index: number) {
    setMapping((m) => ({
      ...m,
      tags: m.tags.includes(index) ? m.tags.filter((i) => i !== index) : [...m.tags, index],
    }))
  }

  const ready = mapping.front !== null && mapping.back !== null && body.length > 0
  const targetDeck = decks.find((d) => d.id === deckChoice)

  // Dry run against the current settings so the numbers on the button are the
  // numbers that will actually be written.
  const dryRun = useMemo(() => {
    if (!ready) return null
    return buildCards(
      body,
      { mapping, reverse, duplicates, lang: lang.trim() || undefined },
      { deckId: 'preview', newId: () => 'x', now: nowIso(), emptyFsrs: () => emptyFsrs(new Date()) },
    )
  }, [ready, body, mapping, reverse, duplicates, lang])

  async function run() {
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      const at = nowIso()
      let deck: Deck | undefined = targetDeck
      if (!deck) {
        const name = deckName.trim() || fileName.replace(/\.[^.]+$/, '') || 'Imported deck'
        deck = { id: newId(), name, createdAt: at, updatedAt: at }
        await putDeck(deck)
      }

      // Existing fronts, so a re-import updates rather than doubling the deck.
      const current: Card[] = await getCardsByDeck(deck.id)
      const existing = new Map(current.map((c) => [dedupeKey(c.front), c]))
      const startChunk = await nextChunk(deck.id)
      const startChunkCount = current.filter((c) => c.chunk === startChunk).length

      const result = buildCards(
        body,
        { mapping, reverse, duplicates, lang: lang.trim() || undefined },
        {
          deckId: deck.id,
          newId,
          now: at,
          emptyFsrs: () => emptyFsrs(new Date(at)),
          existing,
          startChunk,
          startChunkCount,
        },
      )

      // Overwrites reuse the existing card's id so the row is replaced, not doubled.
      const cards = result.cards.map((card) => {
        if (duplicates !== 'overwrite' || card.tags.includes('reverse')) return card
        const prior = existing.get(dedupeKey(card.front))
        return prior ? { ...card, id: prior.id, chunk: prior.chunk, createdAt: prior.createdAt } : card
      })

      await putCards(cards)
      await refreshDecks()
      navigate('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-6 pb-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Import</h1>
        <p className="text-sm opacity-60">CSV, TSV or Excel (.xlsx).</p>
      </header>

      <div className="space-y-2">
        <h2 className="text-sm font-medium">Start from a bundled deck</h2>
        {SAMPLE_DECKS.map((deck) => (
          <button
            key={deck.id}
            className="w-full rounded-lg border border-[var(--line)] p-3 text-left"
            onClick={() => void loadSample(deck)}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{deck.name}</span>
              <span className="shrink-0 text-xs opacity-50">{deck.cards} entries</span>
            </span>
            <span className="mt-0.5 block text-xs opacity-60">{deck.description}</span>
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium">Or bring your own</h2>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,.xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
          }}
        />
        <button
          className="w-full rounded-lg border border-[var(--line)] py-3 text-sm"
          onClick={() => fileInput.current?.click()}
        >
          {fileName || 'Choose a file'}
        </button>

        <details className="text-sm">
          <summary className="cursor-pointer opacity-60">or paste rows</summary>
          <textarea
            className="mt-2 h-28 w-full rounded border border-[var(--line)] p-2 font-mono text-xs"
            placeholder={'front\tback\ndas Skigebiet\t스키장'}
            value={pasted}
            onChange={(e) => onPaste(e.target.value)}
          />
        </details>
      </div>

      {error && <p className="rounded bg-[var(--line)] p-3 text-sm">{error}</p>}

      {source && (
        <>
          {source.kind === 'sheets' && (
            <label className="block space-y-1 text-sm">
              <span className="opacity-60">Sheet</span>
              <select
                className="w-full rounded border border-[var(--line)] px-2 py-2"
                value={sheetIndex}
                onChange={(e) => adopt(source, Number(e.target.value))}
              >
                {source.sheets.map((s, i) => (
                  <option key={s.name} value={i}>
                    {s.name} ({Math.max(0, s.rows.length - 1)} rows)
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="space-y-1">
              <span className="opacity-60">Header row</span>
              <select
                className="w-full rounded border border-[var(--line)] px-2 py-2"
                value={headerRow}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setHeaderRow(next)
                  setMapping(guessMapping(headerLabels(square[next] ?? [], width)))
                }}
              >
                {square.slice(0, 10).map((r, i) => (
                  <option key={i} value={i}>
                    Row {i + 1}: {r.filter(Boolean).slice(0, 3).join(' · ').slice(0, 40) || '(empty)'}
                  </option>
                ))}
              </select>
            </label>

            {source.kind === 'rows' && (
              <label className="space-y-1">
                <span className="opacity-60">Delimiter</span>
                <select
                  className="w-full rounded border border-[var(--line)] px-2 py-2"
                  value={delimiter}
                  onChange={(e) => {
                    const d = e.target.value as Delimiter
                    setDelimiter(d)
                    adopt({ kind: 'rows', rows: parseCsv(pasted || '', d) })
                  }}
                  disabled={!pasted}
                >
                  <option value=",">Comma</option>
                  <option value="&#9;">Tab</option>
                  <option value=";">Semicolon</option>
                </select>
              </label>
            )}
          </div>

          <div className="space-y-3">
            <h2 className="text-sm font-medium">Columns</h2>
            {FIELDS.map((field) => (
              <label key={field.key} className="flex items-center gap-3 text-sm">
                <span className="w-20 shrink-0 opacity-60">
                  {field.label}
                  {field.required && <span className="text-red-600"> *</span>}
                </span>
                <select
                  className="flex-1 rounded border border-[var(--line)] px-2 py-2"
                  value={mapping[field.key] ?? ''}
                  onChange={(e) => setField(field.key, e.target.value === '' ? null : Number(e.target.value))}
                >
                  <option value="">— none —</option>
                  {headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}

            <div className="flex items-start gap-3 text-sm">
              <span className="w-20 shrink-0 pt-1 opacity-60">Tags</span>
              <div className="flex flex-wrap gap-1.5">
                {headers.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => toggleTag(i)}
                    className={`rounded-full px-2.5 py-1 text-xs ${
                      mapping.tags.includes(i) ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'bg-[var(--line)] opacity-60'
                    }`}
                  >
                    {h}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Preview: the first rows exactly as they will be stored. */}
          {ready && (
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Preview</h2>
              <div className="overflow-x-auto rounded border border-[var(--line)]">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--line)] text-xs opacity-60">
                    <tr>
                      <th className="px-3 py-2">Front</th>
                      <th className="px-3 py-2">Back</th>
                      <th className="px-3 py-2">Note</th>
                      <th className="px-3 py-2">Tags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {(dryRun?.cards ?? []).slice(0, 5).map((c, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2">{c.front}</td>
                        <td className="px-3 py-2">{c.back}</td>
                        <td className="px-3 py-2 opacity-60">{c.note ?? ''}</td>
                        <td className="px-3 py-2 text-xs opacity-50">{c.tags.join(' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="space-y-3 text-sm">
            <h2 className="font-medium">Options</h2>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={reverse}
                onChange={(e) => setReverse(e.target.checked)}
              />
              <span>
                Also create reverse cards
                <span className="block text-xs opacity-50">
                  Back → Front as well. Doubles the count and forces you to produce the word, not
                  just recognise it.
                </span>
              </span>
            </label>

            {reverse && !settings.buryNew && (
              <p className="rounded bg-[var(--line)] p-2.5 text-xs">
                Reverse cards are on but sibling burying is off, so both directions of a word can
                come up the same day — and the second one is a copying exercise.{' '}
                <button
                  className="underline underline-offset-2"
                  onClick={() => void saveSettings({ buryNew: true })}
                >
                  Turn on burying
                </button>
                .
              </p>
            )}

            <label className="flex items-center gap-3">
              <span className="w-20 shrink-0 opacity-60">Duplicates</span>
              <select
                className="flex-1 rounded border border-[var(--line)] px-2 py-2"
                value={duplicates}
                onChange={(e) => setDuplicates(e.target.value as DuplicateMode)}
              >
                <option value="skip">Skip</option>
                <option value="overwrite">Overwrite</option>
                <option value="allow">Import anyway</option>
              </select>
            </label>

            <label className="flex items-center gap-3">
              <span className="w-20 shrink-0 opacity-60">Language</span>
              <input
                className="flex-1 rounded border border-[var(--line)] px-2 py-2"
                placeholder="de-DE (optional, for future speech)"
                value={lang}
                onChange={(e) => setLang(e.target.value)}
              />
            </label>

            <label className="flex items-center gap-3">
              <span className="w-20 shrink-0 opacity-60">Deck</span>
              <select
                className="flex-1 rounded border border-[var(--line)] px-2 py-2"
                value={deckChoice}
                onChange={(e) => setDeckChoice(e.target.value)}
              >
                <option value="__new__">— new deck —</option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>

            {!targetDeck && (
              <label className="flex items-center gap-3">
                <span className="w-20 shrink-0 opacity-60">Name</span>
                <input
                  className="flex-1 rounded border border-[var(--line)] px-2 py-2"
                  placeholder={fileName.replace(/\.[^.]+$/, '') || 'Imported deck'}
                  value={deckName}
                  onChange={(e) => setDeckName(e.target.value)}
                />
              </label>
            )}
          </div>

          {dryRun && (
            <p className="text-xs opacity-60">
              {body.length} rows → <strong>{dryRun.cards.length} cards</strong>
              {reverse && ' (including reverse)'}
              {dryRun.duplicates > 0 && ` · ${dryRun.duplicates} duplicates skipped`}
              {dryRun.overwritten > 0 && ` · ${dryRun.overwritten} to overwrite`}
              {dryRun.emptyRows > 0 && ` · ${dryRun.emptyRows} rows missing front or back`}
              {dryRun.cards.length > CHUNK_SIZE &&
                ` · ${Math.ceil(dryRun.cards.length / CHUNK_SIZE)} chunk files`}
            </p>
          )}

          <button
            className="w-full rounded-lg bg-[var(--accent)] py-3.5 text-[var(--on-accent)] disabled:opacity-30"
            disabled={!ready || busy}
            onClick={() => void run()}
          >
            {busy ? 'Importing…' : `Import ${dryRun?.cards.length ?? 0} cards`}
          </button>

          {!ready && (
            <p className="text-center text-xs opacity-50">Map Front and Back to continue.</p>
          )}
        </>
      )}
    </section>
  )
}
