# cardbox — Handoff

Read this file first in a new session.

| | |
|---|---|
| **Last updated** | 2026-08-10 |
| **Stage** | 4 of 7 — importing and reviewing both work. Stage 3 (deck screens) deferred; stage 5 (sync) is next |
| **Product spec** | [`prd-cardbox.md`](prd-cardbox.md) — what and why. This file is how. |
| **Repository** | `seming/card-box` (public). Data repo for stage 5 not created yet. |
| **Deployment** | Not yet. GitHub Pages wiring is stage 6, at `https://seming.github.io/card-box/`. |

---

## 0. Settled — do not re-litigate

These were decided with reasoning that took real work. Reopening them repeats it.

| # | Decision | Why |
|---|---|---|
| 1 | **GitHub is the database.** Code in public `card-box`, data in a private data repo, written from the browser via the Contents API with a fine-grained PAT. | Only free option that syncs two devices with no server and versions everything. Pages on the free plan needs a public repo, so code and data must be separate. |
| 2 | **`ts-fsrs` owns the scheduling math.** Never hand-roll it. | A wrong interval still looks like a plausible interval. The bug would be invisible for months. |
| 3 | **Reviews are logged forever, with `duration`.** | Sole input to future parameter optimization, and the daily counts derive from it. `duration` cannot be reconstructed later. |
| 4 | **Offline-first.** IndexedDB is the working store; GitHub is a sync target reached at session boundaries. | The primary device is a phone in motion. Needing the network to review means not reviewing. |
| 5 | **Anki's defaults are the defaults.** 1m/10m learning steps, 4am day boundary, 20 new / 200 reviews, new mixed into reviews. | Tuned over a decade on a large population, and it keeps results comparable to Anki. |
| 6 | **Chunk sha is a cache hint, not truth.** If the recorded sha disagrees with the API, refetch. | Makes it safe to write the repo from outside the app — the bulk-load script, a hand edit, a future migration. Treating sha as truth desynchronizes on any commit the app did not make. |
| 7 | **Queue, merge, and CSV logic stay pure.** They take `now` as an argument and read no globals. | So `node --test` can run them with no DOM and no build step. These are the three places a defect is invisible in the UI. |
| 8 | **No stage starts without the owner's approval.** Offer options and reasoning; do not decide. | Learning the working method is a stated goal of the project (PRD §2.4). An assistant that proceeds on its own removes the thing being learned. Applies to reversible work too. |

---

## 1. Layout

```
cardbox/
├── HANDOFF.md            ← this file
├── vite.config.ts        base '/card-box/' — must equal the repo name. React + tailwind.
├── tsconfig.app.json     erasableSyntaxOnly on
├── package.json          `imports` maps '#src/*' → './src/*' (see below)
├── src/
│   ├── main.tsx          router; basename follows vite's `base`
│   ├── types.ts          zod schemas: Card, Deck, ReviewLogEntry, Settings
│   ├── lib/
│   │   ├── day.ts        ✅ pure — 4am study-day boundary
│   │   ├── id.ts         ✅ uuid + ISO helpers
│   │   ├── idb.ts        ✅ IndexedDB store
│   │   ├── scheduler.ts  ✅ the only file that imports ts-fsrs
│   │   ├── queue.ts      ✅ pure — order, daily limits, interleaving
│   │   ├── csv.ts        ✅ pure — CSV/TSV, delimiter and header detection
│   │   ├── xlsx.ts       ✅ pure — .xlsx via fflate, no DOMParser
│   │   └── import.ts     ✅ pure — rows → cards, reverse, dedupe, chunks
│   ├── store/useStore.ts ✅ zustand: settings, decks, today's log
│   └── pages/
│       ├── AppShell.tsx  bottom tabs, safe-area aware
│       ├── TodayPage.tsx per-deck counts, backlog warning
│       ├── ReviewPage.tsx ✅ the review loop
│       ├── ImportPage.tsx ✅ file or paste → sheet → header → mapping → preview
│       └── ManagePage.tsx ★ stage-1 harness — replaced in stage 3
├── samples/
│   ├── b1-lesen-teil.xlsx      the owner's real workbook — also the test fixture
│   ├── b1-lesen-teil.csv       the same deck flattened to CSV
│   └── goethe-b1-starter.csv    82 entries written from scratch, a starting point
└── tests/
    ├── day.test.mjs      ✅ 20 tests
    ├── queue.test.mjs    ✅ 33 tests
    ├── csv.test.mjs      ✅ 29 tests
    ├── xlsx.test.mjs     ✅ 15 tests
    └── import.test.mjs   ✅ 36 tests
```

