// Serves the tab over HTTPS, and performs the guarded write when a card is
// approved.
//
// Teams will not render a tab over plain HTTP, which is why an http server
// leaves the tab blank with no error at all. It also will not render a
// certificate it does not trust -- see setup-dev-cert.ps1.
//
// The write goes to Azure DevOps under the SIGNED-IN USER's own identity, using
// a short-lived Microsoft Entra token from the Azure CLI rather than a personal
// access token. The token is acquired server-side and never reaches the browser.
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const { buildPatch, isStaleRevRejection } = require(path.join(__dirname, "..", "out", "write.js"));
const { recordDecision, summarise } = require(path.join(__dirname, "..", "out", "telemetry.js"));
const { buildGroupProposal } = require(path.join(__dirname, "..", "out", "consolidate.js"));
const { createWatcher } = require(path.join(__dirname, "watcher.js"));

const PORT = Number(process.env.ADOSYNC_PORT || 53000);
const CERT = path.join(__dirname, "devcert.pfx");
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"; // Azure DevOps

// Who "you" are. Read from enrolment so the agent can never speak for someone
// who did not attend.
const DEFAULT_SPEAKER = (function () {
  try {
    const f = path.join(__dirname, "..", "data", "enrollment.json");
    const e = JSON.parse(fs.readFileSync(f, "utf8"));
    return e.displayName || e.speaker || "Ankit Kushwaha";
  } catch (e) {
    return "Ankit Kushwaha";
  }
})();

// How often to look for a new transcript of a subscribed meeting. Transcripts
// land hours after a meeting, so polling faster only hammers WorkIQ. Subscribing
// and finishing a meeting both trigger a check straight away, so the long
// interval is a backstop rather than the main path.
const WATCH_INTERVAL_MS = Number(process.env.ADOSYNC_WATCH_MS || 6 * 60 * 60 * 1000);

// "every 6h" reads better than "every 21600s" in logs and on the heartbeat.
function everyLabel(ms) {
  if (ms >= 3600000 && ms % 3600000 === 0) return ms / 3600000 + "h";
  if (ms >= 60000 && ms % 60000 === 0) return ms / 60000 + "m";
  return Math.round(ms / 1000) + "s";
}

// Assigned once the helpers it depends on are defined, below.
let watcher = null;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".mp4": "video/mp4",
};

let cachedToken = null; // { token, expires }

function adoToken() {
  if (cachedToken && cachedToken.expires - Date.now() > 120000) {
    return Promise.resolve(cachedToken.token);
  }
  return new Promise((resolve, reject) => {
    execFile(
      process.env.ComSpec || "cmd.exe",
      ["/c", "az", "account", "get-access-token", "--resource", ADO_RESOURCE, "-o", "json"],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error("could not get an Azure DevOps token: " + (stderr || err.message)));
        try {
          const j = JSON.parse(stdout);
          cachedToken = { token: j.accessToken, expires: new Date(j.expiresOn).getTime() };
          resolve(cachedToken.token);
        } catch (e) {
          reject(new Error("unexpected token response: " + e.message));
        }
      }
    );
  });
}

