# ADO Sync — status and Teams app plan

_Last updated: 2026-09-17. Tenant settings change; re-verify anything in §3 before relying on it._

Microsoft Global Hackathon 2026 · `proj-710dccff-c6a5-4cbe-a8da-d6cbcb56ff91`

---

## 1. What works today, with evidence

Everything here was exercised against real systems in a working session, not mocked.

| Capability | Evidence |
|---|---|
| **Transcript retrieval** | A real Daily Standup pulled via workiq with speaker attribution across 5 speakers |
| **Work item discovery** | WIQL + batch fetch over `contoso` / `One` / `One\Xstore\WKLD` — 14 items with `rev`, `state`, `assignedTo` |
| **Comment write** | Comment `55810650` posted to PBI 39676281 |
| **Revision guard** | `VS403351: Test Operation for path /rev failed, value 2 was not equal to test value 1` — a genuine server-side rejection |
| **Guarded update (positive case)** | Sandbox renamed across revs 12 → 13 → 14, each asserting the prior `rev` |
| **Priority-ladder matching** | explicit-id and assigned matches resolved; WKLD-doc vs DiskIO correctly returned **ambiguous** rather than guessed |
| **Hierarchy resolution** | A standup line naming the DiskIO profile routes to child Task 10001006 rather than parent PBI 10001005; naming two children asks instead of picking; naming the parent's own subject keeps the parent. Verified against the real 9-child hierarchy under 10001005 and the 2-child hierarchy under 10001001. |
| **WorkIQ as the transcript source** | The 16 Sep standup retrieved without any Graph transcript access. WorkIQ resolved first-name-only speaker labels to full display names from invitee metadata, split prose into per-person topics with DONE / IN PROGRESS / NEXT status, and flagged content that should not be posted to a work item. |
| **Matching on real data** | 6 WorkIQ-shaped topics against 50 live work items: **4 auto-matched correctly, 6 of 6 surfaced, 0 wrong.** |
| **Identity safety** | 4 of 5 speakers returned `UNRESOLVED` because they are not enrolled — display names are never used to infer an ADO identity |
| **Duplicate suppression** | Verified against the actual posted comment, including after the comment marker was renamed |
| **Learning loop** | Confirm a phrase once → the same update matches at tier `confirmed-before` on the next run |
| **Receipt** | `out/receipt.md` with updated / skipped / unresolved and work item links |
| **Test coverage** | 37 evals. They have caught seven real bugs: recently-touched auto-matching, filler leaking into updates, a tier-band overlap, a child auto-picked on title length when two were named, unnamed children displacing named ones in the choice list, the score cap flattening the winning margin, and a parent treated as a folder rather than as work in its own right. |

---

## 2. What does not work yet

### 2.1 The comment write — fixed 2026-09-18

The original design asserted `/rev` with a JSON Patch `test` operation but posted the body through the `comments` endpoint, which does not accept a patch document. The rev check and the write were **two separate calls**, so the assertion never protected the comment it was meant to protect, and anything landing between them was lost.

`write.ts` now emits one patch document per work item:

```jsonc
PATCH https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}?api-version=7.1
Content-Type: application/json-patch+json
[
  { "op": "test", "path": "/rev", "value": 14 },
  { "op": "add",  "path": "/fields/System.History", "value": "<html>" }
]
```

The server evaluates both atomically, so a stale revision rejects the comment with `VS403351` rather than overwriting a newer human edit. A state change rides in the same document, covered by the same assertion instead of racing behind it.

Three consequences of the switch, all handled and covered by evals:

- **`System.History` is an HTML field**, not markdown. The comment is composed as markdown for the card, so the subset actually emitted is converted — otherwise asterisks render literally in the Discussion tab.
- **The dedupe marker must survive** into the posted body, or duplicate suppression breaks on the next run.
- **Angle brackets in what someone said are escaped**, so speech cannot inject markup into a work item.

### 2.2 Scoring — fixed 2026-09-17

`textBonus` used to clamp at `Math.min(1, overlapScore(...))`, so the correct item tied with boilerplate matches at exactly 500. Measured against 50 live work items and the real 16 Sep update, the right PBI ranked **first in 4 of 5** segments and auto-matched in **0 of 5**.

Two causes, both now addressed in `match.ts`:

- **The clamp discarded the winning margin.** Ranking is now relative: candidates are scored by *matched IDF mass* normalised against the strongest candidate, so first place keeps its lead instead of saturating. Candidacy stays absolute (`MIN_TEXT_SCORE` on raw overlap), so a weak field is never promoted just for being the best of a bad lot.
- **Boilerplate drowned the signal.** `[NODE WKLD]` prefixes 16 of 50 titles and `wkld` appears in 24, so "[NODE WKLD] Object Resiliency" scored a perfect 1.0 on prefix alone. Inverse document frequency over the candidate titles makes `parity` and `cpu` count for more than `wkld`.

The text bonus still cannot leave its tier band, and identical titles still read as a tie — both covered by evals.

**Result on the same live data, with WorkIQ-shaped input: 4 of 6 topics auto-matched correctly, 6 of 6 surfaced, 0 wrong.**

### 2.3 One update becomes many cards — fixed 2026-09-18

Cards are now per work item, not per sentence. `consolidate.ts` groups matches by speaker and work item and emits one card carrying many updates, with a single combined comment. On the real 16 Sep standup: **6 WorkIQ topics in, 1 card out** on PBI 10001001.

Two rules make that safe:

- **Repetition is evidence.** One topic ranking an item first by a narrow margin is genuinely ambiguous; several topics in the same meeting independently ranking it first is not a coincidence. Corroboration settles what no single topic could. A lone unsettled topic still asks.
- **The state rule stays conservative across the group.** Anything outstanding anywhere in the group leaves the state alone, so finishing one topic never closes the item.

Cards are never merged across people, and the comment is dated the meeting rather than the day it was processed.

### 2.4 Transcription mangles domain vocabulary — fixed 2026-09-18

The 16 Sep transcript rendered `AcmeSDK` as "ACME SDK" and "ACMES DK". Checked against ADO: `AcmeSDK` returns **4096** hits including the repo path `AcmeSDK/AcmeSDK/bin/scripts/`, while "ACME SDK" returns 5 unrelated ones. Because the matcher keys on signal terms, a mangled product name does not merely weaken a match — it deletes the most discriminating word in the update.

`vocabulary.ts` repairs known mis-transcriptions before matching, driven by `data/vocabulary.json`. WorkIQ sourced the variants from the team's own standup transcripts and **declined to invent any it could not substantiate**, which is the behaviour this needs. Each canonical term was cross-checked against work item titles.

The strongest find was not AcmeSDK but HWLC: the same transcript contains both the corrupt form "hardware lock" and the expansion "HWLC … hardware log collector", and ADO confirms it with PBI 36224176 *"[xPF] Enabling HWLC (Hardware Log Collector) on DPU clusters"*.

**Decided: corrections apply to matching only.** The words a person said are never rewritten in a comment posted under their name. The card shows *heard "ACME SDK" — matched as AcmeSDK. Accept into the text?* so the correction is taken deliberately. An eval asserts the posted comment still quotes what was actually said.

### 2.5 Linked items are unreachable

In that same update, *"I filed a bug with Tony… he has fixed it"* refers to Bug **39599350**, which is assigned to Tony Alexander and linked **Related** to the matched PBI. The engine returned `unresolved`: tier-4 only considers items assigned to you, and tier-5 requires title overlap that `wkld_api_close_device… shard VP… teardown` will never produce. Link traversal reaches it; text matching cannot.

### 2.6 Everything else

| Gap | Detail |
|---|---|
| Input is a fixture | `data/transcript.json` was hand-assembled from a real transcript. Nothing pulls it live. |
| Engine is isolated | The CLI emits `write-actions.json`; an agent executes them via MCP. A Node process cannot call MCP servers itself. |
| Cards are terminal output | ASCII boxes, not Teams adaptive cards |
| No enrollment flow | `data/enrollment.json` is edited by hand |
| No scheduling | No daily run, no catch-up for late transcripts |
| Modes incomplete | review-only and comment work; permitted field updates are unimplemented |
| Receipts are not delivered | Written to disk, not sent privately to the user |

---

## 3. Transcript access — probed 2026-09-17

### 3.0 Resolution: one root cause, and a route around it

Every **meeting-scoped** Graph API fails with the same error, and the **content-scoped** route works. That is the whole picture:

| Route | Result |
|---|---|
| `GET /me/onlineMeetings?$filter=JoinWebUrl eq …` | `403` — `3003: User does not have access to lookup meeting` |
| `GET /me/onlineMeetings/{id}/transcripts` | `403` — same `3003` |
| `GET /me/onlineMeetings/getAllTranscripts(...)` | `400` — *"The userId must match organizerId."* |
| `GET /copilot/users/{me}/onlineMeetings/{id}/aiInsights` | `403` — same `3003` |
| `GET /copilot/users/{organizer}/onlineMeetings/{id}/aiInsights` | `403` — *"User Id must match the api caller when called in delegated mode"* |
| **WorkIQ / Copilot retrieval over meeting content** | **200 — full recap and speaker-attributed transcript text** |

The meeting APIs enforce a **meeting roster ACL**; the retrieval path enforces **file permissions** on the recording, which Alex shared into the Daily Standup thread. The recording drive item is readable (`GET /drives/{id}/items/{id}` returns 200). That is why one works and the others do not.

**Consequence: transcript ingestion no longer needs a tenant admin.** The Phase 0 blockers below remain true for the Graph transcript API, but that API is no longer on the critical path.

### 3.1 What WorkIQ actually returns

Two useful shapes, both verified against the 16 Sep standup:

- **Speaker-attributed transcript text** via `retrieve` with the `Meetings` capability — literally `"Kushal T S: …last week I was working on a couple of PRs…"`. Truncated head-and-tail with `[...]` elision, so the middle of a long meeting is lost.
- **The AI meeting recap** via `retrieve` with `strategy: "grounding"` — per-person topic summaries plus explicit action items: *"CPU-DPU Metrics: Collect DPU metrics using the fixed ACME SDK, compare them with CPU metrics, and add the comparison to the existing dashboard to assess parity. **(Ankit)**"*. Not truncated, already de-filtered, already attributed.

The recap is the better input. It is closer to what the engine wants than raw speech is, and it survives the attribution gaps noted in §3.5.

**Proven end to end:** recap → `normalize()` → `matchAll()` → cards, against 50 live work items, with the correct PBI 10001001 surfaced in 3 of 5 segments and the hierarchy rule firing on real data. No writes, no admin change, no Graph transcript access.

### 3.2 The productionizable API

WorkIQ is an MCP server, not something a Teams tab can call. The documented API behind the same capability is the **[Microsoft 365 Copilot Retrieval API](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/retrieval/overview)**, which "retrieve[s] relevant text chunks from SharePoint, OneDrive, and Copilot connectors" and preserves per-user permissions — *"individuals can only get results from the content they are allowed to access."*

Also worth noting for later: the **Meeting Insights API** (`GET /copilot/users/{userId}/onlineMeetings/{meetingId}/aiInsights`) returns exactly the recap structure this product wants, and its stated scenario is *"Link these with project management tools."* It needs only a Microsoft 365 Copilot licence — which this user has — but it is **meeting-scoped, so it is blocked by the same `3003`** until the roster is fixed. It becomes the cleanest option the moment that happens.

### 3.3 The attendee assumption did not hold

The plan previously rested on this sentence from *Get callTranscript*:

> "This API is also available to users who are part of the meeting calendar invite, which applies to both private chat meetings and channel meetings."

The sentence is real and still present — but it governs **fetching a transcript you can already address**. It is **absent from the v1.0 List transcripts page** and exists only in beta. It does not help you *resolve the meeting*, and that is where every probe died.

No Learn page states the `joinWebUrl` filter is organiser-only; that behaviour is established by Microsoft Q&A threads and a GitHub issue closed as *not planned*. The reported pattern matches this case: an attendee of a **recurring** meeting who was not on the original participant roster cannot resolve the `onlineMeeting` at all.

### 3.4 Still true, and still admin-gated — but now optional

These block the Graph transcript and Meeting Insights APIs only. Pursue them to unlock the cleaner route, not to unblock the demo.

| Gate | Status |
|---|---|
| Meeting roster — organiser forwards the full series, or PATCHes the user in as `attendee` | The single root cause of every `3003` above |
| `OnlineMeetingTranscript.Read.All` needs **admin consent even delegated** | Not developer self-consent |
| Tenant toggle `EnableGraphTranscriptAccess` is **off by default** | `Set-CsTeamsMeetingConfiguration` |
| Speaker attribution disabled → `text/vtt` returns `SpeakerAttributionNotAllowed` | Fallback drops speaker names and breaks per-person matching |

### 3.6 What the new route costs — blockers it introduces

The retrieval route removes an admin dependency and adds these. Two are structural.

