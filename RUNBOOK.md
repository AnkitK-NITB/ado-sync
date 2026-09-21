# ADO Sync — end-to-end runbook

Everything needed to run this from a cold start, and the context needed to change it
safely. Written so a fresh agent or chat session can pick it up with no prior history.

**What it does.** Reads a Teams standup, matches what each person said to their Azure
DevOps work items, and proposes **one comment per work item**. Nothing is written until
the owner approves it.

**Current state (2026-09-18).** The full loop works: WorkIQ transcript → engine → card in
a Teams tab → Approve → revision-guarded write to Azure DevOps. 84 evals passing. Verified
live against PBI 10001002.

---

## 1. Before you touch anything

| Requirement | Check | If missing |
|---|---|---|
| Node.js 18+ | `node --version` | install Node |
| Azure CLI, signed in | `az account show` | `az login` |
| Azure DevOps token works | `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` | `az login` again |
| Teams custom app upload | Teams → Apps → Manage your apps | already confirmed available in this tenant |

`499b84ac-1321-427f-aa17-267ca6975798` is the fixed Azure DevOps resource id. It is not a
secret and is the same everywhere.

The demo writes to **`contoso` / `One`**, area `One\Xstore\WKLD`, as
**you@example.com**. Change those in `data/enrollment.json` and
`teamsapp/cards.json` before running as anyone else.

---

## 2. Cold start, in order

```powershell
cd ado-sync-agent

npm install          # first time only
npm test             # expect: 79 pass, 0 fail

node tools/fetch-workitems.js    # pull current work items from Azure DevOps
node tools/build-cards.js        # run the engine → teamsapp/cards.json

cd teamsapp
powershell -ExecutionPolicy Bypass -File setup-dev-cert.ps1    # first time only
node validate-manifest.js        # expect: VALID
node serve.js                    # leave running
```

Then in Teams: **Apps → Manage your apps → Upload a custom app** → pick
`ado-sync-teams-app.zip`. Open **ADO Sync**. One tab appears: **Meetings**.

### Presenting it

The tab is the demo. **Meetings** lists the meetings you watch, takes a `.vtt` or `.md`
transcript, and shows a tile per meeting in time order.

Suggested order for a live demo: press **Sync from WorkIQ** to show the meetings it found,
upload a transcript to produce a card, open that tile, approve for real, then show the
comment in Azure DevOps and point out that the tile is now green.

The old ten-step SVG walkthrough was removed along with its tab. The 1:33 narrated video in
`ado-sync-video/motion/` covers the same ground and is better suited to presenting.

### The two failure modes that waste the most time

**Teams keeps showing the old tabs.** The zip can be perfectly correct and Teams will still
render the tab strip it already has. Teams caches on `id` + `version`, so re-uploading a
package whose `version` has not changed is treated as the app it already installed. Bump
`version` in `manifest.json` before repackaging, or remove the app under **Manage your apps**
and upload again. Checking the zip contents will not reveal this -- the contents are right.

**A blank tab in Teams.** Teams will not render a tab over plain HTTP, and it fails
*silently* — no error, just an empty tab. It also will not render an untrusted
certificate. If the tab is blank: is `serve.js` running, and did it print `HTTPS` rather
than `HTTP`? If it printed `HTTP`, `devcert.pfx` is missing — run `setup-dev-cert.ps1`.

**Buttons that appear dead.** `alert()`, `confirm()` and `prompt()` are suppressed inside
the Teams webview. Any new UI must render feedback **in the page**. Nothing in
`meeting.html` uses a native dialog, and nothing added should.

---

## 3. How the pieces fit

```
Teams standup
     │  WorkIQ (MCP) — see §6
     ▼
transcript topics  ──►  normalize  ──►  match  ──►  consolidate  ──►  card
                         (vocabulary)   (ladder)   (1 per item)        │
                                                                      │ Approve
                                                                      ▼
                                                        serve.js  ──►  Azure DevOps
                                                     (Entra token,   (guarded patch)
                                                      as the user)
```

