# cardbox

A personal spaced-repetition flashcard app. One person, two devices, no server,
no cost.

Reviews are scheduled with [FSRS-6](https://github.com/open-spaced-repetition/ts-fsrs)
so each card returns roughly when it is about to be forgotten. Everything works
offline; a private GitHub repository is the sync target rather than a backend.

## Status

Stages 1, 2 and 4 of 7 are done — storage, reviewing, and import from
CSV/TSV/xlsx. Sync and deployment are still ahead.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173/card-box/
npm run check    # lint, typecheck, tests
```

## Where to read next

- [`HANDOFF.md`](HANDOFF.md) — how it is built, what is decided, and what is next.
  Start here.
- [`../prd-cardbox.md`](../prd-cardbox.md) — what it is for and, more usefully,
  what it deliberately does not do.