Not written yet: `lib/merge.ts`, `lib/github.ts`, `lib/sync.ts`, `scripts/`.

**Internal imports are `#src/...` with the `.ts` extension**, declared once in
package.json `imports`. Node, TypeScript and Vite all read that field. A tsconfig
`paths` alias was tried first and had to be abandoned — `node --test` cannot see
it, so the pure modules were unreachable from tests.

---

## 2. What works now

- Deck and card CRUD against IndexedDB, surviving reload.
- Chunk assignment: cards fill `chunk 0` to exactly 500, then roll to `chunk 1`.
- Deletion writes a tombstone (`deleted: true`) instead of removing the row.
- Study-day boundary at 04:00, including month/year rollover and a configurable hour.
- **A full review loop**: front → reveal → four ratings, each showing the interval it
  would produce. Space reveals, 1–4 rate.
- **Review logging** with `duration`, from which the daily limits are derived.
- Today screen with per-deck learning/review/new counts and a backlog warning.
- **Import** from CSV, TSV or .xlsx: sheet chooser, header-row chooser, column mapping,
  live preview, reverse-card generation, duplicate handling, chunk continuation.

Intervals for a brand-new card come out as `1m / 6m / 10m / 8d`, which is what Anki
produces with the same steps — a useful sanity check if scheduling ever looks wrong.

Verified in headless Chrome: 26/26 for the review loop, 19/19 for importing the real
workbook end to end — see §7.

---

## 3. Storage

### Local — IndexedDB `cardbox` v1

| Store | Key | Indexes |
|---|---|---|
| `decks` | `id` | — |
| `cards` | `id` | `deckId`, `due` (`fsrs.due`), `deckChunk` (`[deckId, chunk]`) |
| `reviews` | `id` | `review`, `cardId` |
| `meta` | out-of-line | — (settings, sync cursors, chunk shas) |

localStorage is not viable at 10,000 cards: synchronous, string-only, ~5MB cap.

### Remote — `cardbox-data` (private)

```
index.json                       deck summaries + reviewDays[]
settings.json                    retention, daily limits, FSRS w
decks/<deckId>/meta.json         name + chunk list (number, sha, count)
decks/<deckId>/cards-000.json    500 cards
decks/<deckId>/cards-001.json
reviews/2026-08-08.jsonl         one study day of reviews
```

**Why chunks.** 10,000 cards in one file is 4–6MB, over the Contents API's 1MB read limit. At 500 per chunk each file is ~250KB. The larger win is write cost: reviewing 20 cards dirties one to three chunks, so a sync pushes ~250KB instead of rewriting 6MB.

Chunk numbers are assigned at card creation and frozen on the card. Deriving them from a hash would reshuffle every card the moment the chunk size changed.

**Why one review file per day.** The Contents API has no append — the whole file is rewritten every time, so file size is upload size. A day is bounded by the daily limits at roughly 700 records (~140KB); a month would be 4MB and break the limit. More importantly, **past days are immutable**, so they need no merge logic and cannot conflict. Only today's file is ever in play. `index.json` carries `reviewDays[]` so no directory listing is needed.

---

## 4. Queue and scheduling

Implemented in `lib/scheduler.ts` and `lib/queue.ts`.

```ts
fsrs(generatorParameters({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_short_term: true,
  learning_steps: ['1m', '10m'],
  relearning_steps: ['10m'],
  ...(settings.w ? { w: settings.w } : {}),
}))
```

`ts-fsrs` implements learning steps itself (`FSRSParameters.learning_steps`, `Card.learning_steps`), so do not write step logic. `next()` returns minute-level `due` values directly.

