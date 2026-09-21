/**
 * Puts a meeting back to "never seen" so the ambient trigger can be watched
 * happening again.
 *
 * Unsubscribing is deliberately not enough. It clears the occurrence key the
 * watcher dedupes on, but it does not delete a card the agent already built --
 * cards outlive subscriptions on purpose, because a proposal you have not
 * reviewed yet should not vanish because you stopped watching the series. That
 * is right for a person and wrong for a demo, where the point is to see a card
 * appear where there was none.
 *
 *   node tools/reset-demo.js "Daily Standup"
 *   node tools/reset-demo.js --list
 *
 * Nothing here touches Azure DevOps. It only removes local transcripts the
 * agent produced, and the watcher's memory of having produced them.
 */

const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "data");
const TRANSCRIPTS = path.join(DATA, "transcripts");
const STATE = path.join(DATA, "watcher-state.json");
const WATCHED = path.join(DATA, "watched-meetings.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

/**
 * The transcript the watcher would refuse to rebuild.
 *
 * Only the occurrence recorded in the watcher's `seen` map, because that single
 * entry is what makes a re-subscribe answer "already have that one". Older
 * occurrences are real work the person may still want to review, and hand-made
 * fixtures merely share the meeting name -- deleting either would be a
 * destructive surprise from a script meant to be run casually.
 */
function blockingTranscript(title, occurrence) {
  if (!occurrence || !fs.existsSync(TRANSCRIPTS)) return null;

  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const id = `${slug}-${occurrence}`;
  const full = path.join(TRANSCRIPTS, `${id}.json`);
  if (!fs.existsSync(full)) return null;

  const j = readJson(full, null);
  if (!j || String(j.meeting || "").toLowerCase() !== String(title).toLowerCase()) return null;
  return { file: `${id}.json`, full };
}

function readWatched() {
  // The file is an object with a meetings array, not a bare array.
  const j = readJson(WATCHED, null);
  if (Array.isArray(j)) return j;
  return (j && Array.isArray(j.meetings)) ? j.meetings : [];
}

const arg = process.argv[2];

if (!arg || arg === "--list") {
  const state = readJson(STATE, { seen: {} });
  const watched = readWatched();
  console.log("Meetings with transcripts on disk:\n");
  const seen = new Map();
  if (fs.existsSync(TRANSCRIPTS)) {
    for (const f of fs.readdirSync(TRANSCRIPTS).filter((x) => x.endsWith(".json"))) {
      const j = readJson(path.join(TRANSCRIPTS, f), null);
      if (!j || !j.meeting) continue;
      seen.set(j.meeting, (seen.get(j.meeting) || 0) + 1);
    }
  }
  for (const [m, n] of seen) {
    const sub = watched.some((w) => w.title === m) ? "subscribed" : "not subscribed";
    console.log(`  ${m}`);
    console.log(`      ${n} transcript(s) · ${sub} · last occurrence seen: ${state.seen[m] || "none"}`);
  }
  console.log("\nTo reset one:  node tools/reset-demo.js \"<meeting title>\"");
  process.exit(0);
}

const title = arg;
const state = readJson(STATE, { seen: {} });
const occurrence = (state.seen || {})[title];
const hadSeen = Object.prototype.hasOwnProperty.call(state.seen || {}, title);
const hit = blockingTranscript(title, occurrence);

if (!hit && !hadSeen) {
  console.log(`Nothing to reset for "${title}" -- the watcher has no memory of it, so subscribing will build.`);
  process.exit(0);
}

if (hit) {
  fs.unlinkSync(hit.full);
  console.log(`  removed the card built for occurrence ${occurrence}  (${hit.file})`);
}

if (hadSeen) {
  delete state.seen[title];
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`  cleared watcher memory of "${title}"`);
}

console.log(`\n"${title}" is now unseen.`);
console.log("Subscribe to it and the watcher will build a card with no further input.");
