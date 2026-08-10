import type { ColumnMapping } from '#src/lib/import.ts'

/**
 * Decks that ship with the app.
 *
 * They live in `public/decks/` rather than being bundled into the JavaScript:
 * no cost to anyone who never loads one, and the service worker precaches them
 * so the sample is available on a phone that has never been online.
 *
 * The point is the first five minutes on a phone. Getting an xlsx into the iOS
 * Files app is the most annoying step in the whole product, and it stands
 * between a new install and finding out whether the app is any good.
 */

export interface SampleDeck {
  id: string
  name: string
  file: string
  cards: number
  description: string
  /** Column layout is known, so the importer opens with it already applied. */
  mapping: ColumnMapping
  lang: string
  /** Both directions by default — these are vocabulary decks. */
  reverse: boolean
}

export const SAMPLE_DECKS: SampleDeck[] = [
  {
    id: 'b1-lesen-teil',
    name: 'B1 Lesen — Teil order',
    file: 'decks/b1-lesen-teil.csv',
    cards: 171,
    description:
      'Goethe B1 reading vocabulary, in exam order. 156 words and 15 phrases, with the exam note and Teil kept as tags.',
    mapping: { front: 0, back: 1, example: null, note: 2, tags: [3] },
    lang: 'de-DE',
    reverse: true,
  },
  {
    id: 'goethe-b1-starter',
    name: 'B1 starter',
    file: 'decks/goethe-b1-starter.csv',
    cards: 82,
    description:
      'A general B1 set written from scratch: nouns with their plurals, verbs with principal parts, and the connectors whose word order trips people up.',
    mapping: { front: 0, back: 1, example: 3, note: 2, tags: [4] },
    lang: 'de-DE',
    reverse: true,
  },
]

/** Fetches a bundled deck. `import.meta.env.BASE_URL` keeps it right under /card-box/. */
export async function fetchSample(deck: SampleDeck): Promise<string> {
  const res = await fetch(`${import.meta.env.BASE_URL}${deck.file}`)
  if (!res.ok) throw new Error(`Could not load ${deck.name} (${res.status})`)
  return res.text()
}
