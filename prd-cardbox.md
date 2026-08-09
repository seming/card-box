# PRD — cardbox (Personal Spaced-Repetition App)

| | |
|---|---|
| **Status** | Draft |
| **Author** | Semin Jang |
| **Reviewer** | None — single-owner project |
| **Last updated** | 2026-08-06 |
| **Scope of this version** | One person, two devices (iPhone + Mac), 10,000+ text flashcards, FSRS scheduling, GitHub as the datastore. No server, no cost. |
| **Downstream documents** | `cardbox/HANDOFF.md` — the living technical record. Data model, sync protocol, queue rules, and verification commands live there, not here. Where this PRD and HANDOFF disagree on **what** to build, this PRD wins; on **how**, HANDOFF wins. |

---

## 0. Read this first — settled decisions

These were decided before implementation began. They are constraints, not suggestions. Re-opening them means repeating the analysis that produced them.

| # | Settled decision | Why it is settled |
|---|---|---|
| 1 | **GitHub is the database.** App code in a public repo (`cardbox`, served by Pages); data in a private repo (`cardbox-data`), read and written from the browser via the Contents API with a fine-grained PAT. | It is the only free option that syncs two devices, needs no server, and produces an automatic versioned backup. GitHub Pages on the free plan requires a public repo, so code and data must be separated. |
| 2 | **FSRS-6 via `ts-fsrs`, not a hand-rolled algorithm.** | The scheduling math is the one part where a subtle error is invisible — a wrong interval still looks like a plausible interval. `ts-fsrs` is MIT, has no runtime dependencies, and carries its own test suite. |
| 3 | **Every review is logged, including how long it took.** Logs are append-only and never deleted. | The log is the sole input to future parameter optimization. `duration` in particular cannot be reconstructed after the fact. Losing it forecloses an option permanently. |
| 4 | **No notifications.** The app shows what is due when opened. | Web push on iOS requires a server to send it, which breaks decision 1. iOS Reminders can cover the habit externally. |
| 5 | **Offline-first.** IndexedDB is the working store; GitHub is the sync target. Sync happens at session boundaries, never per card. | The primary device is a phone on the move. A design that needs the network to review is a design that does not get used. |
| 6 | **Anki's defaults are the defaults.** 1m/10m learning steps, 4am day boundary, 20 new / 200 reviews per day, new cards mixed into reviews. | They are tuned over a decade and a large population. Deviating means inventing without evidence, and it makes the results incomparable to Anki. |
| 7 | **No stage begins without the owner's approval.** The AI proposes options and reasoning; the owner decides. Questions like "is this worth building?" are answered by the owner, not on their behalf. | §2.4 makes learning the working method a goal of the project. An assistant that proceeds on its own judgement removes the decisions that are the thing being learned. This applies to easily-reversible work too — the point is not risk, it is who decides. |

---

## 1. Summary

cardbox is a spaced-repetition flashcard app for one person, used mainly on an iPhone and occasionally on a Mac. It schedules reviews with FSRS-6 so that each card returns at the point where recall probability has decayed to a target level. Decks and cards are created and edited in the same web app on either device. It installs to the iOS home screen as a PWA and works with no network. Data lives as JSON in a private GitHub repository, which makes the two devices agree with each other and makes every change a commit.

It exists because AnkiMobile costs money and the alternative — building it — is a bounded amount of work that also produces a system the owner fully controls.

---

## 2. Problem and background

### 2.1 The paid app is the only good iOS option

Anki's iOS client is paid. The free alternatives on iOS are either weaker schedulers, subscription products, or web apps that do not work offline. AnkiWeb's browser client is usable but not installable and not designed for phone review.

### 2.2 Free hosting normally means no sync

A static site on free hosting can store data in the browser, but browser storage is per-device. Two devices then hold two divergent collections, which for a review system is worse than one device — the scheduler's state is the product, and a split state means cards are reviewed at wrong intervals or twice.

Paying for a backend to solve this reintroduces the cost the project exists to avoid. Using a private Git repository as the store resolves the tension: it is free, it syncs, and it versions.

### 2.3 A prototype already established what is not enough

`anki-prototype/` (July 2026) is a single-file localStorage app with fixed 1/3/7-day intervals and no deck concept. It demonstrated the review loop and nothing else. Fixed intervals do not adapt to card difficulty, which is the entire value of spaced repetition, and single-device storage is the problem in 2.2.

### 2.4 A secondary purpose

The owner is using this project to develop a working method for AI-assisted development. The document set (this PRD, a living HANDOFF, disposable session plans), the stop-at-each-stage cadence, and the requirement that queue, merge, and CSV logic be pure and unit-tested are all part of the deliverable, not overhead on it.