function patchWorkItem(org, project, id, patch, token) {
  const body = JSON.stringify(patch);
  const options = {
    method: "PATCH",
    hostname: "dev.azure.com",
    path: `/${org}/${project}/_apis/wit/workitems/${id}?api-version=7.1`,
    headers: {
      "Content-Type": "application/json-patch+json",
      "Content-Length": Buffer.byteLength(body),
      Authorization: "Bearer " + token,
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function readJson(req, limit = 8e6) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      raw += c;
      // A caption file for a long meeting is comfortably past the old 1 MB
      // ceiling. Stop reading rather than keep buffering a body we rejected.
      if (raw.length > limit) {
        done = true;
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      if (done) return;
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

function messageFrom(raw) {
  try { return JSON.parse(raw).message || raw; } catch (e) { return raw; }
}

async function approve(req, res) {
  let card;
  try {
    card = await readJson(req);
  } catch (e) {
    return send(res, 400, { ok: false, error: "bad request body" });
  }

  const { org, project, workItem, comment, stateChange, dryRun } = card || {};
  if (!org || !project || !workItem || !workItem.id || typeof workItem.rev !== "number" || !comment) {
    return send(res, 400, { ok: false, error: "missing org, project, workItem{id,rev} or comment" });
  }

  const patch = buildPatch(
    { id: workItem.id, rev: workItem.rev, state: workItem.state },
    { commentMarkdown: comment, stateChange: stateChange || null, nextAction: "", stateRationale: "" }
  );

  if (dryRun) return send(res, 200, { ok: true, dryRun: true, patch });

  let token;
  try {
    token = await adoToken();
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message, hint: "run: az login" });
  }

  let result;
  try {
    result = await patchWorkItem(org, project, workItem.id, patch, token);
  } catch (e) {
    return send(res, 502, { ok: false, error: e.message });
  }

  // A rejected revision is the guard working, not a failure to bury: the person
  // needs to re-read the item and decide again.
  if (result.status >= 400 && isStaleRevRejection(result.body)) {
    return send(res, 409, {
      ok: false, staleRev: true, expectedRev: workItem.rev,
      error: messageFrom(result.body), patch,
    });
  }

  if (result.status >= 400) {
    return send(res, result.status, { ok: false, error: messageFrom(result.body), patch });
  }

  const updated = JSON.parse(result.body);
  fs.appendFileSync(
    path.join(__dirname, "approvals.log"),
    JSON.stringify({ at: new Date().toISOString(), id: workItem.id, fromRev: workItem.rev, toRev: updated.rev }) + "\n"
  );

  send(res, 200, {
    ok: true,
    workItemId: updated.id,
    previousRev: workItem.rev,
    newRev: updated.rev,
    url: `https://dev.azure.com/${org}/${project}/_workitems/edit/${updated.id}`,
    patch,
  });
}

function getWorkItem(org, project, id, token) {
  const options = {
    method: "GET",
    hostname: "dev.azure.com",
    path: `/${org}/${project}/_apis/wit/workitems/${id}?api-version=7.1&fields=System.Rev,System.State,System.Title,System.ChangedDate,System.History,System.ChangedBy,System.WorkItemType`,
    headers: { Authorization: "Bearer " + token },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Current state of a work item, so a card can assert the revision the person
 * was actually shown.
 *
 * Re-reading at approve time instead would defeat the guard entirely: it would
 * always assert whatever is current, which is exactly the clobbering the guard
 * exists to prevent. The revision has to be the one on screen.
 */
async function workItemState(req, res, url) {
  const org = url.searchParams.get("org");
  const project = url.searchParams.get("project");
  const id = url.searchParams.get("id");
  if (!org || !project || !id) {
    return send(res, 400, { ok: false, error: "missing org, project or id" });
  }

  let token;
  try {
    token = await adoToken();
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message, hint: "run: az login" });
  }

  let result;
  try {
    result = await getWorkItem(org, project, id, token);
  } catch (e) {
    return send(res, 502, { ok: false, error: e.message });
  }
  if (result.status >= 400) {
    return send(res, result.status, { ok: false, error: messageFrom(result.body) });
  }

  const wi = JSON.parse(result.body);
  const changedBy = wi.fields["System.ChangedBy"];
  send(res, 200, {
    ok: true,
    id: wi.id,
    rev: wi.rev,
    type: wi.fields["System.WorkItemType"],
    state: wi.fields["System.State"],
    title: wi.fields["System.Title"],
    changedDate: wi.fields["System.ChangedDate"],
    changedBy: changedBy ? (changedBy.displayName || changedBy) : null,
    changedByMail: changedBy && changedBy.uniqueName ? changedBy.uniqueName : null,
    history: wi.fields["System.History"] || null,
  });
}

/** Work items the person could retarget a card to. */
async function workItemChoices(req, res, url) {
  const org = url.searchParams.get("org");
  const project = url.searchParams.get("project");
  const identity = url.searchParams.get("identity");
  if (!org || !project || !identity) {
    return send(res, 400, { ok: false, error: "missing org, project or identity" });
  }

  let token;
  try { token = await adoToken(); }
  catch (e) { return send(res, 500, { ok: false, error: e.message, hint: "run: az login" }); }

  const wiql = {
    query:
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '" + project +
      "' AND [System.AssignedTo] = '" + identity.replace(/'/g, "''") +
      "' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC",
  };

  const ids = await new Promise((resolve, reject) => {
    const body = JSON.stringify(wiql);
    const r = https.request({
      method: "POST", hostname: "dev.azure.com",
      path: `/${org}/${project}/_apis/wit/wiql?api-version=7.1&$top=50`,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
                 Authorization: "Bearer " + token },
    }, (resp) => {
      let t = ""; resp.on("data", (c) => (t += c));
      resp.on("end", () => {
        try { resolve((JSON.parse(t).workItems || []).map((w) => w.id).slice(0, 30)); }
        catch (e) { reject(e); }
      });
    });
    r.on("error", reject); r.write(body); r.end();
  }).catch(() => null);

  if (!ids || ids.length === 0) return send(res, 200, { ok: true, items: [] });

  const batchBody = JSON.stringify({
    ids, fields: ["System.Id", "System.WorkItemType", "System.Title", "System.State", "System.Rev"],
  });
  const items = await new Promise((resolve, reject) => {
    const r = https.request({
      method: "POST", hostname: "dev.azure.com",
      path: `/${org}/${project}/_apis/wit/workitemsbatch?api-version=7.1`,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(batchBody),
                 Authorization: "Bearer " + token },
    }, (resp) => {
      let t = ""; resp.on("data", (c) => (t += c));
      resp.on("end", () => {
        try {
          resolve((JSON.parse(t).value || []).map((w) => ({
            id: w.id, rev: w.rev,
            type: w.fields["System.WorkItemType"],
            title: w.fields["System.Title"],
            state: w.fields["System.State"],
          })));
        } catch (e) { reject(e); }
      });
    });
    r.on("error", reject); r.write(batchBody); r.end();
  }).catch(() => []);

  send(res, 200, { ok: true, items });
}

/**
 * Records what happened to a suggestion.
 *
 * This is the data the decision to relax the Approve button rests on, and the
 * figure that matters is not how often people approved -- people approve to
 * clear a queue -- but how often they approved WITHOUT editing, per tier.
 */
async function recordDecisionEndpoint(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return send(res, 400, { ok: false, error: "bad request body" }); }

  const { card, provenance, outcome, meeting, speaker, sourceId } = payload || {};
  if (!card || !outcome) return send(res, 400, { ok: false, error: "missing card or outcome" });

  const record = recordDecision(
    {
      speaker: speaker || "unknown",
      status: card.status,
      workItem: card.workItem || undefined,
      updates: (card.updates || []).map((u) => ({
        text: u.text, topic: u.topic, progress: u.progress,
        tier: card.matchTier || "assigned", reason: "", corroborated: false,
        corrections: u.corrections || undefined,
      })),
      corroboration: card.corroboration || undefined,
      controls: [],
    },
    meeting || "unknown",
    outcome,
    { provenance: provenance || undefined }
  );

  // sourceId ties the decision back to the transcript tile it came from, which
  // is what lets the home page mark that tile done. The meeting string alone is
  // ambiguous once the same meeting has run on more than one day.
  const line = { ...record, sourceId: sourceId || null };
  fs.appendFileSync(path.join(__dirname, "decisions.log"), JSON.stringify(line) + "\n");
  send(res, 200, { ok: true, record: line });
}