**Order:** learning/relearning cards with `due <= now` first; then review cards due before tomorrow's 04:00, earliest first with a random tiebreak; then new cards in creation order. Reviews and new cards are **interleaved**, matching Anki's "mix with reviews".

**Daily limits are per deck**, as they are in Anki, and derived from the review log rather
than a stored counter — count today's entries for that deck with `state === New` and
`state === Review`. Learning repeats do not consume the limit. Since the log syncs,
cross-device totals add up for free; a separate counter would need its own merge rules for
no gain.

Counting globally was a real bug, not a hypothetical one: studying one deck made a deck
imported minutes later report "done for today" without ever having been seen. `buildQueue`
and `queueCounts` group by deck and apply the allowance separately; learning cards from
every deck still come first, since they are mid-flight.

---

## 5. Sync

Not implemented yet — stage 5, the hardest one. Design is settled:

- Read `GET /repos/{owner}/{repo}/contents/{path}` → base64 + `sha`; keep the sha locally.
- Write `PUT` with `{ content, sha, message }`. A stale sha returns 409.
- On 409: refetch the chunk, merge by card id taking the later `updatedAt` (per-card last-write-wins; tombstones win when later), retry up to three times.
- Review logs merge as a union by id, and only ever in today's file.
- **Write order is chunks → `meta.json` → `index.json`.** `meta.json` declares which chunks are valid, so writing it last means an interruption leaves undeclared orphan files that the next attempt overwrites. The reverse order points at files that do not exist.
- Pull walks `index.json` → changed decks' `meta.json` → only chunks whose sha differs.
- Bootstrap: an empty repo 404s on `index.json`; PUT `index.json` and `settings.json` with no sha to create them.

Bulk loading an existing collection goes through `scripts/import-csv.mjs` and a single git commit, not through the app — 20 sequential PUTs from a phone can be interrupted halfway.

### Sync has to be visible, not trusted

Automatic sync that cannot be observed is worse than manual sync, because a silent
failure looks exactly like success. The rule: **syncing may succeed quietly; it may never
fail quietly.**

Required, not optional:

- **A persistent status in the header**, never behind a menu. `Synced 2 min ago`,
  `Syncing…`, `3 changes pending`, `Offline — 5 pending`, `Token expired — update in
  settings`.
- **A pending count as a number.** "3 changes pending" is checkable; "sync may be delayed"
  is not. Zero means everything is up.
- **A manual button.** It creates no trust by itself — pressing it proves nothing about
  the outcome — but it is the escape hatch for the automatic triggers iOS misses, since
  apps there are swiped away rather than closed.
- **Loud failures that name the remedy.** An expired token discovered weeks later is the
  worst case; the error table above exists for this.

The strongest guarantee sits outside the app: every sync is a git commit, so github.com
shows what changed and when, per card, whether or not the app is telling the truth.
AnkiWeb has no equivalent.

Losing data is not among the failure modes. An answer reaches IndexedDB before any upload
is attempted, so uploading only ever copies what is already safe. Sync failing for a month
means the other device is stale, not that reviews are gone.

---

## 6. Import

Handles CSV, TSV and .xlsx. Three properties of the owner's real workbook drove the
design, and all three are covered by tests against that exact file:

1. **The header is on row 3.** Two title rows sit above it, so `guessHeaderRow` picks the
   first row as wide as the widest row rather than assuming row 1. The UI lets it be
   overridden.
2. **Four sheets, only two with cards** — `Teil순 단어장` (156 words) and `표현만 모아보기`
   (15 expressions); `복습용` is the same data rearranged for self-testing and `요약` is a
   count table. The sheet chooser defaults to the largest.
3. **56 of 156 meanings contain a comma.** Quote handling is load-bearing; without it
   every column shifts and the deck fills with plausible garbage.

**xlsx is parsed directly** — `fflate` (~8KB) unzips, and `lib/xlsx.ts` scans the XML by
hand. `DOMParser` was avoided on purpose: it does not exist in Node, and the module has to
stay testable. Two things vary between writers and both are handled rather than assumed:
elements may carry a namespace prefix (this file uses `<x:row>`, not `<row>`) and
attributes appear in no fixed order. This file also has an *empty* shared-string table and
puts its text in `t="str"` cells instead.

