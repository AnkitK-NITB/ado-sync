import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// The watcher is plain JS because it lives next to the server rather than in
// the compiled engine, so it is required rather than imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createWatcher } = require(path.join(__dirname, "..", "..", "teamsapp", "watcher.js"));

/**
 * The watcher writes its state and log beside the data directory, so each test
 * runs in its own cwd to keep them from colliding.
 */
function isolated<T>(fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adosync-watch-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  process.chdir(dir);
  return fn().finally(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function transcript(date: string, topicCount = 2) {
  return {
    spoke: true,
    date,
    topics: Array.from({ length: topicCount }, (_, i) => ({
      title: "Topic " + i,
      status: "IN_PROGRESS",
      text: "did the thing",
    })),
  };
}

test("subscribing fetches and builds without anyone asking again", async () => {
  await isolated(async () => {
    const ingested: string[] = [];
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => transcript("2026-09-21"),
      ingest: async (title: string) => {
        ingested.push(title);
        return { id: "daily-standup-2026-09-21" };
      },
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    w.onSubscribe("Daily Standup");
    // onSubscribe deliberately does not block the HTTP response, so settle it.
    await new Promise((r) => setTimeout(r, 30));

    assert.deepEqual(ingested, ["Daily Standup"], "subscribing alone should produce a card");
  });
});

test("the same occurrence is never ingested twice", async () => {
  await isolated(async () => {
    let count = 0;
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => transcript("2026-09-21"),
      ingest: async () => { count++; return { id: "x" }; },
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    await w.tickOnce("test");
    await w.tickOnce("test");
    await w.tickOnce("test");

    assert.equal(count, 1, "polling repeatedly must not rebuild the same card");
  });
});

test("a newer occurrence does produce a new card", async () => {
  await isolated(async () => {
    let date = "2026-09-21";
    let count = 0;
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => transcript(date),
      ingest: async () => { count++; return { id: "x" }; },
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    await w.tickOnce("test");
    date = "2026-09-22";              // tomorrow's standup happens
    await w.tickOnce("test");

    assert.equal(count, 2, "a later occurrence is a different meeting");
  });
});

test("a meeting where you said nothing produces no card", async () => {
  await isolated(async () => {
    let count = 0;
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => ({ spoke: false, date: "2026-09-21", topics: [] }),
      ingest: async () => { count++; return { id: "x" }; },
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    await w.tickOnce("test");
    assert.equal(count, 0, "silence must not be turned into an invented update");
  });
});

test("a WorkIQ failure is recorded, not swallowed", async () => {
  await isolated(async () => {
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => { throw new Error("WorkIQ is not running"); },
      ingest: async () => { throw new Error("should never be reached"); },
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    await w.tickOnce("test");

    const s = w.status();
    assert.match(String(s.lastError), /WorkIQ is not running/);
    assert.ok(
      s.runs.some((r: any) => r.event === "probe-failed"),
      "a watcher that fails quietly is worse than no watcher"
    );
  });
});

test("overlapping ticks do not stack up", async () => {
  await isolated(async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight--;
        return transcript("2026-09-21");
      },
      ingest: async () => ({ id: "x" }),
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    await Promise.all([w.tickOnce("a"), w.tickOnce("b"), w.tickOnce("c")]);
    assert.equal(maxInFlight, 1, "a slow WorkIQ call must not let ticks pile up");
  });
});

test("unsubscribing forgets the meeting, so resubscribing works", async () => {
  await isolated(async () => {
    let count = 0;
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => transcript("2026-09-21"),
      ingest: async () => { count++; return { id: "x" }; },
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    await w.tickOnce("test");
    assert.equal(count, 1);

    w.onUnsubscribe("Daily Standup");
    await w.tickOnce("test");

    assert.equal(count, 2, "resubscribing should be able to rebuild the card");
  });
});

test("discarding a card lets the watcher build it again", async () => {
  // Deleting a card must not be permanent. The occurrence key is what makes a
  // later check say "already have that one", so forgetting it is the whole
  // difference between discarding a proposal and losing the meeting.
  await isolated(async () => {
    let count = 0;
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => transcript("2026-09-21"),
      ingest: async () => { count++; return { id: "x" }; },
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    await w.tickOnce("test");
    assert.equal(count, 1);

    await w.tickOnce("test");
    assert.equal(count, 1, "the same occurrence must not rebuild on its own");

    w.forget("Daily Standup");
    await w.tickOnce("test");
    assert.equal(count, 2, "after discarding the card, the next check rebuilds it");

    // Unlike unsubscribing, the subscription itself is untouched.
    assert.equal(w.status().seen["Daily Standup"], "2026-09-21");
  });
});

test("forgetting a meeting that was never seen changes nothing", async () => {
  await isolated(async () => {
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => transcript("2026-09-21"),
      ingest: async () => ({ id: "x" }),
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    w.forget("Never Watched");
    assert.deepEqual(w.status().seen, {});
  });
});

test("a manual pull stops the watcher duplicating it", async () => {
  await isolated(async () => {
    let count = 0;
    const w = createWatcher({
      readWatched: () => [{ title: "Daily Standup" }],
      probe: async () => transcript("2026-09-21"),
      ingest: async () => { count++; return { id: "x" }; },
      speaker: "Ankit",
      dataDir: path.join(process.cwd(), "data"),
      intervalMs: 999999,
    });

    // The user pulls by hand; the server records the occurrence.
    w.noteIngested("Daily Standup", "2026-09-21");
    await w.tickOnce("test");

    assert.equal(count, 0, "the watcher must not rebuild what was just pulled");
  });
});