/**
 * Rebuilds the comment after an edit.
 *
 * The comment body is generated by the engine, not by the browser: the state
 * rule ("anything outstanding anywhere leaves the state alone") has to stay in
 * one place, or the tab and the CLI will quietly disagree about what a set of
 * updates means.
 */
async function rebuild(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return send(res, 400, { ok: false, error: "bad request body" }); }

  const { updates, workItem, meetingDate } = payload || {};
  if (!Array.isArray(updates) || !workItem) {
    return send(res, 400, { ok: false, error: "missing updates or workItem" });
  }
  if (updates.length === 0) {
    return send(res, 200, { ok: true, empty: true, proposed: null });
  }

  const proposed = buildGroupProposal(
    updates.map((u) => ({
      text: u.text, topic: u.topic, progress: u.progress,
      tier: "assigned", reason: "", corroborated: false,
      corrections: u.corrections || undefined,
    })),
    { id: workItem.id, rev: workItem.rev, state: workItem.state, title: workItem.title,
      type: workItem.type, assignedTo: null, assignedToName: null, changedDate: "" },
    meetingDate ? new Date(meetingDate) : new Date()
  );
  send(res, 200, { ok: true, proposed });
}

function serveFile(req, res) {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(__dirname, rel === "/" ? "index.html" : rel);

  if (!file.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  // The certificate, its password and the approval log stay off the wire.
  if (/devcert\.(pfx|pwd|cer)$|approvals\.log$/i.test(file)) {
    res.writeHead(403);
    return res.end("forbidden");
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Security-Policy":
        "frame-ancestors teams.microsoft.com *.teams.microsoft.com *.skype.com *.office.com;",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

/**
 * The meetings this person has asked ADO Sync to watch.
 *
 * This is a list the user maintains, not one read from their calendar. Every
 * meeting-scoped Graph API returns `403 3003` for a participant who was not the
 * organiser, so the calendar route is closed to us -- see TEAMS-APP-PLAN.md.
 */
const WATCHED = path.join(__dirname, "..", "data", "watched-meetings.json");

function readWatched() {
  if (!fs.existsSync(WATCHED)) return [];
  try { return JSON.parse(fs.readFileSync(WATCHED, "utf8")).meetings || []; }
  catch (e) { return []; }
}

function writeWatched(meetings) {
  fs.mkdirSync(path.dirname(WATCHED), { recursive: true });
  fs.writeFileSync(WATCHED, JSON.stringify({ meetings }, null, 2));
}

async function listMeetings(req, res) {
  send(res, 200, { ok: true, meetings: readWatched() });
}

async function addMeeting(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return send(res, 400, { ok: false, error: "bad request body" }); }

  const title = String((payload || {}).title || "").trim();
  if (!title) return send(res, 400, { ok: false, error: "a meeting needs a title" });

  const meetings = readWatched();
  if (meetings.some((m) => m.title.toLowerCase() === title.toLowerCase())) {
    return send(res, 200, { ok: true, meetings, duplicate: true });
  }
  meetings.push({
    title,
    schedule: String((payload || {}).schedule || "").trim(),
    addedAt: new Date().toISOString(),
  });
  writeWatched(meetings);
  send(res, 200, { ok: true, meetings });
}

async function removeMeeting(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return send(res, 400, { ok: false, error: "bad request body" }); }

  const title = String((payload || {}).title || "").toLowerCase();
  const meetings = readWatched().filter((m) => m.title.toLowerCase() !== title);
  writeWatched(meetings);
  send(res, 200, { ok: true, meetings });
}

/**
 * Accepts a `.vtt`, `.md` or `.json` transcript and turns it into cards.
 *
 * The file is parsed, written into data/transcripts/, and the card builder is
 * re-run over every transcript. Rebuilding everything rather than just the new
 * file keeps one code path producing cards.json, so what the tab renders can
 * never diverge from what `npm run cards` would produce.
 */
async function uploadTranscript(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return send(res, 400, { ok: false, error: "bad request body" }); }

  const { filename, content, speaker, meeting, date, label } = payload || {};
  if (!filename || !content) return send(res, 400, { ok: false, error: "missing filename or content" });

  const { parseTranscriptFile } = require(path.join(__dirname, "..", "out", "parse.js"));

  let parsed;
  try {
    parsed = parseTranscriptFile({
      filename,
      content,
      speaker: speaker || "Ankit Kushwaha",
      meeting: meeting || undefined,
      date: date || undefined,
      label: label || undefined,
    });
  } catch (e) {
    return send(res, 400, { ok: false, error: e.message });
  }

  if (!parsed.topics.length) {
    // Saving an empty transcript would produce a tile with nothing in it and
    // look like the engine failed, when in fact the attribution was wrong.
    return send(res, 400, {
      ok: false,
      error:
        "No lines found for " + (speaker || "you") + " in that file." +
        (parsed.speakers.length
          ? " Speakers present: " + parsed.speakers.join(", ") + "."
          : ""),
      speakers: parsed.speakers,
    });
  }

  const dir = path.join(__dirname, "..", "data", "transcripts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, parsed.id + ".json");
  fs.writeFileSync(file, JSON.stringify({
    id: parsed.id,
    label: parsed.label,
    meeting: parsed.meeting,
    date: parsed.date,
    speaker: parsed.speaker,
    blurb: "Uploaded " + parsed.format + " transcript, " + parsed.topics.length + " topic(s).",
    expect: "",
    topics: parsed.topics,
    exclude: parsed.exclude,
  }, null, 2));

  execFile(
    process.execPath,
    [path.join(__dirname, "..", "tools", "build-cards.js")],
    { cwd: path.join(__dirname, "..") },
    (err, stdout, stderr) => {
      if (err) return send(res, 500, { ok: false, error: (stderr || err.message).trim() });
      send(res, 200, {
        ok: true,
        id: parsed.id,
        label: parsed.label,
        topics: parsed.topics.length,
        speakers: parsed.speakers,
        format: parsed.format,
        log: String(stdout).trim(),
      });
    }
  );
}

/**
 * Meetings WorkIQ finds for this person, marked with whether each is watched.
 *
 * This is a live call. WorkIQ runs locally as `agency mcp workiq`, so the
 * server drives it over stdio rather than reading a snapshot somebody captured
 * earlier -- see workiq.js. The call takes twelve to sixteen seconds, so the
 * last good result is held in memory and a reload reuses it; the Sync button
 * passes refresh=1 to force a fresh one.
 */
const workiq = require(path.join(__dirname, "workiq.js"));

let meetingCache = null;

async function discoverMeetings(req, res, url) {
  const force = url.searchParams.get("refresh") === "1";
  const watched = readWatched().map((m) => m.title.toLowerCase());
  const mark = (list) =>
    list.map((m) => ({ ...m, watched: watched.indexOf(String(m.title).toLowerCase()) !== -1 }));

  if (!force && meetingCache) {
    return send(res, 200, {
      ok: true, live: true, cached: true,
      fetchedAt: meetingCache.fetchedAt,
      meetings: mark(meetingCache.meetings),
    });
  }

  try {
    const found = await workiq.meetings();
    meetingCache = { fetchedAt: new Date().toISOString(), meetings: found };

    // Refresh stored schedules from what WorkIQ actually reports. A watch entry
    // typed by hand drifts from the real series -- "NODE WKLD Sync, Tuesdays
    // 15:30" against WorkIQ's "NODE WKLD Daily Sync, Mon/Wed/Fri 4:00 PM" -- and
    // then the title no longer matches, so the meeting silently reads as not
    // watched.
    const stored = readWatched();
    let changed = false;
    for (const s of stored) {
      const hit = found.find((m) => m.title.toLowerCase() === s.title.toLowerCase());
      if (hit && hit.schedule && s.schedule !== hit.schedule) {
        s.schedule = hit.schedule;
        changed = true;
      }
    }
    if (changed) writeWatched(stored);

    send(res, 200, {
      ok: true, live: true, cached: false,
      fetchedAt: meetingCache.fetchedAt,
      meetings: mark(found),
    });
  } catch (e) {
    // Reporting the failure beats quietly serving stale data as if it were live.
    send(res, 502, {
      ok: false,
      error: "WorkIQ did not answer: " + e.message,
      hint: "Check that `agency mcp workiq` runs and you are signed in.",
      meetings: meetingCache ? mark(meetingCache.meetings) : [],
      stale: !!meetingCache,
      fetchedAt: meetingCache ? meetingCache.fetchedAt : null,
    });
  }
}

/** Adds or removes a meeting from the watch list in one call. */
async function toggleMeeting(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return send(res, 400, { ok: false, error: "bad request body" }); }

  const title = String((payload || {}).title || "").trim();
  if (!title) return send(res, 400, { ok: false, error: "a meeting needs a title" });
  const want = !!(payload || {}).watched;

  let meetings = readWatched();
  const has = meetings.some((m) => m.title.toLowerCase() === title.toLowerCase());

  if (want && !has) {
    meetings.push({
      title,
      schedule: String((payload || {}).schedule || "").trim(),
      addedAt: new Date().toISOString(),
      source: "workiq",
    });
  } else if (!want && has) {
    meetings = meetings.filter((m) => m.title.toLowerCase() !== title.toLowerCase());
  }
  writeWatched(meetings);

  // Subscribing is the whole interaction. From here the transcript is fetched
  // and a card is built without the user asking again -- so the response is
  // sent immediately rather than waiting on WorkIQ.
  if (watcher) {
    if (want && !has) watcher.onSubscribe(title);
    else if (!want && has) watcher.onUnsubscribe(title);
  }

  send(res, 200, { ok: true, watched: want, meetings });
}

