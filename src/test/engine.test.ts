import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { normalize, segmentTopics, extractExplicitIds, isChatter, signalTerms } from "../normalize";
import { matchOne } from "../match";
import { buildProposal, isDuplicate } from "../propose";
import { consolidate } from "../consolidate";
import { canonicalize, validateVocabulary } from "../vocabulary";
import { buildPatch, markdownToHtml, isStaleRevRejection, buildWriteActions } from "../write";
import { recordDecision, summarise, qualifiesForAutomation } from "../telemetry";
import { applyEdits, wasEdited, onlyAcceptedCorrections, EditConflictError } from "../edit";
import { toWorkItem, missingChildren, parseIdentity } from "../adoMap";
import { derivePhrase, upsertConfirmedMatch } from "../resolve";
import { parseVtt, parseMarkdown, vttSpeakers, parseTranscriptFile } from "../parse";
import { Enrollment, SpeakerUpdate, Transcript, VocabularyFile, WorkItem } from "../types";

const ME: Enrollment = {
  teamsDisplayName: "Ankit Kushwaha",
  adoIdentity: "you@example.com",
  verifiedAt: "2026-09-15T05:30:00Z",
  mode: "review-only",
  paused: false,
  pinnedWorkItemIds: [],
  confirmedMatches: [
    { phrase: "wkld documentation", workItemId: 100, confirmedAt: "2026-09-12T09:00:00Z" },
  ],
  excludedMeetingTitles: [],
};

const wi = (o: Partial<WorkItem> & { id: number; title: string }): WorkItem => ({
  rev: 1,
  type: "Product Backlog Item",
  state: "Active",
  assignedTo: "you@example.com",
  assignedToName: "Ankit Kushwaha",
  changedDate: new Date().toISOString(),
  ...o,
});

const ITEMS: WorkItem[] = [
  wi({ id: 100, title: "WKLD Documentation" }),
  wi({ id: 101, title: "DiskIO Profile Documentation", type: "Task" }),
  wi({ id: 102, title: "[NODE WKLD] AI Features Support", type: "Feature" }),
  wi({ id: 200, title: "Someone else's telemetry work", assignedTo: "teammate@example.com", assignedToName: "Other" }),
];

const upd = (text: string, enrolled = true) =>
  normalize(
    { meeting: {} as any, utterances: [{ speaker: "Ankit Kushwaha", text }] } as Transcript,
    enrolled ? [ME] : []
  )[0];

// ---- identity safety ----

test("an unenrolled speaker is never matched", () => {
  const u = upd("I finished the AI features support work.", false);
  const r = matchOne(u, ITEMS, undefined);
  assert.equal(r.kind, "unresolved");
  assert.match((r as any).reason, /not enrolled/);
});

test("a paused enrollee is never matched", () => {
  const paused = { ...ME, paused: true };
  const u = normalize(
    { meeting: {} as any, utterances: [{ speaker: "Ankit Kushwaha", text: "AI features support is started." }] } as Transcript,
    [paused]
  )[0];
  const r = matchOne(u, ITEMS, paused);
  assert.equal(r.kind, "unresolved");
});

// ---- priority ladder ----

test("an explicit id outranks every text match", () => {
  const u = upd("On PBI 102 I did some documentation work on WKLD documentation.");
  const r = matchOne(u, ITEMS, ME);
  assert.equal(r.kind, "matched");
  assert.equal((r as any).candidate.item.id, 102);
  assert.equal((r as any).candidate.tier, "explicit-id");
});

test("a pinned item outranks a plain assigned match", () => {
  const pinned = { ...ME, pinnedWorkItemIds: [102] };
  const u = upd("Worked on the DiskIO profile documentation today.");
  const r = matchOne(u, ITEMS, pinned);
  assert.equal(r.kind, "matched");
  assert.equal((r as any).candidate.tier, "pinned");
});

test("an item assigned to someone else never wins on text alone", () => {
  const u = upd("I spent the day on telemetry work for the team.");
  const r = matchOne(u, ITEMS, ME);
  if (r.kind === "matched") {
    assert.notEqual((r as any).candidate.item.id, 200);
  }
});

test("genuinely close candidates return a choice rather than a guess", () => {
  // No confirmed match here, so two assigned items compete on text alone and
  // land within the ambiguity margin.
  const noHistory = { ...ME, confirmedMatches: [] };
  const u = upd("Documentation work continued today.");
  const r = matchOne(u, ITEMS, noHistory);
  assert.equal(r.kind, "ambiguous");
  const ids = (r as any).choices.map((c: any) => c.item.id);
  assert.ok(ids.includes(100) && ids.includes(101));
});

test("a confirmed match resolves what would otherwise be ambiguous", () => {
  const u = upd("WKLD documentation is mostly done, I still need the DiskIO profile section.");
  const withHistory = matchOne(u, ITEMS, ME);
  assert.equal(withHistory.kind, "matched");
  assert.equal((withHistory as any).candidate.item.id, 100);
  assert.equal((withHistory as any).candidate.tier, "confirmed-before");
});

test("tier bands never overlap, however strong the text match", () => {
  // A long title that a user echoes verbatim used to push the assigned tier
  // past confirmed-before and close to pinned. The text bonus is now capped.
  const wordy = wi({
    id: 300,
    title: "One Two Three Four Five Six Seven Eight Nine Ten",
  });
  const echo = upd("One two three four five six seven eight nine ten.");
  const r = matchOne(echo, [wordy], { ...ME, confirmedMatches: [] });
  assert.equal(r.kind, "matched");
  const score = (r as any).candidate.score;
  assert.ok(
    score < 600,
    `assigned scored ${score}, which reaches the confirmed-before band`
  );
});

test("nothing relevant yields unresolved, not a low-confidence guess", () => {
  const u = upd("I was in interviews all day and did not touch any tickets.");
  const r = matchOne(u, ITEMS, ME);
  assert.equal(r.kind, "unresolved");
});

// ---- state discipline ----

test("finishing one activity does not close the work item", () => {
  const p = buildProposal(
    "I finished the parser change; performance validation is still pending.",
    ITEMS[0]
  );
  assert.equal(p.stateChange, null);
  assert.match(p.stateRationale, /outstanding/);
});

test("a clean completion does propose a state change", () => {
  const p = buildProposal("The WKLD documentation is completed.", ITEMS[0]);
  assert.deepEqual(p.stateChange, { from: "Active", to: "Done" });
});

test("an already-Done item is never re-proposed as Done", () => {
  const done = wi({ id: 103, title: "Closed thing", state: "Done" });
  const p = buildProposal("That one is finished.", done);
  assert.equal(p.stateChange, null);
});

test("the next action is extracted from what was actually said", () => {
  const p = buildProposal(
    "Parser work is done; I still need to validate performance.",
    ITEMS[0]
  );
  assert.match(p.nextAction, /validate performance/i);
});

// ---- dedupe ----

test("an identical update is suppressed", () => {
  const a = buildProposal("Wired the revision guard.", ITEMS[0]);
  assert.equal(isDuplicate(a.commentMarkdown, [a.commentMarkdown]), true);
});

test("a genuinely new update is not suppressed", () => {
  const a = buildProposal("Wired the revision guard.", ITEMS[0]);
  const b = buildProposal("Shipped duplicate suppression and the receipt view.", ITEMS[0]);
  assert.equal(isDuplicate(b.commentMarkdown, [a.commentMarkdown]), false);
});

// ---- normalisation ----

test("filler is not treated as a status update", () => {
  assert.equal(isChatter("Hey, good morning."), true);
  assert.equal(isChatter("Yeah, yeah, please go ahead."), true);
  assert.equal(isChatter("I finished the parser change and opened a PR."), false);
});

