"use strict";

/**
 * The ambient trigger.
 *
 * Everything else in ADO Sync waits for a person. This does not: it watches the
 * meetings you enrolled and starts a run by itself when a transcript for one of
 * them appears. No tab needs to be open and nobody clicks anything.
 *
 * What it deliberately does NOT do is write. It builds a card and stops. Every
 * gate that protected a human-initiated run still stands in front of the write:
 * approval, identity, and the revision test the server enforces. Making the
 * trigger autonomous must not make the *action* autonomous.
 *
 * Two failure modes shaped this:
 *
 *   - Re-ingesting the same meeting. WorkIQ answers about "the most recent
 *     occurrence", so polling twice returns the same transcript twice. Each
 *     meeting's last ingested occurrence is recorded and compared before any
 *     work happens.
 *
 *   - Failing silently. A watcher that quietly stops is worse than no watcher,
 *     because you believe you are covered. Every tick is appended to a log with
 *     its outcome, including the boring ones, so "it is running and finding
 *     nothing" is distinguishable from "it died an hour ago".
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_DATA = path.join(__dirname, "..", "data");

const MAX_LOG_LINES = 500;

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function paths(dataDir) {
  const dir = dataDir || DEFAULT_DATA;
  return {
    dir,
    state: path.join(dir, "watcher-state.json"),
    log: path.join(dir, "watcher.log"),
  };
}

function readState(p) {
  return readJsonFile(p.state, { seen: {} });
}

function writeState(p, state) {
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.state, JSON.stringify(state, null, 2));
}

/** Append-only so a run's history survives a restart; trimmed to stay small. */
function log(p, entry) {
  fs.mkdirSync(p.dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(p.log, line + "\n");

  try {
    const lines = fs.readFileSync(p.log, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      fs.writeFileSync(p.log, lines.slice(-MAX_LOG_LINES).join("\n") + "\n");
    }
  } catch (e) {
    /* trimming is housekeeping; never let it break a tick */
  }
}

function recentRuns(p, limit) {
  const lines = (function () {
    try {
      return fs.readFileSync(p.log, "utf8").split("\n").filter(Boolean);
    } catch (e) {
      return [];
    }
  })();

  return lines
    .slice(-(limit || 40))
    .map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    })
    .filter(Boolean)
    .reverse();
}

function createWatcher(opts) {
  const readWatched = opts.readWatched;
  const probe = opts.probe;              // (title, speaker) -> pulled transcript
  const ingest = opts.ingest;            // (title, speaker, pulled) -> result
  const speaker = opts.speaker;
  const intervalMs = opts.intervalMs || 6 * 60 * 60 * 1000;
  const P = paths(opts.dataDir);

  let timer = null;
  let running = false;                   // guards against overlapping ticks
  let startedAt = null;
  let ticks = 0;
  let lastError = null;

  /**
   * Fetch and build for one meeting, unless that occurrence is already in.
   * Shared by the poll loop and by subscription, so both paths behave
   * identically and neither can double-ingest.
   */
  async function considerMeeting(title, reason) {
    let pulled;
    try {
      pulled = await probe(title, speaker);
    } catch (e) {
      lastError = title + ": " + e.message;
      log(P, { event: "probe-failed", meeting: title, reason, error: e.message });
      return null;
    }

    if (!pulled || !pulled.spoke || !pulled.topics || !pulled.topics.length) {
      log(P, { event: "no-update", meeting: title, reason });
      return null;
    }

    // WorkIQ answers about "the most recent occurrence", so the same transcript
    // comes back until a newer meeting happens. The occurrence date is the
    // idempotency key.
    const key = pulled.date || "unknown";
    const state = readState(P);
    if (state.seen[title] === key) {
      log(P, { event: "already-ingested", meeting: title, occurrence: key, reason });
      return null;
    }

    try {
      const result = await ingest(title, speaker, pulled);
      state.seen[title] = key;
      writeState(P, state);
      log(P, {
        event: "card-built",
        meeting: title,
        occurrence: key,
        topics: pulled.topics.length,
        id: result && result.id,
        reason,
        note: "awaiting human approval - nothing written to Azure DevOps",
      });
      return result;
    } catch (e) {
      lastError = title + ": " + e.message;
      log(P, { event: "ingest-failed", meeting: title, reason, error: e.message });
      return null;
    }
  }

  async function tickOnce(reason) {
    // A slow WorkIQ call must not let a second tick start on top of the first.
    if (running) return { skipped: "a tick is already in progress" };
    running = true;
    ticks++;

    try {
      const meetings = readWatched();
      if (!meetings.length) {
        log(P, { event: "tick", reason, watched: 0, note: "nothing subscribed" });
        return { produced: [] };
      }

      const produced = [];
      for (const m of meetings) {
        const result = await considerMeeting(m.title, reason);
        if (result) produced.push({ meeting: m.title, id: result.id });
      }

      log(P, { event: "tick", reason, watched: meetings.length, produced: produced.length });
      return { produced };
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      startedAt = new Date().toISOString();
      log(P, { event: "watcher-started", intervalMs });
      // A tick on start makes the behaviour observable immediately rather than
      // after a full interval of apparent silence.
      tickOnce("startup").catch((e) => log(P, { event: "tick-failed", error: e.message }));
      timer = setInterval(
        () => tickOnce("interval").catch((e) => log(P, { event: "tick-failed", error: e.message })),
        intervalMs
      );
      if (timer.unref) timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      log(P, { event: "watcher-stopped" });
    },

    tickOnce,

    /**
     * Subscribing is the whole interaction. The user ticks a meeting; from that
     * moment the transcript is fetched and a card is built without them asking
     * again. Deliberately not awaited by the caller: the HTTP response should
     * not block on WorkIQ.
     */
    onSubscribe(title) {
      log(P, { event: "subscribed", meeting: title });
      considerMeeting(title, "subscribe").catch((e) =>
        log(P, { event: "subscribe-failed", meeting: title, error: e.message })
      );
    },

    onUnsubscribe(title) {
      const state = readState(P);
      delete state.seen[title];
      writeState(P, state);
      log(P, { event: "unsubscribed", meeting: title });
    },

    /**
     * Record an occurrence ingested outside the watcher, so a manual pull and
     * the next poll do not produce the same card twice.
     */
    noteIngested(title, occurrence) {
      const state = readState(P);
      state.seen[title] = occurrence || "unknown";
      writeState(P, state);
      log(P, { event: "manual-pull", meeting: title, occurrence: occurrence || "unknown" });
    },

    status() {
      return {
        running: !!timer,
        startedAt,
        intervalMs,
        ticks,
        busy: running,
        lastError,
        seen: readState(P).seen,
        runs: recentRuns(P, 40),
      };
    },
  };
}

module.exports = { createWatcher, recentRuns, paths };