This is why settled decision 7 exists. Two failure modes make AI-assisted work degrade: context is lost when a session ends, and settled decisions get quietly re-opened. The document set addresses the first. The approval rule addresses the second, and also preserves the decisions themselves as something the owner practices rather than delegates.

---

## 3. Users and use cases

**Primary user:** the owner. One person, one collection.

**Core use case:** opens the app on the iPhone during a commute or a gap in the day, sees how many cards are due, reviews until the queue empties or attention runs out, closes it. Later, on the Mac, imports a batch of new vocabulary from a CSV file and edits a few cards. Both devices show the same state afterward.

**Secondary use case:** brings in an existing Anki deck. Exports it from Anki Desktop as CSV, pastes or uploads it, maps the columns, and it becomes a cardbox deck.

**Not a user:** anyone else. There is no second account, no sharing, no collaboration. See §5.

---

## 4. Goals and success metrics

**G1 — The owner can review on either device and the two never disagree.**
Outcome: the collection behaves as one collection. Measured by: reviewing different cards on both devices while offline, syncing both, and finding every review preserved on both.

**G2 — Reviewing on the phone is fast enough to do in a queue at a shop.**
Outcome: the habit survives contact with real life. Measured by: card advances with no perceptible delay at 10,000 cards, and the app functions in airplane mode.

**G3 — Importing 10,000 cards is a task, not a project.**
Outcome: existing decks are usable without manual re-entry. Measured by: a real Anki CSV export becomes a deck in under five minutes including column mapping.

**Guardrail:** the app must not lose review data. A sync bug that silently drops a card's scheduling state is worse than any missing feature, because it is invisible and cumulative. This is why merge logic is unit-tested against explicit divergence scenarios before it ships.

---

## 5. Non-goals

This is the operative section. Everything here has been considered and excluded on purpose.

| Excluded | Phase | Why not now |
|---|---|---|
| Multi-user, accounts, sharing | Never | One owner. Authentication and per-user data require a real backend, which contradicts settled decision 1. |
| Push notifications and reminders | Never | Requires a server to send them. Settled decision 4. iOS Reminders covers the habit externally. |
| Real-time or automatic background sync | Never | Session-boundary sync is sufficient for one person on two devices, and per-card commits would make the repository history useless. |
| Images and audio on cards | Phase 2 | Binary assets need a separate upload path and break the size envelope that chunked JSON depends on. |
| TTS pronunciation | Phase 2 | Cheap to add later — browser `speechSynthesis`, no stored files. The `lang` field is reserved in the card schema now so that adding it requires no migration. |
| `.apkg` direct import | Phase 2 | Anki Desktop exports CSV, so this path is not blocked, only less convenient. Parsing `.apkg` means unzipping and reading SQLite via sql.js (~1.5MB WASM). |
| In-app FSRS parameter optimization | Phase 2 | The browser optimizer needs SharedArrayBuffer, which needs COOP/COEP headers, which GitHub Pages cannot set. Runs locally via the Python `fsrs-optimizer` instead; the app only exports the CSV and accepts the resulting parameters. |
| Statistics and graphs | Phase 2 | Review counts, retention, and forecast load. Useful, not load-bearing. |
| Note types, card templates, cloze deletion | Phase 3 | Anki's note-type system is a large subsystem. Front/back plus example and note covers vocabulary, which is the actual use. |
| Nested decks and subdecks | Phase 3 | A flat deck list plus tags is sufficient at this scale. |
| Cross-deck search | Phase 3 | Per-deck search first. |
| Rescheduling existing cards after a parameter change | Phase 3 | Anki treats this as an explicit opt-in because it can inflate a day's workload without warning. New parameters apply from the next review. |

---

## 6. Functional requirements

**Must**

- Create, edit, and delete decks; create, edit, and delete cards with front, back, example, note, and tags.
- Review due cards with FSRS-6 scheduling. Four ratings (Again / Hard / Good / Easy), each button showing the interval it would produce.
- Function fully offline. Every read and write goes to local storage first.
- Sync to and from `cardbox-data` on demand, merging per card so that concurrent work on both devices survives.
- Import CSV and TSV by paste or file upload, with delimiter detection, a preview, and column-to-field mapping.
- Hold 10,000+ cards without the card list or the review queue stalling.
- Record every review, including elapsed time, and never delete a log entry.
- Install to the iOS home screen and run standalone.
- Present all interface text in English, using Anki's rating labels verbatim — Again, Hard, Good, Easy. Written project documents are in English as well; only conversation is in Korean.

**Should**

- Keyboard shortcuts for desktop review (space to reveal, 1–4 to rate).
- Search and tag filtering within a deck.
- Bulk-load a large deck outside the app, via a conversion script and a single git commit, so that a 10,000-card import cannot leave the repository half-written.
- Export the whole collection as JSON.
- Export the review log as optimizer-format CSV.
- Report sync state plainly, including which failure occurred and what to do about it.