/**
 * Pulls this person's own update for a watched meeting straight from WorkIQ.
 *
 * This is the path that needs no file at all: Copilot is asked what the person
 * said in the most recent occurrence they spoke in, the answer is written as a
 * transcript, and the cards are rebuilt. A meeting where they said nothing
 * produces no transcript rather than an invented one.
 */
/**
 * Turn a pulled transcript into a stored transcript file and rebuild the cards.
 *
 * Shared by the manual pull and by the watcher, so an autonomously produced
 * card is byte-for-byte the same artefact as a hand-pulled one. Resolves once
 * the card build finishes.
 */
function ingestPulled(title, speaker, pulled) {
  return new Promise((resolve, reject) => {
    const date = pulled.date ? pulled.date + "T09:00:00.000Z" : new Date().toISOString();
    const id = (title + "-" + date.slice(0, 10))
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

    const dir = path.join(__dirname, "..", "data", "transcripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({
      id,
      label: title + " — " + pulled.date,
      meeting: title,
      date,
      speaker,
      blurb: "Pulled live from WorkIQ, " + pulled.topics.length + " topic(s).",
      expect: "",
      topics: pulled.topics,
      exclude: [],
    }, null, 2));

    execFile(
      process.execPath,
      [path.join(__dirname, "..", "tools", "build-cards.js")],
      { cwd: path.join(__dirname, "..") },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        resolve({ id, date: pulled.date, topics: pulled.topics.length, log: String(stdout).trim() });
      }
    );
  });
}