| # | Blocker | Evidence | Severity |
|---|---|---|---|
| 1 | **Retrieval returns chunks, not whole transcripts** | The 16 Sep hit came back with `truncationInfo: Content has been truncated` and `[...]` elisions cutting mid-word: *"ACMES DK version that WKLD was cons [...]"*. A more targeted query returned passages from a **different meeting**. | **Structural** |
| 2 | **The good recap may be outside the public API's scope** | The per-person action-item recap came from WorkIQ capability `Meetings`. The documented Retrieval API covers *"SharePoint, OneDrive, and Copilot connectors"*. The raw transcript **is** OneDrive-resident and reachable under `OneDriveAndSharePoint` alone; the recap surface is unconfirmed. | **Structural** |
| 3 | Every user needs a **Microsoft 365 Copilot licence** | Both the Retrieval and Meeting Insights APIs sit in the Copilot namespace. | Adoption cost |
| 4 | Source content carries a **sensitivity label** | The hit returned `General — "Business data which is NOT meant for public consumption"`. Copying it into an ADO comment needs a deliberate call. | Compliance |
| 5 | Recap attributes by **first name only** | *"(Ankit)"*, *"Jitendra and Ankit discussed…"*. The engine matches on `teamsDisplayName` and never infers identity from a display name. | Correctness |
| 6 | Recap is **prose, not per-speaker turns** | Single bullets span two people. The 17 Sep end-to-end run worked only because utterances were hand-shaped. | Unbuilt work |
| 7 | Depends on a **shared recording existing** | Access works because Alex recorded and the `.mp4` was shared into the thread. Transcribe-only, unshared, or retention-deleted meetings leave nothing. | Fragility |
| 8 | **Recap latency** vs a daily run | Index freshness lags the meeting; a run straight after standup may find nothing. | Unmeasured |

**Blocker 1 is the important one.** The Retrieval API answers *"which passages relate to this query"*. The engine asks *"everything this person said in this meeting"*. Those are different operations, and no amount of configuration turns one into the other. Options: per-person targeted queries stitched together, or bypass retrieval and read the transcript file directly by `driveId`/`itemId` — the drive item is already proven readable (`GET /drives/{id}/items/{id}` → 200).

Custom app upload is available in this tenant, the standup is a calendar-associated scheduled meeting, and the transcript demonstrably exists.

One caution the live data surfaced: the 17 Sep standup contained **no speaker turn attributed to Ankit at all**, and one participant appeared only as an unidentified "Speaker 1". Attribution is imperfect even when enabled — another reason to prefer the recap, where the summariser resolves speakers the raw transcript left anonymous.

---

## 4. Research findings

Sourced from Microsoft Learn, 2026-09-17.

| Question | Answer |
|---|---|
| Can an **attendee** read a transcript, or only the organiser? | **Superseded — see §3.** The sentence is real but governs fetching a transcript you can already address, not resolving the meeting. Both live probes failed at meeting lookup with `3003`. |
| Which delegated scope? | `OnlineMeetingTranscript.Read.All` only. `OnlineMeetings.Read/ReadWrite` do **not** grant transcript access. |
| Can a tab get a Graph token without a backend? | **No.** `getAuthToken()` yields only OpenID scopes — *"isn't used for other Graph scopes"*. A Graph token needs an on-behalf-of exchange, which requires a confidential client. |
| Adaptive Cards in a tab? | Yes, via the `adaptivecards` JS SDK rendered client-side. Not the native Teams pipeline, which is bot/message-extension only. |
| ADO auth from a web app? | **Entra OAuth (MSAL)**. *"Use personal access tokens sparingly, and only when Microsoft Entra ID isn't available."* |
| Transcript format | WebVTT with `<v Speaker>` voice tags — exactly the shape `normalize()` consumes. `.docx` via Graph is deprecated. |
| Tooling | **Microsoft 365 Agents Toolkit v5** (formerly Teams Toolkit). Note the **TeamsFx SDK is deprecated**, community support only until Sept 2026. |