test("a multi-topic turn becomes one segment per topic", () => {
  const segs = segmentTopics(
    "WKLD documentation is nearly done. I also picked up the AI features support work. Nothing else."
  );
  assert.ok(segs.length >= 2);
});

test("spoken work item ids are recognised in several forms", () => {
  assert.deepEqual(extractExplicitIds("see PBI 39676281 please"), [39676281]);
  assert.deepEqual(extractExplicitIds("that's #12345"), [12345]);
  assert.deepEqual(extractExplicitIds("no ids here"), []);
});

// ---- interactive learning loop ----

test("derivePhrase prefers text shared by the update and chosen title", () => {
  const phrase = derivePhrase(
    "WKLD documentation is mostly done, I still need the DiskIO profile section.",
    ITEMS[0]
  );
  assert.equal(phrase, "wkld documentation");
  assert.match("wkld documentation is mostly done", new RegExp(phrase));
  assert.match(ITEMS[0].title.toLowerCase(), new RegExp(phrase));
});

test("derivePhrase never returns an empty or tiny phrase", () => {
  const awkward = derivePhrase("OK, I did it.", wi({ id: 300, title: "Q2 FYI" }));
  assert.ok(awkward.length >= 4);
});

test("a confirmed phrase makes the next matching pass learn the chosen item", () => {
  const enrollment: Enrollment = { ...ME, confirmedMatches: [] };
  const u = upd("WKLD documentation is mostly done, I still need the DiskIO profile section.");

  // On text alone this reads as the DiskIO task: "diskio" and "profile" are the
  // rare words here, while "documentation" is shared with the parent.
  const before = matchOne(u, ITEMS, enrollment);
  assert.equal(before.kind, "matched");
  assert.equal((before as any).candidate.item.id, ITEMS[1].id);
  assert.equal((before as any).candidate.tier, "assigned");

  // The person says it belongs on the parent instead. That correction has to
  // outrank the text match on every later run, or the learning loop is useless.
  const phrase = derivePhrase(u.text, ITEMS[0]);
  const learned: Enrollment = {
    ...enrollment,
    confirmedMatches: [{ phrase, workItemId: ITEMS[0].id, confirmedAt: "2026-09-15T09:00:00Z" }],
  };
  const after = matchOne(u, ITEMS, learned);

  assert.equal(after.kind, "matched");
  assert.equal((after as any).candidate.item.id, ITEMS[0].id);
  assert.equal((after as any).candidate.tier, "confirmed-before");
});

// ---- scoring: the winning margin has to survive ----

test("a clearly better title wins instead of tying at the cap", () => {
  // Real shape from contoso/Engineering. "[NODE WKLD]" prefixes most of the area's
  // titles, so boilerplate alone used to score a perfect 1.0 and tie with the
  // genuinely correct item. Only "perf", "cpu" and "parity" actually discriminate.
  const real: WorkItem[] = [
    wi({ id: 700, title: "[NODE WKLD] Perf parity between HBADevTest, CPU & NODE WKLD" }),
    wi({ id: 701, title: "[NODE WKLD] Object Resiliency" }),
    wi({ id: 702, title: "[NODE WKLD] AI Features Support" }),
    wi({ id: 703, title: "[NODE WKLD] Add Agency Support" }),
    wi({ id: 704, title: "[NODE WKLD] Standalone WKLD funos image build" }),
  ];
  const u = upd("I was working on the CPU versus NODE WKLD performance parity.");
  const r = matchOne(u, real, { ...ME, confirmedMatches: [] });

  assert.equal(r.kind, "matched", "boilerplate-only titles should not tie with the real match");
  assert.equal((r as any).candidate.item.id, 700);
});

test("the text bonus still cannot escape its tier band", () => {
  const real: WorkItem[] = [
    wi({ id: 700, title: "[NODE WKLD] Perf parity between HBADevTest, CPU & NODE WKLD" }),
    wi({ id: 701, title: "[NODE WKLD] Object Resiliency" }),
  ];
  const u = upd("I was working on the CPU versus NODE WKLD performance parity.");
  const r = matchOne(u, real, { ...ME, confirmedMatches: [] });
  const score = (r as any).candidate.score;
  assert.ok(score < 600, `assigned scored ${score}, which reaches the confirmed-before band`);
});

test("candidates with nothing to separate them still read as a tie", () => {
  // Identical titles carry identical weight, so normalising must not manufacture
  // a winner out of nothing.
  const twins: WorkItem[] = [
    wi({ id: 800, title: "Telemetry pipeline hardening" }),
    wi({ id: 801, title: "Telemetry pipeline hardening" }),
  ];
  const u = upd("I spent today on telemetry pipeline hardening.");
  const r = matchOne(u, twins, { ...ME, confirmedMatches: [] });
  assert.equal(r.kind, "ambiguous");
});

test("relative ranking never promotes the best of an irrelevant field", () => {
  // Nothing here is related to the update. Normalising scores against the
  // strongest candidate must not turn a weak field into a confident match.
  const unrelated: WorkItem[] = [
    wi({ id: 900, title: "Update XStore version" }),
    wi({ id: 901, title: "Remove ETL Replay code" }),
  ];
  const u = upd("I was in interviews all day and did not touch any tickets.");
  const r = matchOne(u, unrelated, { ...ME, confirmedMatches: [] });
  assert.equal(r.kind, "unresolved");
});

test("upserting the same phrase updates without duplicating", () => {
  const enrollment = {
    enrolled: [{ ...ME, confirmedMatches: [] }],
    writeTarget: { sandboxWorkItemId: 1, reason: "test" },
  };

  assert.equal(
    upsertConfirmedMatch(enrollment, ME.teamsDisplayName, "WKLD Documentation", 100, "2026-09-15T09:00:00Z"),
    true
  );
  assert.equal(
    upsertConfirmedMatch(enrollment, ME.teamsDisplayName, "wkld documentation", 101, "2026-09-15T10:00:00Z"),
    true
  );

  assert.deepEqual(enrollment.enrolled[0].confirmedMatches, [
    { phrase: "wkld documentation", workItemId: 101, confirmedAt: "2026-09-15T10:00:00Z" },
  ]);
});

// ---- hierarchy: which level does the update belong on? ----
//
// Shapes and titles below are the real hierarchy under PBI 10001001 in
// contoso/Engineering, captured 2026-09-17. Ids are localised to keep these evals
// independent of the fixture in data/.

const PARENT = 500;
const CHILD_CMR = 501;
const CHILD_SSD = 502;

const HIER: WorkItem[] = [
  wi({
    id: PARENT,
    title: "[NODE WKLD] Perf parity between HBADevTest, CPU & NODE WKLD",
    state: "Committed",
    childIds: [CHILD_CMR, CHILD_SSD],
  }),
  wi({ id: CHILD_CMR, title: "CMR HDD WKLD Parity", type: "Task", parentId: PARENT }),
  wi({ id: CHILD_SSD, title: "SSD WKLD Parity", type: "Task", state: "To Do", parentId: PARENT }),
];

/** Parent wins on tier so the hierarchy check is what decides the level. */
const PARENT_CONFIRMED = {
  ...ME,
  confirmedMatches: [
    { phrase: "perf parity", workItemId: PARENT, confirmedAt: "2026-09-12T09:00:00Z" },
  ],
};

/**
 * Confirmed on vocabulary the whole family shares, so the phrase itself names
 * neither level. "perf parity" cannot be used for this: "perf" belongs to the
 * parent alone, so matching on it would always name the parent.
 */
const PARENT_CONFIRMED_NEUTRAL = {
  ...ME,
  confirmedMatches: [
    { phrase: "wkld parity", workItemId: PARENT, confirmedAt: "2026-09-12T09:00:00Z" },
  ],
};