async function pullTranscript(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return send(res, 400, { ok: false, error: "bad request body" }); }

  const title = String((payload || {}).title || "").trim();
  const speaker = String((payload || {}).speaker || DEFAULT_SPEAKER).trim();
  if (!title) return send(res, 400, { ok: false, error: "which meeting?" });

  let pulled;
  try { pulled = await workiq.transcript(title, speaker); }
  catch (e) { return send(res, 502, { ok: false, error: "WorkIQ did not answer: " + e.message }); }

  if (!pulled.spoke || !pulled.topics.length) {
    return send(res, 200, {
      ok: true, spoke: false,
      message: speaker + " has no recorded update in a recent " + title + ".",
    });
  }

  try {
    const result = await ingestPulled(title, speaker, pulled);
    if (watcher) watcher.noteIngested(title, pulled.date);
    send(res, 200, { ok: true, spoke: true, ...result });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
}

function handler(req, res) {
  const url = new URL(req.url, "https://localhost:" + PORT);
  const route = url.pathname;

  if (req.method === "POST" && route === "/api/transcript/pull") {
    return pullTranscript(req, res).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "GET" && route === "/api/watcher") {
    return send(res, 200, { ok: true, ...(watcher ? watcher.status() : { running: false }) });
  }
  // Runs the same poll the interval runs. The interval is hours long, so this is
  // how a check is forced on demand -- by prove-ambient, and when you don't want
  // to wait. It builds cards exactly as the timer does; it still never writes.
  if (req.method === "POST" && route === "/api/watcher/tick") {
    if (!watcher) return send(res, 200, { ok: false, error: "watcher not running" });
    return watcher.tickOnce("manual")
      .then((r) => send(res, 200, { ok: true, produced: (r && r.produced) || [] }))
      .catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "GET" && route === "/api/meetings/discover") {
    return discoverMeetings(req, res, url).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "POST" && route === "/api/meetings/toggle") {
    return toggleMeeting(req, res).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "GET" && route === "/api/meetings") {
    return listMeetings(req, res).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "POST" && route === "/api/meetings") {
    return addMeeting(req, res).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "POST" && route === "/api/meetings/remove") {
    return removeMeeting(req, res).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "POST" && route === "/api/transcript") {
    return uploadTranscript(req, res).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "POST" && route === "/api/approve") {
    return approve(req, res).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "POST" && route === "/api/decision") {
    return recordDecisionEndpoint(req, res).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "POST" && route === "/api/rebuild") {
    return rebuild(req, res).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "GET" && route === "/api/workitem") {
    return workItemState(req, res, url).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "GET" && route === "/api/workitems") {
    return workItemChoices(req, res, url).catch((e) => send(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === "GET" && route === "/api/decisions") {
    const file = path.join(__dirname, "decisions.log");
    const rows = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return send(res, 200, { ok: true, count: rows.length, byTier: summarise(rows), rows });
  }
  if (req.method !== "GET") {
    res.writeHead(405);
    return res.end("method not allowed");
  }
  serveFile(req, res);
}

// The ambient trigger. Subscribing to a meeting is the last thing a person
// does; from then on the transcript is fetched and cards are built on their
// own. It never writes -- approval and the revision test still gate that.
watcher = createWatcher({
  readWatched,
  probe: (title, speaker) => workiq.transcript(title, speaker),
  ingest: (title, speaker, pulled) => ingestPulled(title, speaker, pulled),
  speaker: DEFAULT_SPEAKER,
  intervalMs: WATCH_INTERVAL_MS,
});

if (fs.existsSync(CERT)) {
  const passfile = path.join(__dirname, "devcert.pwd");
  const passphrase = fs.existsSync(passfile) ? fs.readFileSync(passfile, "utf8").trim() : "";
  https.createServer({ pfx: fs.readFileSync(CERT), passphrase }, handler).listen(PORT, () => {
    console.log(`HTTPS  https://localhost:${PORT}/index.html`);
    console.log("Approve performs a real guarded write to Azure DevOps as the signed-in user.");
    console.log(`Watching subscribed meetings every ${everyLabel(WATCH_INTERVAL_MS)}.`);
    watcher.start();
  });
} else {
  http.createServer(handler).listen(PORT, () => {
    console.log(`HTTP   http://localhost:${PORT}/index.html`);
    console.log("");
    console.log("No devcert.pfx found, so this is plain HTTP.");
    console.log("A browser renders it fine. Teams will NOT -- the tab stays blank.");
    console.log("Run:  powershell -ExecutionPolicy Bypass -File setup-dev-cert.ps1");
    console.log("");
    console.log(`Watching subscribed meetings every ${everyLabel(WATCH_INTERVAL_MS)}.`);
    watcher.start();
  });
}