**Could**

- Adjustable retention target and daily limits.
- Per-deck daily limits.

**Won't (now)** — see §5.

**Acceptance criteria.** Given a deck imported from a CSV, when the owner reviews some of its cards on the iPhone offline and different cards on the Mac offline, and then syncs both, every review from both devices is reflected in the collection on both devices, and no card's scheduling state has reverted.

---

## 7. UX and edge cases

**Happy path.** Open the app; the first screen states how many cards are due, per deck and in total; one button starts reviewing; the card shows its front; a tap reveals the back with the example and note; four buttons rate it and the next card appears.

**Empty state.** No decks: the screen offers creating a deck and importing a CSV, and says which is faster for a large batch. No cards due: the screen says when the next card is due rather than showing an empty queue.

**Backlog.** 10,000 imported cards at 20 new per day take roughly 500 days to introduce. The Today screen must show the remaining unseen count so the owner can raise the daily limit deliberately rather than discovering the pace by accident.

**Malformed import.** A row with fewer columns than mapped, an unparseable delimiter, or a file that is not text: the import preview reports which rows are affected and imports the rest rather than failing the whole batch.

**Duplicate import.** A card whose front already exists in the deck: the owner chooses skip, overwrite, or import anyway, before the import runs.

**Bulk load.** The in-app import writes one file per 500 cards, so a 10,000-card import is roughly twenty sequential writes. If it is interrupted — a backgrounded phone, a dropped connection — the repository must not be left describing chunks that do not exist. Two things guarantee this: writes are ordered so that the file declaring which chunks are valid is written last, and the first bulk load of an existing collection is done with a local script producing a single commit rather than through the app at all.

**Sync failure.** Every failure names its cause and its remedy — expired token, insufficient permission, rate limit with a reset time, or no network with a count of pending changes. Sync never fails silently and never discards local changes.

**Interrupted review.** Closing the app mid-session loses nothing: each rating is written locally as it happens. Sync catches up later.

**Missed days.** Returning after a gap produces a large due count. The daily review limit caps what is presented so the queue stays finite.

---

## 8. Success criteria and verification

The project is successful when the owner reviews on the iPhone for two consecutive weeks without touching Anki and without losing data.

Concrete checks, each performed on the real devices:

1. Import a real Anki CSV export of at least 1,000 cards; the deck is correct and the list scrolls smoothly.
2. Review 20 cards on the iPhone in airplane mode; all 20 are recorded; sync completes when the network returns.
3. Review distinct cards on both devices while both are offline; sync both; every review survives on both.
4. Confirm the iPhone's sync produced a commit in `cardbox-data`, and that only the affected chunk files changed.
5. Add the app to the iOS home screen; it opens standalone, respects the safe area, and the rating buttons are reachable one-handed.
6. Export the review log as CSV and confirm it is accepted by `fsrs-optimizer`.

Unit tests cover the three areas where a defect is invisible in the UI: queue construction, sync merge, and CSV parsing.

---

## 9. Open questions and risks

**The token is readable on the device.** A static site cannot hide it; anyone with the unlocked device and developer tools can read it from localStorage. Accepted: the token is scoped to one private repository with contents-only permission and is revocable in seconds. Passing a device to someone else means clearing it.

**Card-level last-write-wins can drop one rating.** If the same card is reviewed on both devices while offline, the later `updatedAt` wins and the other device's rating does not affect the schedule. Accepted: for one person this is rare, and the review log retains both entries, so nothing is lost for optimization purposes — only the schedule reflects one of them.

**A fine-grained PAT expires.** Maximum lifetime is one year. Sync fails until it is renewed. The settings screen must show the expiry, not just report failure after the fact.

**The platform is a dependency.** If GitHub changes Contents API limits, PAT policy, or free-tier Pages, the storage layer needs replacing. Mitigated by keeping the full JSON export working from the first release, so the data is never trapped.

**500 cards per chunk is an estimate.** It is derived from an assumed average card size, not measured. Revisit once a real 10,000-card deck exists; the chunk assignment is stored per card, so changing the size later requires a migration pass rather than a recomputation.

**Open: is 20 new cards per day the right pace for this backlog?** At that rate a 10,000-card import takes 500 days. The answer depends on what the cards are and is not knowable before using the app. The limit is adjustable; the Today screen surfaces the consequence.

**Open: does FSRS with default parameters behave well on a large imported backlog?** Imported cards have no review history, so all 10,000 start as new. The default parameters were trained on ordinary collections, not on a single large cold-start. Watch the first month's actual review load against the forecast.