test("a child that clearly fits better than its parent is taken without asking", () => {
  const u = upd("On perf parity, I finished the SSD WKLD parity runs.");
  const r = matchOne(u, HIER, PARENT_CONFIRMED);
  assert.equal(r.kind, "matched");
  assert.equal((r as any).candidate.item.id, CHILD_SSD);
  assert.match((r as any).candidate.reason, /child of 500/i);
  assert.match((r as any).candidate.reason, /"ssd"/i);
});

test("naming two children asks rather than picking the longer title", () => {
  // Both children are named. "CMR HDD WKLD Parity" carries two distinctive
  // tokens to "SSD WKLD Parity"'s one, so any similarity score hands it the win
  // on title length alone. Naming both is not a preference for either.
  const u = upd("On perf parity, I looked at SSD and CMR HDD parity.");
  const r = matchOne(u, HIER, PARENT_CONFIRMED);
  assert.equal(r.kind, "ambiguous");
  const ids = (r as any).choices.map((c: any) => c.item.id);
  assert.ok(ids.includes(CHILD_SSD) && ids.includes(CHILD_CMR));
  assert.match((r as any).reason, /mentioned 2 of the child items/i);
});

test("children the update named are offered ahead of ones it did not", () => {
  // A parent can have more children than fit in the choice list, so an unnamed
  // sibling must never displace one the person actually mentioned.
  const many: WorkItem[] = [
    wi({ id: 600, title: "WKLD Documentation", childIds: [601, 602, 603, 604] }),
    wi({ id: 601, title: "DiskIO Profile Documentation", type: "Task", parentId: 600 }),
    wi({ id: 602, title: "HbaIo Profile Documentation", type: "Task", parentId: 600 }),
    wi({ id: 603, title: "SsdIo Profile Documentation", type: "Task", parentId: 600 }),
    wi({ id: 604, title: "MemBw Profile Documentation", type: "Task", parentId: 600 }),
  ];
  const docs = {
    ...ME,
    confirmedMatches: [
      { phrase: "wkld documentation", workItemId: 600, confirmedAt: "2026-09-12T09:00:00Z" },
    ],
  };
  const u = upd("On WKLD documentation I wrote up the HbaIo and SsdIo profile sections.");
  const r = matchOne(u, many, docs);
  assert.equal(r.kind, "ambiguous");
  const ids = (r as any).choices.map((c: any) => c.item.id);
  assert.ok(ids.includes(602) && ids.includes(603), `named children missing from ${JSON.stringify(ids)}`);
  // Spare slots may still be filled by unnamed siblings, but never ahead of a
  // named one.
  const children = ids.filter((id: number) => id !== 600);
  const lastNamed = Math.max(children.indexOf(602), children.indexOf(603));
  const firstUnnamed = children.findIndex((id: number) => id !== 602 && id !== 603);
  assert.ok(
    firstUnnamed === -1 || firstUnnamed > lastNamed,
    `an unnamed child was offered ahead of a named one: ${JSON.stringify(ids)}`
  );
});

test("a parent and its children are offered as a choice when no level clearly wins", () => {
  // Nothing here names a child, and nothing names the parent's own subject
  // either -- "wkld" and "parity" run straight down the family.
  const u = upd("On wkld parity, I ran the checks again.");
  const r = matchOne(u, HIER, PARENT_CONFIRMED_NEUTRAL);
  assert.equal(r.kind, "ambiguous");
  const ids = (r as any).choices.map((c: any) => c.item.id);
  assert.ok(ids.includes(PARENT), "the parent must remain an option");
  assert.ok(ids.includes(CHILD_CMR) && ids.includes(CHILD_SSD));
  assert.match((r as any).reason, /nothing you said picks one/i);
});

test("the parent wins outright when the update names its own subject", () => {
  // "cpu" and "dpu" belong to the parent and to neither child. A parent is a
  // real piece of work, not just a folder, so this must not trigger a question.
  const u = upd("On perf parity, I am still comparing the CPU and DPU numbers.");
  const r = matchOne(u, HIER, PARENT_CONFIRMED);
  assert.equal(r.kind, "matched");
  assert.equal((r as any).candidate.item.id, PARENT);
});

test("the parent is listed first when the person is asked to pick a level", () => {
  const u = upd("On wkld parity, I ran the checks again.");
  const r = matchOne(u, HIER, PARENT_CONFIRMED_NEUTRAL);
  assert.equal((r as any).choices[0].item.id, PARENT);
});

test("an id spoken aloud is never overridden by that item's children", () => {
  const u = upd("On PBI 500 I finished the SSD WKLD parity runs.");
  const r = matchOne(u, HIER, ME);
  assert.equal(r.kind, "matched");
  assert.equal((r as any).candidate.item.id, PARENT);
  assert.equal((r as any).candidate.tier, "explicit-id");
});

test("a pinned item is never overridden by that item's children", () => {
  const pinned = { ...ME, pinnedWorkItemIds: [PARENT], confirmedMatches: [] };
  const u = upd("I finished the SSD WKLD parity runs today.");
  const r = matchOne(u, HIER, pinned);
  assert.equal(r.kind, "matched");
  assert.equal((r as any).candidate.item.id, PARENT);
  assert.equal((r as any).candidate.tier, "pinned");
});

test("an item with no children is unaffected by the hierarchy check", () => {
  const flat = HIER.map((i) => ({ ...i, childIds: undefined }));
  const u = upd("On perf parity, I am still comparing the numbers.");
  const r = matchOne(u, flat, PARENT_CONFIRMED);
  assert.equal(r.kind, "matched");
  assert.equal((r as any).candidate.item.id, PARENT);
});

test("a child is never auto-picked when two siblings fit equally well", () => {
  // Says "parity" and nothing that separates SSD from CMR HDD.
  const u = upd("On wkld parity, I ran the parity checks.");
  const r = matchOne(u, HIER, PARENT_CONFIRMED_NEUTRAL);
  assert.equal(r.kind, "ambiguous");
});

test("the right item is always among the choices when a level is asked for", () => {
  // The real 16 Sep standup update. 10001001 is the correct target; whatever
  // else is offered, it must never be dropped from the list.
  const u = upd("I was working on the CPU versus NODE WKLD performance parity.");
  const r = matchOne(u, HIER, PARENT_CONFIRMED);
  const ids =
    r.kind === "matched"
      ? [(r as any).candidate.item.id]
      : (r as any).choices.map((c: any) => c.item.id);
  assert.ok(ids.includes(PARENT), `expected 500 among ${JSON.stringify(ids)}`);
});

// ---- consolidation: one card per work item ----

const topicUpdate = (topic: string, progress: string, text: string): SpeakerUpdate => ({
  speaker: "Ankit Kushwaha",
  adoIdentity: ME.adoIdentity,
  enrolled: true,
  text,
  explicitIds: extractExplicitIds(text),
  signalTerms: signalTerms(`${topic}. ${text}`),
  topic,
  progress,
});

const PARITY = wi({
  id: 500,
  title: "[NODE WKLD] Perf parity between HBADevTest, CPU & NODE WKLD",
  state: "Committed",
});
const SSD = wi({ id: 501, title: "SSD WKLD Parity", type: "Task" });

const cand = (item: WorkItem, reason = "Assigned to you."): any => ({
  item,
  tier: "assigned",
  score: 500,
  reason,
});

test("several topics about one item become a single card", () => {
  const updates = [
    topicUpdate("AcmeSDK issue", "DONE", "I found an issue in the AcmeSDK version WKLD consumes for the CPU and DPU parity work."),
    topicUpdate("Collect DPU metrics", "NEXT", "I will use the corrected AcmeSDK to collect DPU metrics against the CPU parity baseline."),
    topicUpdate("CPU-DPU comparison", "NEXT", "I will compare the DPU metrics against the CPU metrics for parity."),
  ];
  const matches = updates.map((u) => ({ update: u, outcome: matchOne(u, [PARITY], ME) }));
  assert.ok(
    matches.every((m) => m.outcome.kind === "matched"),
    "fixture check: every topic should reach the item"
  );

  const cards = consolidate(matches, new Map());
  assert.equal(cards.length, 1, "three topics on one item must not make three cards");
  assert.equal(cards[0].workItem.id, 500);
  assert.equal(cards[0].updates.length, 3);
});