Key sources:
- [Get callTranscript](https://learn.microsoft.com/en-us/graph/api/calltranscript-get?view=graph-rest-1.0)
- [Tab SSO overview](https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/authentication/tab-sso-overview)
- [ADO authentication guidance](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/authentication-guidance?view=azure-devops)
- [Work item update (JSON Patch)](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1)

---

## 5. Target architecture

**Personal tab + thin backend. No bot surface, but a bot identity for writes.**

```
Teams personal tab  ──getAuthToken──▶  backend  ──OBO──▶  Copilot Retrieval API
       ▲                                  │                (meeting recap + transcript chunks)
       │                                  │
       │                                  ├──▶  ADO REST  (work items, guarded write)
       └──── adaptive cards ──────────────┘
                                          └──▶  existing engine (unchanged)
```

| Decision | Rationale |
|---|---|
| Tab, not bot | A bot only earns its cost for unsolicited proactive pings. This is an open-it-and-approve flow. A bot adds an Azure Bot resource, a second identity, and an always-on endpoint. |
| Backend required | Forced by the OBO constraint above, not a preference |
| **Copilot Retrieval API, not the transcript API** | §3 — every meeting-scoped API is blocked by the meeting roster ACL; retrieval goes through file permissions and works today with no admin change. Swap to the Meeting Insights API if the roster is ever fixed; it returns the same recap shape more directly. |
| Entra OAuth for ADO | PATs are long-lived bearer secrets and explicitly discouraged |
| **Bot identity for the write, not the user's** | Decided 2026-09-18. ADO supports Entra **service principals and managed identities** as first-class org identities with short-lived tokens. Constraints: a **Project Collection Administrator must explicitly add it** — group membership alone grants nothing — it consumes a licence seat, it must be in the same tenant, and the **service principal object ID from Enterprise applications** is required, not the app registration object ID. Falls back to the user's identity via OBO if the PCA step cannot be arranged. |
| **Approve stays manual** | Decided 2026-09-18. Automation is earned, not assumed: relax it only once telemetry shows how often high-confidence suggestions are approved without editing, split by tier. |

The engine is reused unchanged. It is framework-agnostic TypeScript that takes transcripts and work items in and emits proposals — the Teams app is a shell around it.

---

## 6. Phased plan

| Phase | Work | Success criterion | Est. |
|---|---|---|---|
| **0** | **Resolved — see §3.0.** Transcript arrives via Copilot retrieval, not the transcript API. Optionally chase the roster fix to unlock Meeting Insights. | Already proven end to end | done |
| **1** | Engine hardening: scoring fix (§2.2), card consolidation (§2.3), recap parser, revision-guarded comment via `System.History` | Eval: real recap → cards. Eval: stale rev blocks the comment. Eval: 10001001 auto-matches. | 1 day |
| **2** | ATK v5 scaffold, manifest, icons, sideload | Empty tab opens inside Teams | ½ day |
| **3** | Auth spine: Entra registration, `getAuthToken` → OBO | Tab prints your display name from Graph | 1–2 days |
| **4** | Transcript in: Copilot Retrieval API → recap parser → engine | Tab shows real cards from this morning's standup | ½ day |
| **5** | Write out: ADO token via OBO, Approve → guarded patch | Comment lands on 39676281; stale rev rejected | ½ day |
| **6** | Package, sideload, record | Demo-ready zip | ½ day |

**Phase 3 is the risk again.** With Phase 0 resolved, on-behalf-of misconfiguration is once more the thing most likely to cost days.

### Sequencing advice

- **Phase 0 is no longer a gate.** Transcript content is reachable today through Copilot retrieval, under file permissions rather than the meeting roster ACL. The admin conversation is now an optimisation, not a prerequisite.
- **Phase 1 is the highest-value work left.** It fixes correctness gaps in code that ships today, and the scoring fix is what turns "here are three choices" into "here is the item, and here is why".
- **Phases 2–6 need roughly 3–4 focused days** if Phase 3 behaves.

### Calendar reality

| Date | Milestone |
|---|---|
| Sep 19 | Azure Storage IDC registration |
| Sep 21, 11:59 PM PT | Global Hackathon submission (video already uploaded) |
| Sep 23 | Bengaluru Science Fair, Ferns MPR |

The submission is already complete and the video is uploaded. The Teams app is an enhancement to the Science Fair demo, not a requirement for it — and there is a real risk of ending Sep 23 with a half-wired tab instead of the clean working demo that exists today.

---

## 7. Housekeeping

- Sandbox PBI **39676281** is live in `contoso`, tagged `Hackathon2026; ADOSync; Sandbox`, currently rev 14. Delete it after the Science Fair.
- `data/workitems.json` and `data/comments.json` deliberately reflect **what is actually in ADO**, including older naming. They are captured evidence, not fixtures to be tidied. The `parentId` / `childIds` on 10001005 and 10001006 are the real hierarchy, captured 2026-09-17; the remaining eight children of 10001005 are referenced by id but were not part of the original capture.
- Nothing in this session wrote to ADO. All matching work was read-only.


