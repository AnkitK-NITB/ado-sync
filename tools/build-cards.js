// Generates teamsapp/cards.json by running the real engine over every transcript
// in data/transcripts/ against the work items in data/live-workitems.json.
//
// The tab renders whatever this produces, so nothing shown in the UI is invented.
// Adding a meeting means dropping a JSON file into data/transcripts/ and re-running
// this -- no code change.
const fs = require("fs");
const path = require("path");

const AGENT = path.join(__dirname, "..");
const ENGINE = path.join(AGENT, "out");
const DATA = path.join(AGENT, "data");
const TRANSCRIPTS = path.join(DATA, "transcripts");

const { signalTerms, extractExplicitIds } = require(path.join(ENGINE, "normalize.js"));
const { matchOne } = require(path.join(ENGINE, "match.js"));
const { consolidate, unresolvedCards } = require(path.join(ENGINE, "consolidate.js"));
const { canonicalize } = require(path.join(ENGINE, "vocabulary.js"));

const workItemFile = JSON.parse(fs.readFileSync(path.join(DATA, "live-workitems.json"), "utf8"));
const items = workItemFile.items;
const enrollmentFile = JSON.parse(fs.readFileSync(path.join(DATA, "enrollment.json"), "utf8"));
const vocabulary = JSON.parse(fs.readFileSync(path.join(DATA, "vocabulary.json"), "utf8"));
const ME = enrollmentFile.enrolled[0];

function loadTranscripts() {
  if (!fs.existsSync(TRANSCRIPTS)) return [];
  return fs
    .readdirSync(TRANSCRIPTS)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .map((f) => {
      const full = path.join(TRANSCRIPTS, f);
      try {
        const t = JSON.parse(fs.readFileSync(full, "utf8"));
        const problems = [];
        if (!t.id) problems.push("missing id");
        if (!Array.isArray(t.topics) || t.topics.length === 0) problems.push("no topics");
        (t.topics || []).forEach((x, i) => { if (!x.text) problems.push("topic " + i + " has no text"); });
        if (problems.length) {
          console.error("  SKIPPED " + f + ": " + problems.join(", "));
          return null;
        }
        return t;
      } catch (e) {
        console.error("  SKIPPED " + f + ": not valid JSON (" + e.message + ")");
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

/**
 * Matching runs on the repaired wording; the update keeps what was actually said.
 * Skipping canonicalize is what once made the correction prompt disappear entirely.
 */
function toUpdate(t, topic) {
  const fixed = canonicalize(topic.text, vocabulary);
  return {
    speaker: t.speaker || ME.teamsDisplayName,
    adoIdentity: ME.adoIdentity,
    enrolled: true,
    text: topic.text,
    explicitIds: extractExplicitIds(fixed.normalized),
    signalTerms: signalTerms((topic.title || "") + ". " + fixed.normalized),
    topic: topic.title,
    progress: topic.status,
    corrections: fixed.corrections.length > 0 ? fixed.corrections : undefined,
  };
}

function cardsFor(t) {
  const matches = t.topics.map((topic) => {
    const u = toUpdate(t, topic);
    return { update: u, outcome: matchOne(u, items, ME) };
  });
  const cards = [
    ...consolidate(matches, new Map(), new Date(t.date || Date.now())),
    ...unresolvedCards(matches),
  ];
  return cards.map((c) => ({
    status: c.status,
    workItem: c.workItem
      ? { id: c.workItem.id, type: c.workItem.type, title: c.workItem.title,
          state: c.workItem.state, rev: c.workItem.rev }
      : null,
    updates: c.updates.map((u) => ({
      topic: u.topic, progress: u.progress, text: u.text, corrections: u.corrections || null,
    })),
    corroboration: c.corroboration || null,
    ambiguityReason: c.ambiguityReason || null,
    skipReason: c.skipReason || null,
    choices: c.choices
      ? c.choices.map((w) => ({ id: w.id, type: w.type, title: w.title, state: w.state, rev: w.rev }))
      : null,
    matchTier: c.updates[0] ? c.updates[0].tier : null,
    matchReason: c.updates[0] ? c.updates[0].reason : null,
    comment: c.proposed ? c.proposed.commentMarkdown : null,
    stateChange: c.proposed ? c.proposed.stateChange : null,
    nextAction: c.proposed ? c.proposed.nextAction : null,
    controls: c.controls,
  }));
}

const transcripts = loadTranscripts();
if (transcripts.length === 0) {
  console.error("No usable transcripts in data/transcripts/. Nothing to build.");
  process.exit(1);
}

const out = {
  generatedAt: new Date().toISOString(),
  org: "contoso",
  project: "One",
  workItemsCapturedAt: workItemFile.capturedAt || null,
  enrolledSpeaker: { displayName: ME.teamsDisplayName, adoIdentity: ME.adoIdentity },
  note: "Produced by the real engine against live contoso/Engineering work items. Nothing here is hand-written.",
  sources: transcripts.map((t) => ({
    id: t.id,
    label: t.label || t.id,
    meeting: t.meeting || "Meeting",
    date: t.date,
    blurb: t.blurb || "",
    expect: t.expect || "",
    topicCount: t.topics.length,
    excluded: t.exclude || [],
    cards: cardsFor(t),
  })),
};

fs.writeFileSync(path.join(AGENT, "teamsapp", "cards.json"), JSON.stringify(out, null, 2));

console.log(items.length + " work items · " + transcripts.length + " transcripts");
for (const s of out.sources) {
  const summary = s.cards
    .map((c) => c.status + (c.workItem ? " " + c.workItem.id : "") + (c.matchTier ? " [" + c.matchTier + "]" : ""))
    .join(", ");
  console.log("  " + s.label.padEnd(32) + " " + s.topicCount + " topics -> " + s.cards.length + " card(s): " + summary);
}
console.log("\nWrote teamsapp/cards.json");