**Cards are generated in both directions** by default. The reverse card is tagged
`reverse` so it can be found later without touching the originals.

**The deck contains four genuine duplicates.** `ein Verbot fordern`, `mit viel
Flüssigkeit`, `den Arzt aufsuchen` and `beeinträchtigt sein` appear on both the word sheet
and the expression sheet, worded slightly differently in Korean. So the CSV's 171 entries
are 167 distinct terms — 334 cards with reverses, not 342. This is the deck's own property,
not a parsing fault, and it is exactly what the duplicate setting is for.

Importing the word sheet alone yields **312 cards** (156 × 2), which is what the browser
test asserts.

Re-importing the same file is safe: existing fronts are matched case-insensitively and
skipped, and `overwrite` reuses the existing card's id and chunk so a row is replaced
rather than doubled.

**`scripts/import-csv.mjs` is not written yet.** It belongs to stage 5, not here: its job
is to emit chunk JSON, `meta.json` and `index.json` for `cardbox-data` in a single git
commit, and none of those files have been exercised yet. Building it before sync exists
would mean building against an untested spec.

---

## 7. Verification

```bash
npm test          # node --test over tests/**/*.test.mjs
npm run lint      # oxlint
npx tsc -b        # typecheck
npm run check     # all three
npm run dev       # dev server at /cardbox/
```

Browser-level CRUD is driven over the DevTools Protocol with no dependencies — Node 24 has a global `WebSocket`. The stage-1 driver lives in the session scratchpad; recreate it as needed. It clears IndexedDB, then checks boot, empty state, deck create, card add, reload persistence, seeding 600 cards, chunk rollover at exactly 500, and tombstone-on-delete.

**Tests import `.ts` directly** (`import { dayStart } from '../src/lib/day.ts'`). Node 24 strips types natively, so there is no build step for tests. This is why `erasableSyntaxOnly` is on in `tsconfig.app.json` — TS `enum`, `namespace`, and parameter properties would break it. Use `as const` objects instead of enums, as `types.ts` does for `State` and `Rating`.

---

## 8. Gotchas

- **`State` and `Rating` values are load-bearing.** `types.ts` defines them as `as const` objects whose values match both `ts-fsrs`'s enums and the FSRS optimizer's `review_state` / `review_rating` columns. That alignment is why the review log exports with no translation table. Do not renumber. `Rating.Manual = 0` must be filtered out on export.
- **`btoa()` mangles Korean.** Use `TextEncoder` → `Uint8Array` → base64 when writing to the Contents API.
- **Verify against a fresh clone, not the working copy.** `fflate` was installed into a
  parent directory by accident and never reached `package.json`; Node resolves upwards, so
  everything passed locally while a clone failed to typecheck. `git clone` to a temp
  directory, `npm install`, `npm run check` — that is the only check that catches this.
- **Do not reach for a tsconfig `paths` alias.** Only TypeScript sees it, so `node --test`
  fails to resolve the pure modules. package.json `imports` is read by Node, TypeScript
  and Vite alike, which is why `#src/*` is used. Imports need the explicit `.ts` extension.
- **`baseUrl` is deprecated in TS 6**, and unnecessary anyway with the above.
- **`ts-fsrs` types learning steps as a template literal** (`` `${number}m` ``), not `string`.
  `types.ts` carries that through with `z.custom<Step>`; a plain `z.string()` forces a cast
  and throws the runtime check away.
- **Rating previews are frozen at reveal time.** Recomputing them per render makes the
  numbers drift under the reviewer's eyes while they decide.
- **The first option of every column select is `— none —`.** Indexing the option list by
  the mapped column number is therefore off by one; read the selected option's text.
- **This workbook has an empty shared-string table.** Text arrives in `t="str"` cells, so
  a reader that only handles `t="s"` returns a sheet of blanks.
- **Test navigation by clicking, not by URL.** Driving the browser with `Page.navigate`
  reaches every route and proves nothing about whether anything links to them. The deck
  rows on Today rendered correctly and were dead for a whole stage because
  `/review/:deckId` existed but nothing pointed at it. Click links; assert `location`.
