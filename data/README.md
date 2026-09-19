# `data/` — runtime inputs

This directory is intentionally empty in the published repository.

The working copy held real meeting transcripts and a live dump of a real
backlog, so none of it could be published. The code still expects these files;
the shapes are documented below so you can supply your own.

| File | Produced by | Shape |
| --- | --- | --- |
| `live-workitems.json` | `node tools/fetch-workitems.js` | Array of work items as returned by the Azure DevOps REST API, each with `id`, `fields`, `rev` |
| `transcripts/<meeting>.json` | You | `{ id, label, meeting, date, speaker, topics: [{ title, status, text }] }` where `status` is `DONE`, `IN_PROGRESS` or `NEXT` |
| `vocabulary.json` | You | `[{ canonical, variants: [] }]` — product names speech-to-text tends to mishear |
| `watched-meetings.json` | The Teams tab | Meetings you ticked to watch |
| `workitems.json` | `tools/build-cards.js` | The subset of work items the cards were built against |
| `comments.json` | `tools/build-cards.js` | Proposed comments, before approval |
| `write-actions.json` | `src/cli.ts` | What a run would write, for inspection before approving |
| `enrollment.json` | You | `{ adoIdentity, displayName }` — who "you" are, so it never speaks for anyone else |

A minimal transcript is enough to see the engine work:

```json
{
  "id": "standup-example",
  "label": "Daily Standup — example",
  "meeting": "Daily Standup",
  "date": "2026-01-15T09:30:00Z",
  "speaker": "Your Name",
  "topics": [
    {
      "title": "Checkout migration",
      "status": "IN_PROGRESS",
      "text": "On 10001001 I finished the session handling and I am still working through the retries."
    }
  ]
}
```

Put that in `transcripts/`, run `node tools/build-cards.js`, and a card appears
in the Teams tab's review surface.