### Files that matter

| Path | What it is |
|---|---|
| `src/normalize.ts` | Transcript → per-speaker updates. Drops filler, splits topics, applies vocabulary repair |
| `src/match.ts` | The matching ladder, IDF scoring, hierarchy resolution |
| `src/consolidate.ts` | Groups matches into one card per work item; corroboration |
| `src/propose.ts` | Comment text, state-change rule, duplicate suppression |
| `src/edit.ts` | Per-line edits, removals, accept-correction, raw rewrite |
| `src/write.ts` | The guarded patch document and markdown → HTML |
| `src/telemetry.ts` | Acceptance recording, per tier |
| `src/vocabulary.ts` | Repairs mis-transcribed product names |
| `src/adoMap.ts` | Azure DevOps REST responses → engine shapes, including hierarchy |
| `data/enrollment.json` | Who is enrolled, their ADO identity, confirmed matches, write target |
| `data/vocabulary.json` | Canonical terms and the mis-transcriptions seen for them |
| `data/transcripts/*.json` | One file per meeting. Add a file to add a meeting — no code change |
| `data/live-workitems.json` | Work items the engine matches against, refreshed by `fetch-workitems.js` |
| `tools/fetch-workitems.js` | Pulls work items from ADO with relations, so hierarchy works |
| `tools/build-cards.js` | Runs the engine over every transcript → `teamsapp/cards.json` |
| `teamsapp/serve.js` | HTTPS host **and** the write backend |
| `teamsapp/index.html` | Meetings home: watch list, transcript upload, tiles |
| `teamsapp/meeting.html` | The card UI for one meeting. All interaction lives here |
| `data/workiq-meetings.json` | Meetings WorkIQ found for you. Refreshed by re-running the query |

---

## 4. The rules the engine follows

Change these only deliberately — each exists because something went wrong without it.

**The matching ladder.** A lower rung never outranks a higher one, however similar the words:

1. `explicit-id` — a work item id spoken aloud
2. `pinned` — an item the person pinned
3. `confirmed-before` — a phrase they previously confirmed means this item
4. `assigned` — assigned to them, matched on what they said
5. `recently-touched` — candidate only, **never** auto-matched
6. `linked` — one hop along a *Related* link from something assigned to you;
   candidate only, **never** auto-matched

Tier 6 exists because a bug filed against your PBI is often what you actually described,
and its title need not resemble the PBI's — so text matching alone can never reach it.
Traversal is deliberately one hop: "related to something related to mine" stops carrying
meaning, and each extra hop widens the candidate set enough to manufacture ambiguity.

`tools/fetch-workitems.js` makes a second pass to pull in linked items, because the WIQL
query returns only items assigned to you. Without that pass the tier is inert on live data.

**Identity is never inferred.** Only enrolled, verified speakers are processed. A display
name is never used to guess an Azure DevOps account — in the tab too, where the check
compares **UPN against `adoIdentity`**. Teams sometimes returns the UPN in the
`displayName` field, so comparing display names silently shows the wrong person nothing.

**It asks rather than guesses.** Two close candidates produce a choice, not a comment.

**Hierarchy.** Naming a child routes there. Naming two children asks. Naming the parent's
own subject keeps the parent. Distinctiveness is measured against siblings, so a partial
capture makes a child's words look more distinctive than they are — `missingChildren()`
reports that.

**Corroboration, threshold 2.** One topic ranking an item first by a narrow margin is
ambiguous; several topics in one meeting independently ranking it first is not a
coincidence. This is what puts six topics on one PBI.

**State is conservative.** Anything outstanding anywhere in a card leaves the state alone.
Finishing one topic never closes the item.

**Vocabulary repairs matching only.** `ACHME SDK` → `AcmeSDK` changes what is *matched*, not
what is *posted*. The card offers the repair; the person takes it deliberately. The engine
never rewrites words attributed to someone.

---

## 5. The guarded write — the part worth understanding

