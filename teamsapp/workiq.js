// Live WorkIQ access for the server.
//
// WorkIQ is an MCP server that runs locally as `agency mcp workiq`, so the
// server can talk to it directly over stdio instead of reading a snapshot
// somebody captured earlier. This is what makes the Sync button real.
//
// The child process is started once and kept alive. The handshake costs about
// three seconds, and paying that on every request would make an already slow
// call (ten to fifteen seconds) feel broken.
const { spawn } = require("child_process");

const HANDSHAKE_MS = 30000;
const CALL_MS = 120000;

let child = null;
let ready = null;
let nextId = 1;
const pending = new Map();

function reset(reason) {
  for (const [, p] of pending) p.reject(new Error("WorkIQ connection lost: " + reason));
  pending.clear();
  child = null;
  ready = null;
}

function start() {
  if (ready) return ready;

  child = spawn("agency", ["mcp", "workiq"], { stdio: ["pipe", "pipe", "pipe"] });

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    // One JSON object per line is how MCP frames messages over stdio.
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      const p = msg.id != null && pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
    }
  });
  // agency writes its banner to stderr; it is not an error.
  child.stderr.on("data", () => {});
  child.on("exit", (code) => reset("agency exited with code " + code));
  child.on("error", (e) => reset(e.message));

  ready = (async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ado-sync", version: "1.0.0" },
    }, HANDSHAKE_MS);
    if (init.error) throw new Error("WorkIQ handshake failed: " + JSON.stringify(init.error));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return init.result;
  })().catch((e) => { reset(e.message); throw e; });

  return ready;
}

function rpc(method, params, timeout) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (!child || !child.stdin.writable) return reject(new Error("WorkIQ is not running"));
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(method + " timed out after " + Math.round(timeout / 1000) + "s"));
      }
    }, timeout);
  });
}

async function callTool(name, args) {
  await start();
  const res = await rpc("tools/call", { name, arguments: args }, CALL_MS);
  if (res.error) throw new Error(JSON.stringify(res.error));
  return res.result;
}

/** WorkIQ returns its retrieval payload as markdown under a vendor key. */
function markdownFrom(result) {
  const sc = (result && result.structuredContent) || {};
  for (const k of Object.keys(sc)) {
    if (sc[k] && typeof sc[k].markdown === "string") return sc[k].markdown;
  }
  const content = (result && result.content) || [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return text || "";
}

/**
 * Parses the retrieval markdown into meetings.
 *
 * Shape is `- **Title** [^h1]` followed by indented `- **key:** value` lines.
 * Occurrences of the same series repeat, so they are folded by title and the
 * richest occurrence wins -- a past occurrence carries `isMeetingTranscribed`
 * while a future one does not.
 */
function parseMeetings(md) {
  const byTitle = new Map();
  let current = null;

  for (const raw of md.split("\n")) {
    const top = raw.match(/^-\s+\*\*(.+?)\*\*(?:\s*\[\^[^\]]+\])?\s*$/);
    if (top) {
      current = { title: top[1].trim(), fields: {} };
      const key = current.title.toLowerCase();
      if (!byTitle.has(key)) byTitle.set(key, current);
      else current = byTitle.get(key);
      continue;
    }
    const field = raw.match(/^\s+-\s+\*\*(.+?):\*\*\s*(.*)$/);
    if (field && current) {
      const k = field[1].trim();
      const v = field[2].trim();
      // Keep the first non-empty value, except for flags where "true" wins:
      // one occurrence being transcribed is what matters.
      if (k === "isMeetingTranscribed") {
        if (current.fields[k] !== "true") current.fields[k] = v;
      } else if (!current.fields[k]) {
        current.fields[k] = v;
      }
    }
  }

  return [...byTitle.values()]
    // A cancelled series is still on the calendar but will not produce updates.
    .filter((m) => !/^canceled:/i.test(m.title))
    .map((m) => ({
      title: unescapeMd(m.title),
      schedule: unescapeMd(m.fields.recurrenceInformation || m.fields.start || ""),
      organizer: unescapeMd(m.fields.organizerName || ""),
      transcribed: m.fields.isMeetingTranscribed === "true",
      recapUrl: (m.fields.meetingRecapUrl || "").replace(/\\_/g, "_"),
      lastSeen: m.fields.start || "",
    }));
}

