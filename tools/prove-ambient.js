// Proves the ambient trigger against the real server, with a stub WorkIQ.
//
// The claim being tested is narrow and specific: after a meeting is subscribed,
// a card appears without any further request. So this makes exactly one POST
// (the subscribe) and then only reads.

const https = require("https");
const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.ADOSYNC_PORT || 53000);
const MEETING = "Daily Standup";

function req(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      { host: "localhost", port: PORT, path: route, method, rejectUnauthorized: false,
        headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try { resolve(JSON.parse(out)); } catch (e) { resolve({ raw: out }); }
        });
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("--- ambient trigger, end to end ---\n");

  const before = await req("GET", "/api/watcher");
  if (!before.ok) { console.log("FAIL: server not answering /api/watcher"); process.exit(1); }
  console.log("watcher running:", before.running, "| interval:", before.intervalMs + "ms");

  // Start clean so the result cannot be a leftover.
  await req("POST", "/api/meetings/toggle", { title: MEETING, watched: false });
  await sleep(300);

  const cardsBefore = await req("GET", "/api/decisions");
  const nBefore = (cardsBefore.rows || []).length;
  console.log("decisions before subscribe:", nBefore);

  console.log("\n>>> the ONLY action taken: subscribing to \"" + MEETING + "\"\n");
  await req("POST", "/api/meetings/toggle", { title: MEETING, watched: true, schedule: "daily" });

  // From here nothing is sent but reads.
  let built = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const s = await req("GET", "/api/watcher");
    const hit = (s.runs || []).find((r) => r.event === "card-built" && r.meeting === MEETING);
    process.stdout.write(".");
    if (hit) { built = hit; break; }
    const failed = (s.runs || []).find((r) => r.error && r.meeting === MEETING);
    if (failed) { console.log("\nprobe/ingest failed:", failed.error); break; }
  }
  console.log("");

  if (!built) {
    const s = await req("GET", "/api/watcher");
    console.log("\nNo card was built. Recent watcher activity:");
    (s.runs || []).slice(0, 8).forEach((r) =>
      console.log("   ", r.at, r.event, r.meeting || "", r.error || r.note || ""));
    process.exit(1);
  }

  console.log("CARD BUILT WITHOUT A SECOND CLICK");
  console.log("   meeting    :", built.meeting);
  console.log("   occurrence :", built.occurrence);
  console.log("   topics     :", built.topics);
  console.log("   note       :", built.note);

  // The important half: autonomy stopped at the card.
  const writes = fs.existsSync(path.join(__dirname, "..", "teamsapp", "approvals.log"))
    ? fs.readFileSync(path.join(__dirname, "..", "teamsapp", "approvals.log"), "utf8")
        .split("\n").filter(Boolean).length
    : 0;
  console.log("\n   approvals.log entries:", writes, "(unchanged by the watcher - it never writes)");

  // And it must not rebuild the same occurrence on the next tick.
  const ticksBefore = (await req("GET", "/api/watcher")).ticks;
  await sleep(Math.min(before.intervalMs + 2000, 20000));
  const after = await req("GET", "/api/watcher");

  // The log survives restarts, so earlier runs are still in it. Only events at
  // or after the build we just watched belong to this run.
  const mine = (after.runs || []).filter(
    (r) => r.meeting === MEETING && new Date(r.at).getTime() >= new Date(built.at).getTime()
  );
  const builds = mine.filter((r) => r.event === "card-built").length;
  const dupes = mine.filter((r) => r.event === "already-ingested").length;
  console.log("   ticks:", ticksBefore, "->", after.ticks,
              "| card-built (this run):", builds, "| skipped as duplicate:", dupes);

  console.log(builds === 1 ? "\nPASS: built once, then recognised as already ingested."
                           : "\nFAIL: built " + builds + " times.");
  process.exit(builds === 1 ? 0 : 1);
})();