test("the consolidated comment carries every update as its own line", () => {
  const updates = [
    topicUpdate("AcmeSDK issue", "DONE", "I found an issue in the AcmeSDK version WKLD consumes for the CPU and DPU parity work."),
    topicUpdate("Collect DPU metrics", "NEXT", "I will use the corrected AcmeSDK to collect DPU metrics against the CPU parity baseline."),
  ];
  const matches = updates.map((u) => ({ update: u, outcome: matchOne(u, [PARITY], ME) }));
  const [card] = consolidate(matches, new Map());

  const body = card.proposed!.commentMarkdown;
  assert.match(body, /AcmeSDK issue/);
  assert.match(body, /Collect DPU metrics/);
  assert.equal(body.split("\n").filter((l) => l.startsWith("- ")).length, 2);
});

test("one finished topic does not close an item that has outstanding ones", () => {
  const updates = [
    topicUpdate("AcmeSDK issue", "DONE", "The AcmeSDK problem behind the CPU and DPU parity work is finished and completed."),
    topicUpdate("Collect DPU metrics", "NEXT", "I will collect the DPU metrics against the CPU parity baseline."),
  ];
  const matches = updates.map((u) => ({ update: u, outcome: matchOne(u, [PARITY], ME) }));
  const [card] = consolidate(matches, new Map());
  assert.equal(card.proposed!.stateChange, null);
  assert.match(card.proposed!.stateRationale, /outstanding/);
});

test("repetition across the meeting settles what one topic could not", () => {
  // Each topic on its own was too close to call between the parent and the SSD
  // task, but both independently ranked the same item first.
  const ambiguous = (topic: string, text: string) => ({
    update: topicUpdate(topic, "NEXT", text),
    outcome: { kind: "ambiguous" as const, choices: [cand(PARITY), cand(SSD)] },
  });
  const matches = [
    ambiguous("Parity investigation", "If the DPU stack misses the expected performance I will find the weak layer."),
    ambiguous("Parity dashboard", "I will add the DPU parity comparison to the dashboard I built."),
  ];
  const cards = consolidate(matches, new Map());

  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "proposed");
  assert.equal(cards[0].workItem.id, 500);
  assert.equal(cards[0].updates.length, 2);
  assert.match(cards[0].corroboration ?? "", /separate parts of your update/i);
});

test("a single unsettled topic still asks rather than assuming", () => {
  const matches = [
    {
      update: topicUpdate("Parity investigation", "NEXT", "If the DPU stack misses the expected performance I will find the weak layer."),
      outcome: { kind: "ambiguous" as const, choices: [cand(PARITY), cand(SSD)] },
    },
  ];
  const cards = consolidate(matches, new Map());

  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "ambiguous");
  assert.equal((cards[0].choices ?? []).length, 2, "an unsettled card must still offer choices");
});

test("corroboration never overrides a decided match on another item", () => {
  // A decided match must keep its own card even when another item is repeated.
  const decided = {
    update: topicUpdate("SSD runs", "DONE", "I finished the SSD WKLD parity runs."),
    outcome: { kind: "matched" as const, candidate: cand(SSD), runnersUp: [] },
  };
  const repeated = [1, 2].map((n) => ({
    update: topicUpdate(`Parity ${n}`, "NEXT", "I will continue the DPU parity comparison work."),
    outcome: { kind: "ambiguous" as const, choices: [cand(PARITY), cand(SSD)] },
  }));
  const cards = consolidate([decided, ...repeated], new Map());

  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.workItem.id).sort(), [500, 501]);
});

test("the comment is dated the meeting, not the day it was processed", () => {
  // A late or replayed run must not relabel an old standup with today's date.
  const updates = [
    topicUpdate("AcmeSDK issue", "DONE", "I found an issue in the AcmeSDK version WKLD consumes for the CPU and DPU parity work."),
  ];
  const matches = updates.map((u) => ({ update: u, outcome: matchOne(u, [PARITY], ME) }));
  const [card] = consolidate(matches, new Map(), new Date("2026-09-16T05:30:51Z"));
  assert.match(card.proposed!.commentMarkdown, /Standup update — 2026-09-16/);
});

test("two people talking about the same item get their own cards", () => {
  const mine = topicUpdate("Parity", "NEXT", "I will compare the DPU and CPU parity metrics.");
  const theirs = { ...mine, speaker: "Someone Else" };
  const matches = [mine, theirs].map((u) => ({ update: u, outcome: matchOne(u, [PARITY], ME) }));
  const cards = consolidate(matches, new Map());
  assert.equal(cards.length, 2, "cards are private to a person, never merged across people");
});

// ---- vocabulary: repairing what speech-to-text mangled ----

const VOCAB: VocabularyFile = {
  terms: [
    { canonical: "AcmeSDK", variants: ["ACHME SDK", "ACHMES DK"] },
    { canonical: "HWLC", variants: ["hardware lock", "hardware local"] },
    { canonical: "Hardware Log Collector", variants: ["hardware lock collector"] },
    // Capitalisation only: survives tokenisation identically, so it must be a no-op.
    { canonical: "xPF", variants: ["XPF"] },
  ],
};

test("a mangled product name is repaired before matching", () => {
  const { normalized, corrections } = canonicalize(
    "There was an issue with the ACHME SDK version WKLD consumes.",
    VOCAB
  );
  assert.match(normalized, /AcmeSDK/);
  assert.doesNotMatch(normalized, /ACHME SDK/);
  assert.deepEqual(corrections, [{ heard: "ACHME SDK", canonical: "AcmeSDK" }]);
});

test("the longest matching variant wins", () => {
  // "hardware lock" is a prefix of "hardware lock collector"; repairing the
  // short one first would leave "HWLC collector".
  const { normalized } = canonicalize("We fixed the hardware lock collector.", VOCAB);
  assert.match(normalized, /Hardware Log Collector/);
  assert.doesNotMatch(normalized, /HWLC collector/);
});

test("a spelling difference that changes no token is not reported as a correction", () => {
  const { corrections } = canonicalize("The XPF cluster is ready.", VOCAB);
  assert.deepEqual(corrections, [], "capitalisation alone must not be surfaced as a repair");
});

// The four tests below each pin a defect that was live and silent. Every one of
// them weakened matching without failing anything, which is the whole reason
// they are here.

test("a repair that splits or joins words is not mistaken for a spelling difference", () => {
  // "start Cosmos" and "StartCosmos" are identical once punctuation is stripped,
  // so a blob comparison calls this a no-op and drops the repair. To the matcher
  // they are two terms versus one, which halves the score against a work item
  // titled "StartCosmos ...". The skip rule has to use the matcher's own
  // tokenisation, not a looser one.
  const vocab: VocabularyFile = {
    terms: [{ canonical: "StartCosmos", variants: ["start Cosmos"] }],
  };
  const { normalized, corrections } = canonicalize("The start Cosmos executable fails.", vocab);
  assert.match(normalized, /StartCosmos/);
  assert.deepEqual(corrections, [{ heard: "start Cosmos", canonical: "StartCosmos" }]);

  assert.ok(
    signalTerms(normalized).includes("startcosmos"),
    "the repair only counts if the matcher now sees the canonical term"
  );
});