/**
 * Undoes the escaping WorkIQ applies for its markdown tables.
 *
 * A pipe in a title arrives as the numeric entity `&#124;`, which rendered
 * literally as "BOSS&#124;SNAP" in the tab. Backslash escapes come back the
 * same way.
 */
function unescapeMd(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, "$1")
    .trim();
}

/** Meetings the signed-in user attends, read live from WorkIQ. */
async function meetings() {
  const result = await callTool("retrieve", {
    query: ["recurring meetings and standups I attend"],
    capabilities: [{ name: "Meetings" }],
  });
  return parseMeetings(markdownFrom(result));
}

/**
 * The speaker's own update from the most recent occurrence of a meeting.
 *
 * Copilot is asked for a strict shape so the answer can be parsed rather than
 * shown as prose, and is told to say NO_UPDATE rather than summarise the room
 * when this person did not speak. Inventing an update for someone who was
 * silent is the one failure this product must not have.
 */
async function transcript(meetingTitle, speaker) {
  const question =
    'From the most recent occurrence of the meeting titled "' + meetingTitle + '" that ' + speaker +
    " actually spoke in, list what " + speaker + " said as their own status update.\n\n" +
    "Reply in exactly this format and nothing else:\n" +
    "MEETING_DATE: <YYYY-MM-DD of that occurrence>\n" +
    "- DONE: <something they finished>\n" +
    "- IN PROGRESS: <something under way>\n" +
    "- NEXT: <something they will start>\n\n" +
    "Rules:\n" +
    "- One bullet per distinct topic, as many as needed.\n" +
    // A bullet like "I'll also compare them" has no subject once it leaves the
    // conversation, and matches a work item on the bare word "compare". Each
    // line has to name the thing it is about to be matchable at all.
    "- Each bullet must stand alone: name the component, product or work it " +
    "concerns, never a bare pronoun like \"it\" or \"them\".\n" +
    "- Use only " + speaker + "'s own words and terminology, never another " +
    "attendee's, and do not invent detail they did not say.\n" +
    "- Keep any work item numbers exactly as spoken.\n" +
    "- Do not add citations, footnote markers or reference numbers.\n" +
    "If " + speaker + " did not speak in any recent occurrence, reply with exactly: NO_UPDATE";

  const result = await callTool("ask", { question });
  const md = markdownFrom(result);

  // Copilot echoes its answer twice in the payload; the first copy is enough.
  const half = md.slice(0, Math.ceil(md.length / 2));
  const body = md.indexOf("MEETING_DATE:") !== -1 && half.indexOf("MEETING_DATE:") !== -1 ? half : md;

  if (/NO_UPDATE/.test(body)) return { spoke: false, date: null, topics: [], raw: body };

  const dateMatch = body.match(/MEETING_DATE:\s*(\d{4}-\d{2}-\d{2})/);
  const topics = [];
  for (const line of body.split("\n")) {
    const m = line.trim().match(/^[-*]\s*(DONE|IN PROGRESS|NEXT|BLOCKED)\s*:\s*(.+)$/i);
    if (!m) continue;
    const text = m[2]
      // Copilot footnotes look like [1](url). Keeping the label turned every
      // bullet into "...the DPU machines 1", and that stray digit was scored
      // as a term. Citations are dropped; real links keep their text.
      .replace(/\[\s*\d+\s*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) topics.push({ title: meetingTitle, status: m[1].toUpperCase(), text });
  }
  return { spoke: topics.length > 0, date: dateMatch ? dateMatch[1] : null, topics, raw: body };
}

function stop() {
  if (child) { try { child.kill(); } catch (e) { /* already gone */ } }
  reset("stopped");
}

module.exports = { callTool, meetings, transcript, parseMeetings, markdownFrom, stop };
