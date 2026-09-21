# ADO Sync

Turns what you already said in a standup into a reviewed comment on the right
Azure DevOps work item — and never writes without you approving it.

Microsoft Global Hackathon 2026.

## The problem

Every standup produces precise, current status, spoken by the people who did the
work. Then the meeting ends and nobody types it in. Days later the board still
says nine days ago. The update was never missing. It was just never written down.

## What it does

1. Notices a meeting you subscribed to has happened, and fetches what was said.
2. Works out which work item each spoken update belongs to.
3. Proposes the comment that update implies.
4. You approve, edit, pick a different item, or skip.
5. Only then does it write — as a guarded write.

It never writes on its own, and it never guesses who you are.

### Nobody has to ask it to run

Tick a meeting on the Meetings tab and that is the last instruction it needs.
`teamsapp/watcher.js` fires once on subscribe and then polls on an interval,
asking WorkIQ what you said in the most recent occurrence and building a card
from the answer. Everything it does — including the ticks that find nothing —
is appended to a run log, because "running and finding nothing" has to be
distinguishable from "died quietly".

Because WorkIQ answers about *the most recent occurrence* rather than about a
specific one, a naive poller would rebuild the same card forever. State is
therefore keyed on the occurrence date in `data/watcher-state.json`.

The autonomy stops at the proposal. The **trigger** is autonomous; the **write**
is not, and the watcher has no path to Azure DevOps at all. To see the whole
loop run without a human in it:

```bash
node tools/prove-ambient.js
```

It subscribes to one meeting, then only reads — and reports whether a card
appeared on its own.

### Matching is ranked, and it admits when it cannot decide

Matches are tiered, strongest first: an id said out loud (`explicit-id`) beats a
title match, which beats corroboration across several topics. When two work
items fit equally well — someone says "parity" and there are two sibling tasks
about parity — it does not pick. It lists the candidates and asks. A choice,
not a guess.

### The write is guarded by the server, not by an `if`

The comment and a test on the revision go up as a single patch document. If
anyone edited the item since the card was built, the revision test fails, Azure
DevOps returns `409 VS403351`, and the item is left untouched. The guarantee
comes from the server refusing the write.

### Transcription repair never rewrites what you said

Speech-to-text mishears product names. The engine offers a repair rather than
applying it. Accepting one changes only what is *matched* — the recorded text of
what you said is never altered.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | The engine: segmentation, matching, consolidation, the guarded write |
| `src/test/` | Evals for the matching tiers, ambiguity, the write guard, and the watcher |
| `teamsapp/` | The Teams tab — home, meetings, review, the approval surface, and the watcher |
| `tools/` | Helpers to fetch work items, build cards, and prove the ambient loop |
| `data/` | Runtime inputs. Empty here on purpose — see `data/README.md` |

## Running it

```bash
npm install
npm run compile
npm test
```

The Teams tab is served locally:

```bash
node teamsapp/serve.js
```

You will need your own dev certificate and your own Teams app registration; see
`teamsapp/README.md`. The manifest here ships with a placeholder app id.

## A note on what is not in this repo

This was built and demonstrated against a real backlog and real meeting
transcripts. None of that is here. The `data/` directory, the generated cards,
the approval and decision logs, and the development certificate were all removed
before publishing, and the identifiers that remained in tests and fixtures were
renamed. What is left is the engine and the interface, which is the part worth
reading.

## Licence

MIT. See `LICENSE`.