The original design asserted `/rev` with a JSON Patch `test`, but posted through the
`comments` endpoint, which does not accept a patch document. The rev check and the write
were **two separate calls**, so the assertion never protected the comment.

Now it is one document:

```jsonc
PATCH https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}?api-version=7.1
Content-Type: application/json-patch+json
[
  { "op": "test", "path": "/rev", "value": 14 },
  { "op": "add",  "path": "/fields/System.History", "value": "<html>" }
]
```

Both are evaluated atomically, so a newer edit rejects the comment with `VS403351` rather
than being overwritten. A state change rides in the same document.

**The revision asserted is the one displayed.** Cards refresh via `/api/workitem` and
assert what the person saw. Re-reading at approve time would always assert whatever is
current — which is exactly the clobbering the guard exists to prevent. If you ever
"fix" a stale-rev rejection by re-reading first, you have removed the feature.

Three consequences of using `System.History`, all handled in `write.ts`:

- it is an **HTML** field, so markdown is converted — otherwise asterisks render literally
- the `<!-- ado-sync -->` marker must survive, or duplicate suppression breaks next run
- angle brackets in speech are escaped, so nobody can inject markup into a work item

### Prove it still works

```powershell
# post once
$card = ((Get-Content teamsapp/cards.json -Raw | ConvertFrom-Json).sources |
  Where-Object { $_.id -eq 'adosync-demo' }).cards[0]
$body = @{ org='contoso'; project='One'
  workItem=@{ id=$card.workItem.id; rev=$card.workItem.rev; state=$card.workItem.state }
  comment=$card.comment } | ConvertTo-Json -Depth 6
Invoke-RestMethod https://localhost:53000/api/approve -Method Post -Body $body -ContentType application/json

# replay the now-stale revision: expect HTTP 409 and VS403351, item unchanged
Invoke-WebRequest https://localhost:53000/api/approve -Method Post -Body $body `
  -ContentType application/json -SkipHttpErrorCheck | Select-Object -Expand Content
```

---

## 6. Refreshing for new meetings

Two things go stale independently: **work items** and **transcripts**. Refresh both, then
rebuild.

```powershell
cd ado-sync-agent
npm run compile                              # only if src/ changed

node tools/fetch-workitems.js --top 60       # 1. pull current work items from ADO
#   ... add a transcript file, see 6.2 ...   # 2. capture the new meeting
node tools/build-cards.js                    # 3. re-run the engine

# the tab reads cards.json fresh on every load — just reload it in Teams
```

Nothing needs restarting. `serve.js` reads `cards.json` per request with `Cache-Control:
no-store`.

### 6.1 Refreshing work items

```powershell
node tools/fetch-workitems.js
node tools/fetch-workitems.js --project Engineering --identity you@example.com --top 100
```

Authenticates as the signed-in user via Azure CLI, and fetches with `$expand=Relations` so
`parentId` and `childIds` are populated. **The hierarchy rule is inert without them.**

It reports children referenced but not fetched:

```
60 work items written to data/live-workitems.json
  20 have children captured
  48 child item(s) referenced but not fetched: 39238108, …
