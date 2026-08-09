/**
 * CSV / TSV parsing.
 *
 * Pure and dependency-free so `node --test` covers it directly. Import is one of
 * the places where a defect is quiet rather than loud: a mis-parsed quote shifts
 * every column one to the left and produces a deck full of plausible-looking
 * garbage. The real deck this was built against has commas inside 56 of its 156
 * meanings, so quote handling is load-bearing, not decorative.
 */

export type Delimiter = ',' | '\t' | ';'

/**
 * Guess the delimiter by counting candidates outside quoted regions on the first
 * few lines. Counting raw characters would be fooled by "스키장, 스키 지역".
 */
export function detectDelimiter(text: string): Delimiter {
  const candidates: Delimiter[] = [',', '\t', ';']
  const sample = stripBom(text).slice(0, 64 * 1024)

  let best: Delimiter = ','
  let bestScore = -1

  for (const delimiter of candidates) {
    const rows = parseDelimited(sample, delimiter).slice(0, 10)
    if (rows.length === 0) continue
    const widths = rows.map((r) => r.length)
    const max = Math.max(...widths)
    if (max < 2) continue
    // Prefer the delimiter that yields the most columns, and among those the one
    // whose row widths are the most consistent — a real table has square rows.
    const consistent = widths.filter((w) => w === max).length / widths.length
    const score = max * 10 + consistent * 5
    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }
  return best
}

/** Byte-order mark, which Excel writes and which otherwise corrupts the first header. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * RFC 4180-style parse. Handles quoted fields containing the delimiter, newlines
 * inside quotes, and `""` as an escaped quote. Blank lines are dropped.
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const src = stripBom(text)

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // A trailing newline yields one empty field, which is not a row.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (i < src.length) {
    const ch = src[i]

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"' && field === '') {
      quoted = true
      i++
      continue
    }
    if (ch === delimiter) {
      endField()
      i++
      continue
    }
    if (ch === '\r') {
      i++
      continue
    }
    if (ch === '\n') {
      endRow()
      i++
      continue
    }
    field += ch
    i++
  }

  if (field !== '' || row.length > 0) endRow()
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

export function parseCsv(text: string, delimiter?: Delimiter): string[][] {
  return parseDelimited(text, delimiter ?? detectDelimiter(text))
}

/**
 * Which row holds the column names.
 *
 * Not always the first: the deck this was written for has two title lines above
 * its header. The heuristic picks the first row that is as wide as the widest row
 * in the file, which is what a header looks like next to decorative titles.
 */
export function guessHeaderRow(rows: string[][]): number {
  if (rows.length === 0) return 0
  const widest = Math.max(...rows.map((r) => r.length))
  if (widest < 2) return 0
  const index = rows.findIndex((r) => r.length === widest && r.every((c) => c.trim() !== ''))
  return index === -1 ? 0 : index
}

/** Pads short rows so every row has `width` cells — a row missing trailing columns is still usable. */
export function squareUp(rows: string[][], width: number): string[][] {
  return rows.map((r) => (r.length >= width ? r.slice(0, width) : [...r, ...Array(width - r.length).fill('')]))
}