test("however the transcriber spaced a term, it is still repaired", () => {
  // Whitespace and hyphenation in a transcript come from the recogniser, not the
  // speaker, so a variant must not be matched as a rigid literal. The spellings
  // are derived from the vocabulary rather than written out, so this tests the
  // behaviour rather than one particular product name.
  const term = VOCAB.terms[0];
  const spoken = term.variants[0];
  const spacings = [
    spoken,
    spoken.replace(/\s+/, "  "),
    spoken.replace(/\s+/, "-"),
    spoken.replace(/\s+/, "\n"),
  ];

  for (const heard of spacings) {
    const { normalized } = canonicalize(`We hit a bug in the ${heard} build.`, VOCAB);
    assert.ok(
      normalized.includes(term.canonical),
      `failed to repair ${JSON.stringify(heard)}`
    );
  }

  // But a separator is still required, so a variant can never consume its own
  // canonical and report a repair that changed nothing.
  const vocab: VocabularyFile = {
    terms: [{ canonical: "StartCosmos", variants: ["start Cosmos"] }],
  };
  const { normalized, corrections } = canonicalize("StartCosmos is fine.", vocab);
  assert.equal(normalized, "StartCosmos is fine.");
  assert.deepEqual(corrections, []);
});

test("every distinct spelling heard is reported, not just the first", () => {
  const term = VOCAB.terms[0];
  const upper = term.variants[0];
  const lower = upper.toLowerCase();
  assert.notEqual(upper, lower, "this test needs a variant with letter case in it");

  const { corrections } = canonicalize(`${upper} broke, and later the ${lower} broke again.`, VOCAB);
  assert.deepEqual(corrections, [
    { heard: upper, canonical: term.canonical },
    { heard: lower, canonical: term.canonical },
  ]);
});

test("a canonical produced by one repair is never eaten by a later one", () => {
  // Replacing variant-by-variant runs each rule over text the previous rule
  // already rewrote, so a canonical can be matched and mangled downstream.
  // Scanning once means every position is decided against the original text.
  const vocab: VocabularyFile = {
    terms: [
      { canonical: "Hardware Log Collector", variants: ["hardware lock collector"] },
      { canonical: "HWLC", variants: ["log collector"] },
    ],
  };
  const { normalized } = canonicalize("We fixed the hardware lock collector.", vocab);
  assert.equal(normalized, "We fixed the Hardware Log Collector.");
  assert.doesNotMatch(normalized, /Hardware HWLC/, "the first repair was re-matched by the second");
});

test("a variant claimed by two canonicals is reported rather than resolved silently", () => {
  const vocab: VocabularyFile = {
    terms: [
      { canonical: "HWLC", variants: ["hardware lock collector"] },
      { canonical: "Hardware Log Collector", variants: ["hardware lock collector"] },
    ],
  };
  const issues = validateVocabulary(vocab);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "ambiguous-variant");
  assert.match(issues[0].detail, /claimed by both/);

  // It still has to behave deterministically: first claim wins.
  const { normalized } = canonicalize("the hardware lock collector", vocab);
  assert.match(normalized, /HWLC/);
});

test("the shipped vocabulary has no data errors", () => {
  // The real file is hand-written from observed transcripts, so it drifts.
  // data/ holds real meeting content and is not published, so outside this
  // working tree there is nothing to check.
  const file = path.join(__dirname, "..", "..", "data", "vocabulary.json");
  if (!fs.existsSync(file)) return;

  const shipped = JSON.parse(fs.readFileSync(file, "utf8")) as VocabularyFile;
  const issues = validateVocabulary(shipped);
  assert.deepEqual(
    issues.map((i) => `${i.kind}: ${i.detail}`),
    [],
    "data/vocabulary.json has issues that silently weaken matching"
  );
});

test("repairing a name recovers a match that was otherwise lost", () => {
  const acmesdk = wi({ id: 600, title: "Decouple Stable AcmeSDK scheduler" });
  const spoken = "I looked at the ACHME SDK scheduler work.";

  const raw = normalize(
    { meeting: {} as any, utterances: [{ speaker: "Ankit Kushwaha", text: spoken }] } as Transcript,
    [ME]
  )[0];
  const repaired = normalize(
    { meeting: {} as any, utterances: [{ speaker: "Ankit Kushwaha", text: spoken }] } as Transcript,
    [ME],
    VOCAB
  )[0];

  assert.equal(matchOne(raw, [acmesdk], ME).kind, "unresolved", "as transcribed, the name matches nothing");
  const after = matchOne(repaired, [acmesdk], ME);
  assert.equal(after.kind, "matched");
  assert.equal((after as any).candidate.item.id, 600);
});

test("the words a person said are never rewritten on the card", () => {
  const spoken = "I looked at the ACHME SDK scheduler work.";
  const [u] = normalize(
    { meeting: {} as any, utterances: [{ speaker: "Ankit Kushwaha", text: spoken }] } as Transcript,
    [ME],
    VOCAB
  );
  assert.equal(u.text, spoken, "the posted text must stay verbatim");
  assert.deepEqual(u.corrections, [{ heard: "ACHME SDK", canonical: "AcmeSDK" }]);
});

test("a correction reaches the card so it can be accepted deliberately", () => {
  const acmesdk = wi({ id: 600, title: "Decouple Stable AcmeSDK scheduler" });
  const [u] = normalize(
    {
      meeting: {} as any,
      utterances: [{ speaker: "Ankit Kushwaha", text: "I finished the ACHME SDK scheduler decoupling." }],
    } as Transcript,
    [ME],
    VOCAB
  );
  const [card] = consolidate([{ update: u, outcome: matchOne(u, [acmesdk], ME) }], new Map());
  assert.deepEqual(card.updates[0].corrections, [{ heard: "ACHME SDK", canonical: "AcmeSDK" }]);
  assert.match(card.proposed!.commentMarkdown, /ACHME SDK/, "the comment quotes what was said");
});


// ---- the guarded write ----

test("the comment and the revision assertion are one atomic patch", () => {
  const item = wi({ id: 700, title: "Sandbox", rev: 14 });
  const patch = buildPatch(item, {
    commentMarkdown: "<!-- ado-sync -->\n**Standup update**\n\n- did a thing",
    stateChange: null,
    nextAction: "n/a",
    stateRationale: "n/a",
  });

  assert.deepEqual(patch[0], { op: "test", path: "/rev", value: 14 });
  assert.equal(patch[1].path, "/fields/System.History");
  assert.equal(patch.length, 2, "the write must not be a second, unguarded call");
});

test("a state change rides inside the same assertion", () => {
  const item = wi({ id: 700, title: "Sandbox", rev: 14, state: "Committed" });
  const patch = buildPatch(item, {
    commentMarkdown: "<!-- ado-sync -->\n- all finished",
    stateChange: { from: "Committed", to: "Done" },
    nextAction: "n/a",
    stateRationale: "n/a",
  });

  assert.deepEqual(patch[0], { op: "test", path: "/rev", value: 14 });
  const state = patch.find((o) => o.path === "/fields/System.State");
  assert.deepEqual(state?.value, "Done");
});

test("System.History receives HTML, not raw markdown", () => {
  const html = markdownToHtml("**Standup update**\n\n- first thing\n- second thing");
  assert.match(html, /<strong>Standup update<\/strong>/);
  assert.match(html, /<ul><li>first thing<\/li><li>second thing<\/li><\/ul>/);
  assert.doesNotMatch(html, /\*\*/, "asterisks would render literally in the Discussion tab");
});

test("the dedupe marker survives into the posted body", () => {
  const html = markdownToHtml("<!-- ado-sync -->\n- a thing");
  assert.match(html, /<!-- ado-sync -->/, "losing the marker breaks dedupe on the next run");
});