```

That matters rather than being noise: a child's distinctive words are worked out by
comparing against the siblings *present*, so a partial capture makes terms look more
distinctive than they are. Raise `--top` if the hierarchy matters for the meeting you are
about to process.

### 6.2 Capturing a new meeting

Drop a JSON file into `data/transcripts/`. **No code change** — the generator reads the
whole folder and sorts newest first. Use the existing files as templates.

```jsonc
{
  "id": "standup-0922",                       // unique; becomes the picker value
  "label": "Daily Standup — 22 Sep",          // shown in the dropdown
  "meeting": "Daily Standup",
  "date": "2026-09-22T05:30:00Z",             // the comment is dated from this
  "speaker": "Ankit Kushwaha",
  "blurb": "One line about this transcript.",
  "expect": "What the engine should do with it.",
  "topics": [
    { "title": "Short topic label", "status": "DONE",        "text": "What was said." },
    { "title": "Another topic",     "status": "NEXT",        "text": "What is next." }
  ],
  "exclude": [
    { "text": "Anything that must not reach a work item.", "reason": "Why." }
  ]
}
```

`status` is one of `DONE`, `IN PROGRESS`, `BLOCKED`, `NEXT`. A malformed file is **skipped
with a reason** rather than failing the run — check the output for `SKIPPED`.

Keep `text` as what the person actually said. Do not pre-correct product names: the
vocabulary layer repairs them for matching and offers the fix on the card, and that
separation is deliberate.

### 6.3 Getting the content out of Teams — use WorkIQ

Every meeting-scoped Graph API is blocked for this user with
`403 3003: User does not have access to lookup meeting` — `/me/onlineMeetings`,
`/transcripts`, `getAllTranscripts`, and the Copilot `aiInsights` endpoint alike. The cause
is the meeting **roster**, not permissions, so there is no scope to request that fixes it.

WorkIQ works because it reads through the Copilot content index under **file** permissions,
and the recording was shared into the Teams thread.

An agent with the WorkIQ MCP server should ask roughly this, adjusting the date:

> For the Daily Standup on {DATE}, produce a structured per-speaker breakdown. For each
> person who gave a status update, give me: their FULL display name exactly as it appears
> in the transcript, not a first name; their update in detail as a close paraphrase in
> their own framing, with every distinct topic as a separate item, preserving component
> names, version numbers, tool names, people they coordinated with, and any work item /
> PBI / bug numbers; a classification per topic of DONE, IN PROGRESS, BLOCKED or NEXT; and
> separately, anything that should NOT be copied into a work item comment — personal
> remarks, leave or availability, performance or people comments, unannounced
> organisational news, or anything about another team — as EXCLUDE with a one-line reason.

Four things make that prompt work, and all are worth keeping:

- **Full display names.** Raw transcripts label speakers by first name. WorkIQ resolves
  them from meeting invitee metadata, which is the only safe way — the engine matches
  enrollment on identity and will not guess from a display name.
- **Per topic, not per person.** The engine matches each topic independently, and
  structured topics beat one blob substantially: on the 16 Sep standup it was 6 segments
  instead of 10, with the right item surfaced 6 times out of 6 instead of 4 out of 10.
- **A status per topic.** It drives the tags on the card and the conservative state rule.
- **The EXCLUDE list.** WorkIQ makes the compliance call itself and explains each one.

Then transcribe the answer into a transcript file and run `build-cards.js`.

### 6.4 Refreshing the vocabulary

Ask WorkIQ for canonical spellings and the mis-transcriptions it has **actually seen**,
and tell it explicitly **not to invent variants it cannot substantiate**. It honours that —
it declined to guess variants for FunOS, BOSS, DiskIo and others rather than fabricate
them, which is what makes `data/vocabulary.json` trustworthy.

Cross-check every canonical term against real work item titles before adding it. `AcmeSDK`
returns 4096 hits in `contoso/Engineering` including the repo path `AcmeSDK/AcmeSDK/bin/scripts/`,
while `ACHME SDK` returns 5 unrelated ones — that is the level of evidence to want.

Add entries to `data/vocabulary.json`, then re-run `build-cards.js`. A variant that
tokenises identically to its canonical form (pure capitalisation) is ignored, so those are
documentation rather than repairs.

---

## 7. What Approve, Edit, Pick and Skip actually do

All state lives in `meeting.html`; the engine is reached over HTTP.

| Endpoint | Purpose |
|---|---|
| `POST /api/approve` | The guarded write. Returns `409` + `staleRev` when the revision moved |
| `POST /api/rebuild` | Regenerates the comment after an edit — **in the engine**, so the tab and CLI cannot drift on the state rule |
| `GET /api/workitem` | Current revision, so a card asserts what it shows |
| `GET /api/workitems` | Items assigned to the person, for retargeting |
| `POST /api/decision` | Records the outcome |
| `GET /api/decisions` | Per-tier acceptance summary |

**Editing** offers both models deliberately. Per-line edits keep the structure, so it stays
knowable which update changed and whether a vocabulary repair was accepted. A raw rewrite
is freer but discards that. A per-line edit *after* a raw edit throws `EditConflictError`
rather than silently discarding what the person wrote.

**Telemetry separates agreement from correction.** Accepting a repair the engine itself
proposed is not the engine being wrong. `correctionOnly` and `rawEditRate` are tracked
separately, and acceptance is reported **per tier, never blended** — `explicit-id` at 80%
and `assigned` at 30% average to a meaningless 55%.

---

## 8. Changing things safely

```powershell
npm test                    # 84 evals; they have caught 9 real bugs
node tools/build-cards.js   # after editing transcripts or vocabulary
node out/cli.js             # the engine without any UI
```

Evals worth not deleting, because each encodes a bug that actually happened:

- a child auto-picked on title length when two were named
- the score cap flattening the winning margin
- a parent treated as a folder rather than as work in its own right
- unnamed children displacing named ones in the choice list
- a per-line edit after a raw edit discarding someone's writing
- the comment dated the processing day instead of the meeting

**If a test fails after a change, read it before changing it.** One eval here previously
asserted buggy behaviour — it required the DiskIO case to be ambiguous — and the right fix
was rewriting the test to assert its real intent, not loosening the code.

---

## 9. Honest limitations

- **The backend is a local dev server.** It works because the user is signed into Azure
  CLI on this machine. A deployment needs the on-behalf-of exchange — same identity model,
  different plumbing.
- **`serve.js` must stay running**, or the tab goes blank.
- **Refresh is manual.** `fetch-workitems.js` and `build-cards.js` are run by hand, and the
  transcript still has to be captured from WorkIQ by an agent. Nothing polls or schedules.
- **Transcript capture is agent-assisted, not automated.** §6.3 is a procedure, not a
  script: WorkIQ is an MCP server, so it needs an agent session in the loop.
- **The route depends on someone recording and sharing the meeting.** Transcribe-only,
  unshared, or retention-deleted meetings leave nothing to read.
- **Recap latency versus a daily run is unmeasured.**
- **Hierarchy capture is partial** at default `--top`. 48 referenced children were not
  fetched in the last run, which makes some child terms look more distinctive than they are.
- **Linked items are unreachable.** Bug 39599350 is linked *Related* to 10001001 but is
  assigned to someone else and shares no vocabulary, so text matching will never find it.
- **Telemetry is thin.** A handful of decisions is not evidence for relaxing Approve.
- **PBI 10001002 has test comments** from verification runs.

---

## 10. If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| Blank tab in Teams | serving HTTP, or untrusted cert | run `setup-dev-cert.ps1`, restart `serve.js`, confirm it prints `HTTPS` |
| Buttons do nothing | a native dialog was used | render feedback in-page instead |
| Approve → `VS403351` | the item changed since the card was built | correct behaviour; the card reloads the revision, try again |
| Approve → "could not get a token" | Azure CLI session expired | `az login` |
| Cards show the wrong person nothing | identity compared on display name | compare UPN against `adoIdentity` |
| Teams rejects the zip | unknown manifest property, or nested folder | `node validate-manifest.js`; keep the three files at the archive root |
| No vocabulary prompt appears | `canonicalize` was skipped when building signal terms | repair for matching, keep the original text |
| A new transcript does not appear | malformed JSON, or missing `id` / `topics` | `build-cards.js` prints `SKIPPED <file>: <reason>` |
| Hierarchy never triggers | work items fetched without relations | use `tools/fetch-workitems.js`, not a hand-written capture |
| Tab shows an old meeting | `cards.json` not rebuilt | re-run `node tools/build-cards.js`, then reload the tab |

---

## 11. Related documents

- `TEAMS-APP-PLAN.md` — architecture, what works with evidence, known gaps, phased plan
- `teamsapp/README.md` — packaging and sideloading specifics
- `data/standup-0916-workiq.md` — the WorkIQ structured extraction, including its EXCLUDE list
- `data/vocabulary-research.md` — how the canonical terms were established
