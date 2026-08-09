import { unzipSync, strFromU8 } from 'fflate'

/**
 * Reading .xlsx.
 *
 * The owner's deck arrives as a workbook, not a CSV, so this is a first-class
 * input rather than a convenience. An xlsx is a zip of XML, which makes it far
 * cheaper than it sounds: `fflate` (~8KB) does the decompression and the XML
 * below is regular enough to scan directly.
 *
 * Deliberately not using `DOMParser`. It exists in browsers but not in Node, and
 * this module has to stay testable under `node --test` — the same reason the
 * queue avoids `ts-fsrs`.
 *
 * Two things vary between writers and both are handled here rather than assumed:
 * elements may carry a namespace prefix (`<x:row>` as well as `<row>`), and
 * attributes appear in no fixed order.
 */

export interface Sheet {
  name: string
  rows: string[][]
}

/** Optional namespace prefix, e.g. the `x:` in `<x:row>`. */
const NS = '(?:[A-Za-z_][\\w.-]*:)?'

const tagRe = (name: string, flags = 'g'): RegExp =>
  new RegExp(`<${NS}${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${NS}${name}>)`, flags)

/** Reads an attribute regardless of position, and regardless of its own prefix (`r:id`). */
function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${NS}${name}="([^"]*)"`).exec(attrs)?.[1]
}

const XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}

function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return XML_ENTITIES[body] ?? whole
  })
}

/** Concatenated text of every `<t>` in a fragment. Rich text splits one string across several. */
function textOf(fragment: string): string {
  let out = ''
  const re = tagRe('t')
  let m: RegExpExecArray | null
  while ((m = re.exec(fragment))) out += m[2] ?? ''
  return decodeXml(out)
}

/** `BC12` → 54. Column letters are base-26 with A = 1. */
export function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  const re = tagRe('si')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(textOf(m[2] ?? ''))
  return out
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  const rowRe = tagRe('row')
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowRe.exec(xml))) {
    const body = rowMatch[2]
    if (!body) {
      rows.push([])
      continue
    }

    const cells = new Map<number, string>()
    const cellRe = tagRe('c')
    let cellMatch: RegExpExecArray | null

    while ((cellMatch = cellRe.exec(body))) {
      const attrs = cellMatch[1] ?? ''
      const inner = cellMatch[2] ?? ''
      const ref = attr(attrs, 'r')
      if (!ref) continue
      const type = attr(attrs, 't')

      let value: string
      if (type === 'inlineStr') {
        value = textOf(inner)
      } else if (type === 's') {
        // Shared-string table: the cell holds an index into it.
        const raw = tagRe('v', '').exec(inner)?.[2] ?? ''
        value = shared[Number(raw)] ?? ''
      } else {
        // `str` (formula result), `n` (number) and untyped all hold literal text.
        value = decodeXml(tagRe('v', '').exec(inner)?.[2] ?? '')
      }

      const trimmed = value.trim()
      if (trimmed !== '') cells.set(columnIndex(ref), trimmed)
    }

    if (cells.size === 0) {
      rows.push([])
      continue
    }
    const width = Math.max(...cells.keys()) + 1
    rows.push(Array.from({ length: width }, (_, i) => cells.get(i) ?? ''))
  }

  // Drop leading and trailing blank rows but keep interior ones, which carry
  // position for anything that indexes by row number.
  while (rows.length && rows[0].length === 0) rows.shift()
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop()
  return rows
}

/**
 * Every sheet in workbook order, so a chooser can present them by name.
 *
 * Sheet order matters: the deck this was built against has four sheets and only
 * two hold cards; the others are the same data rearranged for self-testing and a
 * summary table.
 */
export function readXlsx(data: Uint8Array): Sheet[] {
  const files = unzipSync(data)
  const read = (path: string): string | null => {
    const entry = files[path]
    return entry ? strFromU8(entry) : null
  }

  const shared = parseSharedStrings(read('xl/sharedStrings.xml') ?? '')

  // The sheet's name is in workbook.xml; the file it points at is in the rels.
  const workbook = read('xl/workbook.xml') ?? ''
  const rels = read('xl/_rels/workbook.xml.rels') ?? ''

  const targets = new Map<string, string>()
  const relRe = /<[^>]*\bRelationship\b([^>]*)\/?>/g
  let relMatch: RegExpExecArray | null
  while ((relMatch = relRe.exec(rels))) {
    const id = attr(relMatch[1], 'Id')
    const target = attr(relMatch[1], 'Target')
    if (id && target) targets.set(id, target)
  }

  const sheets: Sheet[] = []
  const sheetRe = new RegExp(`<${NS}sheet\\b([^>]*?)/?>`, 'g')
  let sheetMatch: RegExpExecArray | null

  while ((sheetMatch = sheetRe.exec(workbook))) {
    const attrs = sheetMatch[1] ?? ''
    const name = decodeXml(attr(attrs, 'name') ?? '')
    const rid = attr(attrs, 'id')
    if (!name || !rid) continue

    let path = (targets.get(rid) ?? '').replace(/^\//, '')
    if (!(path in files)) path = `xl/${path}`
    const xml = read(path)
    if (xml === null) continue

    sheets.push({ name, rows: parseSheet(xml, shared) })
  }
  return sheets
}

/** True when the bytes look like a zip, which is what an xlsx is. */
export function looksLikeXlsx(data: Uint8Array): boolean {
  return data[0] === 0x50 && data[1] === 0x4b
}