- **react-router normalises the basename**, so the index route is `/card-box`, not
  `/card-box/`. Assert on both.
- **Daily limits are per deck.** `remainingToday` takes an optional `deckId` and callers
  should pass it. Omitting it counts every deck together, which starves new decks.
- **The study day starts at 04:00, so late-evening work counts as "today" until 4am.**
  Reviews done at 22:00 still consume the allowance at 01:00 the next morning. This is
  correct, and it surprises people — including while debugging.
- **`base` in vite.config.ts must equal the GitHub repository name.** The repo is
  `card-box`, so Pages serves at `/card-box/` and every asset URL and the router
  basename derive from it. A mismatch gives a blank page with 404s on the assets.
- **Fine-grained PATs expire**, one year maximum. The settings screen must show the expiry
  rather than only reporting failure afterwards. Prefer 90 days over a year — the app
  surfaces the expiry anyway, and it narrows the window if the token ever leaks.
- **`seming.github.io` is one origin for every Pages project on the account.** localStorage
  is keyed by origin, not by path, so anything published at `seming.github.io/anything/`
  can read the token stored by `/card-box/`. Publishing an unvetted template or a
  third-party bundle under the same account is enough. Nothing in this repository can
  prevent it; worth remembering when the next Pages project goes up.
- **Cards render as text, and should stay that way.** React escapes by default, which is
  the only reason an imported deck cannot carry script. Allowing HTML in card fields, as
  Anki does, would turn any shared deck into a way to read the token out of localStorage.
- **`api.github.com` allows browser requests** — CORS is not a problem here.
- **500 cards per chunk is an estimate**, not a measurement. Revisit once a real 10,000-card deck exists. Because the number is stored per card, changing it later needs a migration pass, not a recomputation.

---

## 9. Next

- [x] **Stage 1** — scaffold, deps, `types.ts`, `day.ts`, `idb.ts`, this file
- [x] **Stage 2** — `scheduler.ts`, `queue.ts`, router, Today and Review screens, logging with `duration`
- [ ] **Stage 3** — DecksPage, DeckDetailPage, CardEditor, virtual scrolling. Deferred past stage 4; `ManagePage` still covers deck creation and shows only the first 50 cards
- [x] **Stage 4** — `csv.ts`, `xlsx.ts`, `import.ts`, ImportPage. Done ahead of stage 3 so the real deck could be loaded. `scripts/import-csv.mjs` moved to stage 5 — see §6
- [ ] **Stage 5** — `github.ts`, `merge.ts`, `sync.ts`, `scripts/import-csv.mjs`, SettingsPage. `merge.test.mjs`, then the real two-device divergence run
- [ ] **Stage 6** — PWA, icons, GitHub Actions deploy, iPhone home screen
- [ ] **Stage 7** — reconcile this file against the code

`ManagePage.tsx` is the stage-1 harness under a new name. Stage 3 replaces it; do not build on it.

### Before stage 5

1. Create `cardbox` (public) and `cardbox-data` (private) on GitHub.
2. `cardbox` → Settings → Pages → Source: **GitHub Actions**.
3. Issue a fine-grained PAT: repository access `cardbox-data` only, permissions Contents read and write.

The token is entered in the app's settings screen. It never goes in the code or either repository.

---

## 10. Starting a new session

On a machine that already has the project:

```
Read HANDOFF.md and start there.
Do not re-litigate §0. Ask before starting the next stage.
```

From nothing:

```bash
git clone git@github.com:seming/card-box.git
cd card-box
npm install
npm run check          # lint, typecheck, 139 tests — all should pass
npm run dev            # http://localhost:5173/card-box/
```

Then load a deck: **Import** → choose `samples/b1-lesen-teil.xlsx` → the sheet,
header row and column mapping fill themselves in → **Import**. Nothing else is
needed; there is no server and no account, and the browser holds the data.

Requires Node 24 or newer — the tests import `.ts` files directly and rely on
native type stripping.

Everything needed to continue is in this repository: this file, the PRD beside
it, the source, the tests, and the real deck as a fixture. Review state lives in
the browser, not in git, so a fresh clone starts with an empty collection —
that is expected until sync lands in stage 5.