test("markup in what someone said cannot inject HTML", () => {
  const html = markdownToHtml("- I fixed <script>alert(1)</script> today");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("a stale revision rejection is recognised", () => {
  assert.equal(
    isStaleRevRejection("VS403351: Test Operation for path /rev failed, value 2 was not equal to test value 1"),
    true
  );
  assert.equal(isStaleRevRejection("500 Internal Server Error"), false);
});

test("only proposed cards produce a write", () => {
  const item = wi({ id: 700, title: "Sandbox", rev: 3 });
  const cards: any[] = [
    { status: "proposed", workItem: item, updates: [], speaker: "A", controls: [],
      proposed: { commentMarkdown: "- x", stateChange: null, nextAction: "", stateRationale: "" } },
    { status: "ambiguous", workItem: item, updates: [], speaker: "A", controls: [] },
    { status: "duplicate-skipped", workItem: item, updates: [], speaker: "A", controls: [] },
  ];
  const actions = buildWriteActions(cards, "contoso", "One");
  assert.equal(actions.length, 1);
  assert.match(actions[0].url, /contoso\/One\/_apis\/wit\/workitems\/700/);
  assert.equal(actions[0].contentType, "application/json-patch+json");
});

// ---- acceptance telemetry ----

const decisionCard = (tier: string, corroborated = false, corrections = 0): any => ({
  speaker: "Ankit Kushwaha",
  status: "proposed",
  workItem: wi({ id: 800, title: "Thing" }),
  updates: [{ text: "x", tier, reason: "", corroborated: false,
    corrections: corrections > 0 ? [{ heard: "ACHME SDK", canonical: "AcmeSDK" }] : undefined }],
  corroboration: corroborated ? "two parts agree" : undefined,
  controls: [],
});

test("a decision captures what the suggestion rested on", () => {
  const d = recordDecision(decisionCard("assigned", true, 1), "Daily Standup", "approved-after-edit", {
    provenance: { editedUpdates: [0], removedUpdates: [], correctionsAccepted: 1, rawEdited: false },
    now: new Date("2026-09-18T10:00:00Z"),
  });
  assert.equal(d.tier, "assigned");
  assert.equal(d.usedCorroboration, true);
  assert.equal(d.correctionsOffered, 1);
  assert.equal(d.correctionsAccepted, 1);
  assert.equal(d.outcome, "approved-after-edit");
});

test("accepted corrections can never exceed the ones offered", () => {
  const d = recordDecision(decisionCard("assigned", false, 0), "m", "approved-unchanged", {
    provenance: { editedUpdates: [], removedUpdates: [], correctionsAccepted: 5, rawEdited: false },
  });
  assert.equal(d.correctionsOffered, 0);
});

test("acceptance is reported per tier, never blended into one number", () => {
  const decisions = [
    ...Array(8).fill(0).map(() => recordDecision(decisionCard("explicit-id"), "m", "approved-unchanged")),
    ...Array(2).fill(0).map(() => recordDecision(decisionCard("explicit-id"), "m", "approved-after-edit")),
    ...Array(3).fill(0).map(() => recordDecision(decisionCard("assigned"), "m", "approved-unchanged")),
    ...Array(7).fill(0).map(() => recordDecision(decisionCard("assigned"), "m", "approved-after-edit")),
  ];
  const summary = summarise(decisions);
  const explicit = summary.find((s) => s.tier === "explicit-id")!;
  const assigned = summary.find((s) => s.tier === "assigned")!;

  assert.equal(explicit.cleanAcceptanceRate, 0.8);
  assert.equal(assigned.cleanAcceptanceRate, 0.3);
  // Blended this would read 55% and hide that one tier is nowhere near ready.
  assert.ok(explicit.cleanAcceptanceRate > assigned.cleanAcceptanceRate);
});

test("a strong rate over a tiny sample does not earn automation", () => {
  const decisions = Array(4).fill(0).map(() =>
    recordDecision(decisionCard("explicit-id"), "m", "approved-unchanged")
  );
  const [t] = summarise(decisions);
  assert.equal(t.cleanAcceptanceRate, 1);
  assert.equal(qualifiesForAutomation(t, 25, 0.9), false, "4 cards is not evidence");
});

test("editing counts against automation even when people approve", () => {
  const decisions = Array(40).fill(0).map((_, i) =>
    recordDecision(decisionCard("assigned"), "m", i < 30 ? "approved-after-edit" : "approved-unchanged")
  );
  const [t] = summarise(decisions);
  assert.equal(qualifiesForAutomation(t, 25, 0.9), false, "routine editing means the output is not ready");
});

// ---- mapping live ADO responses ----

test("hierarchy is read from relations so the rule works on live data", () => {
  const raw = {
    id: 10001001,
    rev: 10,
    fields: {
      "System.WorkItemType": "Product Backlog Item",
      "System.State": "Committed",
      "System.Title": "[NODE WKLD] Perf parity between HBADevTest, CPU & NODE WKLD",
      "System.AssignedTo": "Ankit Kushwaha <you@example.com>",
      "System.ChangedDate": "2026-09-04T19:43:33.437Z",
    },
    relations: [
      { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://dev.azure.com/contoso/x/_apis/wit/workItems/10001003" },
      { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/contoso/x/_apis/wit/workItems/38676845" },
      { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://dev.azure.com/contoso/x/_apis/wit/workItems/10001004" },
      { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/contoso/x/_apis/wit/workItems/39599350" },
    ],
  };
  const item = toWorkItem(raw);
  assert.deepEqual(item.childIds, [10001003, 10001004]);
  assert.equal(item.parentId, 38676845);
  assert.deepEqual(item.relatedIds, [39599350]);
  assert.equal(item.assignedTo, "you@example.com");
  assert.equal(item.assignedToName, "Ankit Kushwaha");
});

test("a generic quantifier cannot qualify a match on its own", () => {
  // Real false positive from the live contoso/Engineering set. "I did not get to any of
  // my tickets" matched "Create tickets for any stuck nodes" on "any" plus
  // "tickets" -- 2 hits over a short title cleared the candidacy gate.
  //
  // Inverse document frequency cannot catch this: "any" occurs in exactly one
  // of 110 titles, so it scores as maximally distinctive. Rarity in a small
  // corpus is not informativeness.
  const items: WorkItem[] = [
    wi({ id: 900, title: "Create tickets for any stuck nodes and bring back to Healthy", type: "Task" }),
  ];
  const u = upd("I was in interviews for most of the day and did not get to any of my tickets.");

  assert.ok(!signalTerms(u.text).includes("any"), '"any" must not be a signal term');
  assert.equal(matchOne(u, items, { ...ME, confirmedMatches: [] }).kind, "unresolved");
});

// ---- link traversal: reaching items only a link can reach ----
//
// Bug 39599350 is linked Related to PBI 10001001 in contoso/Engineering. It is not
// assigned to the speaker and its title shares almost nothing with the PBI's,
// so no amount of text matching reaches it. Ids are localised here.

const LINK_PBI = 800;
const LINK_BUG = 801;

const LINKED: WorkItem[] = [
  wi({
    id: LINK_PBI,
    title: "[NODE WKLD] Perf parity between HBADevTest, CPU & NODE WKLD",
    state: "Committed",
    relatedIds: [LINK_BUG],
  }),
  wi({
    id: LINK_BUG,
    title: "NVMe queue depth saturation under sustained write",
    type: "Bug",
    assignedTo: "teammate@example.com",
    assignedToName: "Other",
    changedDate: "2020-01-01T00:00:00Z",
  }),
];

test("an item reachable only through a link becomes a candidate", () => {
  // Nothing else can surface this bug: it is not assigned to the speaker, it
  // was not touched recently, and its title does not resemble the PBI's.
  const u = upd("Hit NVMe queue depth saturation under sustained write today.");
  const out = matchOne(u, LINKED, { ...ME, confirmedMatches: [] });

  assert.equal(out.kind, "ambiguous");
  const ids = (out as any).choices.map((c: any) => c.item.id);
  assert.ok(ids.includes(LINK_BUG), "the linked bug should be offered");
  const bug = (out as any).choices.find((c: any) => c.item.id === LINK_BUG);
  assert.equal(bug.tier, "linked");
});

test("a linked item is never auto-matched on its own", () => {
  // Being linked to your work is not owning it. The whole tier is candidate
  // only, exactly like recently-touched, so it always waits for a decision.
  const only: WorkItem[] = [
    { ...LINKED[0], title: "Completely unrelated wording" },
    LINKED[1],
  ];
  const u = upd("Hit NVMe queue depth saturation under sustained write today.");
  const out = matchOne(u, only, { ...ME, confirmedMatches: [] });

  assert.notEqual(out.kind, "matched");
});

test("a linked item never outranks an item assigned to you", () => {
  // The published order has to hold even when the linked title is the better
  // textual match, or the ladder is decorative.
  const items: WorkItem[] = [
    wi({ id: LINK_PBI, title: "NVMe queue work", relatedIds: [LINK_BUG] }),
    wi({
      id: LINK_BUG,
      title: "NVMe queue depth saturation under sustained write",
      type: "Bug",
      assignedTo: "teammate@example.com",
      assignedToName: "Other",
      changedDate: "2020-01-01T00:00:00Z",
    }),
  ];
  const u = upd("NVMe queue depth saturation under sustained write.");
  const out = matchOne(u, items, { ...ME, confirmedMatches: [] });

  const choices = out.kind === "ambiguous" ? (out as any).choices : [(out as any).candidate];
  assert.equal(choices[0].item.id, LINK_PBI, "the assigned item must rank first");
});

test("traversal is one hop, so a link of a link is not pulled in", () => {
  // "Related to something related to mine" stops carrying meaning, and each
  // extra hop widens the candidate set enough to manufacture ambiguity.
  const items: WorkItem[] = [
    wi({ id: 810, title: "Owned item", relatedIds: [811] }),
    wi({
      id: 811,
      title: "One hop away",
      assignedTo: "teammate@example.com",
      assignedToName: "Other",
      changedDate: "2020-01-01T00:00:00Z",
      relatedIds: [812],
    }),
    wi({
      id: 812,
      title: "Two hops away",
      assignedTo: "teammate@example.com",
      assignedToName: "Other",
      changedDate: "2020-01-01T00:00:00Z",
    }),
  ];
  const u = upd("Two hops away.");
  const out = matchOne(u, items, { ...ME, confirmedMatches: [] });

  const ids =
    out.kind === "ambiguous"
      ? (out as any).choices.map((c: any) => c.item.id)
      : out.kind === "matched"
        ? [(out as any).candidate.item.id]
        : [];
  assert.ok(!ids.includes(812), "an item two hops out must not become a candidate");
});

test("an identity object is read as well as the string form", () => {
  assert.deepEqual(parseIdentity({ displayName: "Ankit Kushwaha", uniqueName: "you@example.com" }), {
    name: "Ankit Kushwaha",
    mail: "you@example.com",
  });
  assert.deepEqual(parseIdentity(null), { name: null, mail: null });
});

test("an unassigned item does not invent an owner", () => {
  const item = toWorkItem({ id: 1, rev: 1, fields: { "System.Title": "Orphan" } });
  assert.equal(item.assignedTo, null);
  assert.deepEqual(item.childIds, undefined);
});

test("children referenced but not fetched are reported", () => {
  // A partial capture makes a child's words look more distinctive than they
  // are, because distinctiveness is measured against the siblings present.
  const items: WorkItem[] = [
    wi({ id: 1, title: "Parent", childIds: [2, 3, 4] }),
    wi({ id: 2, title: "Child two" }),
  ];
  assert.deepEqual(missingChildren(items).sort(), [3, 4]);
});


// ---- editing before approval ----

const MEETING_DAY = new Date("2026-09-16T05:30:51Z");

function editableCard(): any {
  return {
    speaker: "Ankit Kushwaha",
    status: "proposed",
    workItem: wi({ id: 900, title: "[NODE WKLD] Perf parity", state: "Committed", rev: 10 }),
    updates: [
      { text: "I found an issue in the ACHME SDK version WKLD consumes.", topic: "AcmeSDK issue",
        progress: "DONE", tier: "assigned", reason: "", corroborated: false,
        corrections: [{ heard: "ACHME SDK", canonical: "AcmeSDK" }] },
      { text: "I will collect the DPU metrics next.", topic: "Collect metrics",
        progress: "NEXT", tier: "assigned", reason: "", corroborated: false },
      { text: "Roughly 5 percent variance is acceptable.", topic: "Acceptance criteria",
        progress: "IN PROGRESS", tier: "assigned", reason: "", corroborated: false },
    ],
    controls: [],
  };
}

test("editing one line leaves the others untouched", () => {
  const { card, provenance } = applyEdits(
    editableCard(),
    [{ kind: "edit-update", index: 0, text: "I found an issue in the AcmeSDK version." }],
    MEETING_DAY
  );
  assert.equal(card.updates.length, 3);
  assert.match(card.updates[0].text, /AcmeSDK version\./);
  assert.match(card.updates[1].text, /collect the DPU metrics/);
  assert.deepEqual(provenance.editedUpdates, [0]);
  assert.equal(provenance.rawEdited, false);
});

test("removing one line drops it from the comment and keeps the rest", () => {
  const { card, provenance } = applyEdits(
    editableCard(),
    [{ kind: "remove-update", index: 2 }],
    MEETING_DAY
  );
  assert.equal(card.updates.length, 2);
  assert.doesNotMatch(card.proposed!.commentMarkdown, /Acceptance criteria/);
  assert.match(card.proposed!.commentMarkdown, /AcmeSDK issue/);
  assert.deepEqual(provenance.removedUpdates, [2]);
});

test("accepting a correction rewrites only that line, and only then", () => {
  const before = editableCard();
  assert.match(before.updates[0].text, /ACHME SDK/);

  const { card, provenance } = applyEdits(
    before,
    [{ kind: "accept-correction", index: 0 }],
    MEETING_DAY
  );
  assert.match(card.updates[0].text, /AcmeSDK/);
  assert.doesNotMatch(card.updates[0].text, /ACHME SDK/);
  assert.equal(card.updates[0].corrections, undefined, "a taken repair is no longer on offer");
  assert.equal(provenance.correctionsAccepted, 1);
});

test("accepting a correction is recorded as agreement, not as a rewrite", () => {
  const { provenance } = applyEdits(
    editableCard(),
    [{ kind: "accept-correction", index: 0 }],
    MEETING_DAY
  );
  assert.equal(onlyAcceptedCorrections(provenance), true);

  const rewritten = applyEdits(
    editableCard(),
    [{ kind: "accept-correction", index: 0 }, { kind: "remove-update", index: 1 }],
    MEETING_DAY
  );
  assert.equal(onlyAcceptedCorrections(rewritten.provenance), false);
});

test("a raw edit replaces the whole body", () => {
  const body = "<!-- ado-sync -->\nParity work is unblocked; metrics next.";
  const { card, provenance } = applyEdits(
    editableCard(),
    [{ kind: "replace-body", markdown: body }],
    MEETING_DAY
  );
  assert.equal(card.proposed!.commentMarkdown, body);
  assert.equal(card.proposed!.bodyAuthoredByUser, true);
  assert.equal(provenance.rawEdited, true);
});

test("a per-line edit after a raw edit is refused rather than silently discarding it", () => {
  // Regenerating the body from the structure would throw away what the person
  // wrote. Losing someone's writing without telling them is the worst option.
  assert.throws(
    () =>
      applyEdits(
        editableCard(),
        [
          { kind: "replace-body", markdown: "My own wording." },
          { kind: "edit-update", index: 0, text: "something else" },
        ],
        MEETING_DAY
      ),
    EditConflictError
  );
});

test("a second raw edit is allowed", () => {
  const { card } = applyEdits(
    editableCard(),
    [
      { kind: "replace-body", markdown: "First attempt." },
      { kind: "replace-body", markdown: "Second attempt." },
    ],
    MEETING_DAY
  );
  assert.equal(card.proposed!.commentMarkdown, "Second attempt.");
});

test("removing every line means no comment, not an empty one", () => {
  const { card } = applyEdits(
    editableCard(),
    [
      { kind: "remove-update", index: 0 },
      { kind: "remove-update", index: 1 },
      { kind: "remove-update", index: 2 },
    ],
    MEETING_DAY
  );
  assert.equal(card.proposed, undefined);
  assert.equal(card.status, "duplicate-skipped");
  assert.match(card.skipReason!, /nothing left to post/i);
});

test("an edit to a line that does not exist is rejected", () => {
  assert.throws(
    () => applyEdits(editableCard(), [{ kind: "edit-update", index: 9, text: "x" }], MEETING_DAY),
    RangeError
  );
});

test("re-saving identical text is not counted as an edit", () => {
  const card = editableCard();
  const { provenance } = applyEdits(
    card,
    [{ kind: "edit-update", index: 1, text: card.updates[1].text }],
    MEETING_DAY
  );
  assert.deepEqual(provenance.editedUpdates, []);
  assert.equal(wasEdited(provenance), false);
});

test("the edited comment is still dated the meeting", () => {
  const { card } = applyEdits(
    editableCard(),
    [{ kind: "remove-update", index: 2 }],
    MEETING_DAY
  );
  assert.match(card.proposed!.commentMarkdown, /Standup update — 2026-09-16/);
});

test("telemetry separates a correction-only approval from a real rewrite", () => {
  const corrected = applyEdits(editableCard(), [{ kind: "accept-correction", index: 0 }], MEETING_DAY);
  const rewritten = applyEdits(editableCard(), [{ kind: "replace-body", markdown: "mine" }], MEETING_DAY);

  const a = recordDecision(corrected.card, "Daily Standup", "approved-after-edit", {
    provenance: corrected.provenance,
  });
  const b = recordDecision(rewritten.card, "Daily Standup", "approved-after-edit", {
    provenance: rewritten.provenance,
  });

  assert.equal(a.correctionOnly, true);
  assert.equal(a.rawEdited, false);
  assert.equal(b.correctionOnly, false);
  assert.equal(b.rawEdited, true);

  // Both are "approved-after-edit", but only one says the engine got it wrong.
  const summary = summarise([a, b]);
  assert.equal(summary[0].correctionOnlyRate, 0.5);
  assert.equal(summary[0].rawEditRate, 0.5);
});



// ---- parsing real transcript files ----

const TEAMS_VTT = [
  "WEBVTT",
  "",
  "1",
  "00:00:03.120 --> 00:00:07.400",
  "<v Ankit Kushwaha>Morning. I finished the perf parity run</v>",
  "",
  "2",
  "00:00:07.400 --> 00:00:11.900",
  "<v Ankit Kushwaha>against HBADevTest and the numbers line up.</v>",
  "",
  "3",
  "00:00:12.000 --> 00:00:15.100",
  "<v Kushal T S>Nice. I am still on the SSD profile.</v>",
  "",
].join("\n");

test("a Teams vtt is read back as speaker turns", () => {
  const topics = parseVtt(TEAMS_VTT);
  assert.equal(topics.length, 2);
  assert.equal(topics[0].title, "Ankit Kushwaha");
  // Captions split mid-sentence; a three-word fragment matched against a work
  // item title is noise, so a contiguous run is rejoined into one turn.
  assert.equal(
    topics[0].text,
    "Morning. I finished the perf parity run against HBADevTest and the numbers line up."
  );
  assert.equal(topics[1].title, "Kushal T S");
  assert.deepEqual(vttSpeakers(TEAMS_VTT), ["Ankit Kushwaha", "Kushal T S"]);
});

test("a vtt keeps only the uploader's own words", () => {
  // A caption file contains the whole room. Keeping everyone would post other
  // people's words as this person's update.
  const t = parseTranscriptFile({
    filename: "standup.vtt",
    content: TEAMS_VTT,
    speaker: "Ankit Kushwaha",
    meeting: "Daily Standup",
    date: "2026-09-18T05:30:00Z",
  });
  assert.equal(t.topics.length, 1);
  assert.ok(t.topics[0].text.includes("perf parity"));
  assert.ok(!t.topics[0].text.includes("SSD profile"), "another speaker leaked in");
  // Every speaker in the file is still reported, so the UI can show who was
  // found and let you correct the attribution. Only the topics are filtered.
  assert.deepEqual(t.speakers, ["Ankit Kushwaha", "Kushal T S"]);
});

test("a speaker with no turns yields nothing rather than everyone else's", () => {
  const t = parseTranscriptFile({
    filename: "standup.vtt",
    content: TEAMS_VTT,
    speaker: "Someone Not Present",
  });
  assert.equal(t.topics.length, 0);
});

test("a vtt without speaker tags attributes continuation lines correctly", () => {
  const plain = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "Ankit Kushwaha: I picked up the AcmeSDK work",
    "",
    "00:00:04.000 --> 00:00:06.000",
    "and it is nearly finished.",
    "",
  ].join("\n");
  const topics = parseVtt(plain);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].text, "I picked up the AcmeSDK work and it is nearly finished.");
});

test("a markdown recap keeps its status tags", () => {
  const md = [
    "# Daily Standup",
    "",
    "## Ankit Kushwaha",
    "- DONE: Finished the perf parity comparison",
    "- IN PROGRESS: Wiring the SSD profile",
    "- Blocked on the shared rig",
    "",
  ].join("\n");
  const topics = parseMarkdown(md);
  assert.equal(topics.length, 3);
  assert.equal(topics[0].status, "DONE");
  assert.equal(topics[0].text, "Finished the perf parity comparison");
  assert.equal(topics[1].status, "IN PROGRESS");
  assert.equal(topics[2].status, undefined);
  assert.equal(topics[2].title, "Ankit Kushwaha");
});

test("a recap written as prose is not discarded", () => {
  const md = "## Ankit Kushwaha\n\nSpent the day on perf parity and it now matches.\n";
  const topics = parseMarkdown(md);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].text, "Spent the day on perf parity and it now matches.");
});

test("an unsupported file type is refused by name", () => {
  assert.throws(
    () => parseTranscriptFile({ filename: "notes.docx", content: "x", speaker: "Ankit Kushwaha" }),
    /Unsupported file type/
  );
});

test("a markdown recap keeps only the uploader's section", () => {
  // Headings in a recap are the attribution. Without this, another person's
  // bullets are posted as your update -- the same leak the .vtt path prevents.
  const md = [
    "## Ankit Kushwaha",
    "- DONE: Finished the perf parity comparison",
    "",
    "## Kushal T S",
    "- DONE: Nothing to report",
    "",
  ].join("\n");
  const t = parseTranscriptFile({ filename: "recap.md", content: md, speaker: "Ankit Kushwaha" });
  assert.equal(t.topics.length, 1);
  assert.ok(t.topics[0].text.includes("perf parity"));
  assert.deepEqual(t.speakers, ["Ankit Kushwaha", "Kushal T S"]);
});

test("a recap whose headings are topics, not people, is kept whole", () => {
  // Filtering on a heading that was never a name would throw the file away.
  const md = [
    "## Perf parity",
    "- DONE: Numbers line up",
    "",
    "## AcmeSDK",
    "- NEXT: Wire the teardown path",
    "",
  ].join("\n");
  const t = parseTranscriptFile({ filename: "recap.md", content: md, speaker: "Ankit Kushwaha" });
  assert.equal(t.topics.length, 2);
});
