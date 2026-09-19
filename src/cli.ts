import * as fs from "fs";
import * as path from "path";
import { normalize } from "./normalize";
import { matchAll } from "./match";
import { buildCard } from "./propose";
import { consolidate, unresolvedCards } from "./consolidate";
import { renderReceiptMarkdown } from "./receipt";
import { resolveInteractive } from "./resolve";
import {
  Card,
  EnrollmentFile,
  Receipt,
  Transcript,
  VocabularyFile,
  WorkItemCard,
  WorkItemSet,
  WriteAction,
} from "./types";
import { NO_VOCABULARY } from "./vocabulary";
import { buildWriteActions } from "./write";

const DATA = path.join(__dirname, "..", "data");

function load<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8")) as T;
}

function loadVocabulary(): VocabularyFile {
  const file = path.join(DATA, "vocabulary.json");
  if (!fs.existsSync(file)) return NO_VOCABULARY;
  return JSON.parse(fs.readFileSync(file, "utf8")) as VocabularyFile;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const json = args.has("--json");
  const interactive = args.has("--interactive");

  const transcript = load<Transcript>("transcript.json");
  const workItems = load<WorkItemSet>("workitems.json");
  const enrollmentPath = path.join(DATA, "enrollment.json");
  const enrollment = load<EnrollmentFile>("enrollment.json");

  // Existing comments would be fetched per item via
  // azure-devops wit_work_item(action='list_comments'). Empty here means
  // nothing has been posted yet for these items.
  const existingComments = new Map<number, string[]>();
  const commentsFile = path.join(DATA, "comments.json");
  if (fs.existsSync(commentsFile)) {
    const raw = JSON.parse(fs.readFileSync(commentsFile, "utf8")) as Record<
      string,
      string[]
    >;
    for (const [id, list] of Object.entries(raw)) {
      existingComments.set(Number(id), list);
    }
  }

  let cards = buildCards(transcript, workItems, enrollment, existingComments);

  if (interactive) {
    const confirmations = await resolveInteractive(
      cards,
      workItems.items,
      enrollment,
      enrollmentPath
    );
    if (confirmations.length > 0) {
      cards = buildCards(transcript, workItems, enrollment, existingComments);
    }
  }

  const receipt = buildReceipt(cards, transcript, enrollment, apply);
  writeReceiptMarkdown(receipt);

  if (json) {
    console.log(JSON.stringify({ cards, receipt }, null, 2));
    return;
  }

  renderCards(cards);
  const consolidated = renderConsolidated(transcript, workItems, enrollment, existingComments);
  renderReceipt(receipt);
  renderWriteActions(consolidated, workItems, enrollment, apply);
}

/**
 * The per-work-item view. One person routinely touches the same item several
 * times in a standup, and that is one comment on one item, not five.
 */
function renderConsolidated(
  transcript: Transcript,
  workItems: WorkItemSet,
  enrollment: EnrollmentFile,
  existingComments: Map<number, string[]>
): WorkItemCard[] {
  const updates = normalize(transcript, enrollment.enrolled, loadVocabulary());
  const matches = matchAll(updates, workItems.items, enrollment.enrolled);
  const cards = [
    ...consolidate(matches, existingComments, new Date(transcript.meeting.occurredAt)),
    ...unresolvedCards(matches).filter((c) => c.speaker === enrollment.enrolled[0]?.teamsDisplayName),
  ];

  console.log("\n" + "=".repeat(78));
  console.log("CONSOLIDATED — ONE CARD PER WORK ITEM");
  console.log("=".repeat(78));

  for (const c of cards) {
    const badge =
      c.status === "proposed"
        ? "PROPOSED"
        : c.status === "duplicate-skipped"
        ? "SKIPPED (duplicate)"
        : c.status === "ambiguous"
        ? "NEEDS YOUR CHOICE"
        : "UNRESOLVED";

    const head = c.workItem
      ? `${c.workItem.type} ${c.workItem.id} — ${c.workItem.title}`
      : "no work item";
    console.log(`\n┌─ ${c.speaker}  ·  ${badge}`);
    console.log(`│  ${head}`);
    if (c.workItem) console.log(`│  state ${c.workItem.state} · rev ${c.workItem.rev}`);
    console.log(`│  ${c.updates.length} update${c.updates.length === 1 ? "" : "s"} on this item:`);
    for (const u of c.updates) {
      const tag = u.progress ? `[${u.progress}] ` : "";
      const label = u.topic ? `${u.topic}: ` : "";
      console.log(`│    • ${tag}${label}${wrap(u.text, 58, "│      ")}`);
      for (const fix of u.corrections ?? []) {
        console.log(`│      heard "${fix.heard}" — matched as ${fix.canonical}. Accept into the text?`);
      }
    }
    if (c.corroboration) console.log(`│  Settled by:  ${wrap(c.corroboration, 58, "│               ")}`);
    if (c.proposed) {
      console.log(
        `│  State:       ${
          c.proposed.stateChange
            ? `${c.proposed.stateChange.from} → ${c.proposed.stateChange.to}`
            : "unchanged"
        }`
      );
      console.log(`│  Next action: ${wrap(c.proposed.nextAction, 58, "│               ")}`);
    }
    if (c.ambiguityReason) console.log(`│  Why asking:  ${wrap(c.ambiguityReason, 58, "│               ")}`);
    if (c.choices) {
      for (const w of c.choices) console.log(`│    ? ${w.type} ${w.id} — ${w.title}`);
    }
    if (c.skipReason) console.log(`│  Note:        ${wrap(c.skipReason, 58, "│               ")}`);
    console.log(`└─ ${c.controls.join("  ·  ")}`);
  }

  return cards;
}

function buildCards(
  transcript: Transcript,
  workItems: WorkItemSet,
  enrollment: EnrollmentFile,
  existingComments: Map<number, string[]>
): Card[] {
  const updates = normalize(transcript, enrollment.enrolled);
  const matches = matchAll(updates, workItems.items, enrollment.enrolled);
  return matches.map((m) => buildCard(m, existingComments));
}

function renderCards(cards: Card[]) {
  console.log("\n" + "=".repeat(78));
  console.log("ADO SYNC — PERSONAL CARDS (private to each person)");
  console.log("=".repeat(78));

  for (const c of cards) {
    const badge =
      c.status === "proposed"
        ? "PROPOSED"
        : c.status === "duplicate-skipped"
        ? "SKIPPED (duplicate)"
        : c.status === "ambiguous"
        ? "NEEDS YOUR CHOICE"
        : "UNRESOLVED";

    console.log(`\n┌─ ${c.speaker}  ·  ${badge}`);
    console.log(`│  Your update: ${wrap(c.yourUpdate, 70, "│               ")}`);

    if (c.matchedWorkItem) {
      const w = c.matchedWorkItem;
      console.log(`│  Matched:     ${w.type} ${w.id} — ${w.title}`);
      console.log(`│               state ${w.state} · rev ${w.rev}`);
      console.log(`│  Why:         [${c.matchTier}] ${wrap(c.matchReason ?? "", 60, "│               ")}`);
    }
    if (c.choices) {
      if (c.ambiguityReason) {
        console.log(`│  Why asking:  ${wrap(c.ambiguityReason, 60, "│               ")}`);
      }
      console.log("│  Could be:");
      for (const w of c.choices) {
        console.log(`│               • ${w.type} ${w.id} — ${w.title} (${w.state})`);
      }
    }
    if (c.proposed) {
      console.log(`│  Proposed:    add a progress comment`);
      console.log(
        `│               state: ${
          c.proposed.stateChange
            ? `${c.proposed.stateChange.from} → ${c.proposed.stateChange.to}`
            : "unchanged"
        }`
      );
      console.log(`│               ${wrap(c.proposed.stateRationale, 60, "│               ")}`);
      console.log(`│  Next action: ${wrap(c.proposed.nextAction, 60, "│               ")}`);
    }
    if (c.skipReason) {
      console.log(`│  Note:        ${wrap(c.skipReason, 60, "│               ")}`);
    }
    console.log(`└─ ${c.controls.join("  ·  ")}`);
  }
}

function buildReceipt(
  cards: Card[],
  transcript: Transcript,
  enrollment: EnrollmentFile,
  apply: boolean
): Receipt {
  const mode = enrollment.enrolled[0]?.mode ?? "review-only";
  return {
    meeting: `${transcript.meeting.title} — ${transcript.meeting.occurredAt.slice(0, 10)}`,
    generatedAt: new Date().toISOString(),
    mode,
    dryRun: !apply,
    updated: cards
      .filter((c) => c.status === "proposed" && c.matchedWorkItem)
      .map((c) => ({
        workItemId: c.matchedWorkItem!.id,
        title: c.matchedWorkItem!.title,
        summary: c.proposed!.stateChange
          ? `comment + state ${c.proposed!.stateChange.from} → ${c.proposed!.stateChange.to}`
          : "comment added, state unchanged",
      })),
    skipped: cards
      .filter((c) => c.status === "duplicate-skipped")
      .map((c) => ({
        workItemId: c.matchedWorkItem?.id,
        title: c.matchedWorkItem?.title,
        reason: c.skipReason ?? "skipped",
      })),
    unresolved: cards
      .filter((c) => c.status === "unresolved" || c.status === "ambiguous")
      .map((c) => ({
        speaker: c.speaker,
        text: c.yourUpdate,
        reason:
          c.status === "ambiguous"
            ? c.ambiguityReason ??
              "More than one item could match — waiting for your choice."
            : c.skipReason ?? "unresolved",
      })),
  };
}

function renderReceipt(r: Receipt) {
  console.log("\n" + "=".repeat(78));
  console.log(`RECEIPT — ${r.meeting}   [${r.dryRun ? "DRY RUN" : "APPLIED"}, mode: ${r.mode}]`);
  console.log("=".repeat(78));
  console.log(`\n  Updated (${r.updated.length})`);
  for (const u of r.updated) console.log(`    ✓ ${u.workItemId} — ${u.title}\n        ${u.summary}`);
  console.log(`\n  Skipped (${r.skipped.length})`);
  for (const s of r.skipped) console.log(`    — ${s.workItemId ?? ""} ${s.title ?? ""}\n        ${s.reason}`);
  console.log(`\n  Unresolved (${r.unresolved.length})`);
  for (const u of r.unresolved) console.log(`    ? ${u.speaker}\n        ${u.reason}`);
  console.log(
    "\n  Restricted work-item detail is never posted to the shared meeting chat."
  );
}

function writeReceiptMarkdown(receipt: Receipt) {
  fs.writeFileSync(path.join(__dirname, "receipt.md"), renderReceiptMarkdown(receipt), "utf8");
}

/**
 * Emits the write actions rather than performing them. Each is a single patch
 * document asserting the revision that was read, so a newer human edit rejects
 * the comment itself rather than being silently overwritten.
 */
function renderWriteActions(
  cards: WorkItemCard[],
  workItems: WorkItemSet,
  enrollment: EnrollmentFile,
  apply: boolean
) {
  const sandbox = enrollment.writeTarget.sandboxWorkItemId;
  const actions: WriteAction[] = buildWriteActions(cards, workItems.org, workItems.project);

  console.log("\n" + "=".repeat(78));
  console.log("WRITE ACTIONS");
  console.log("=".repeat(78));
  if (actions.length === 0) {
    console.log("\n  Nothing to write.");
    return;
  }
  for (const a of actions) {
    const allowed = a.workItemId === sandbox;
    console.log(
      `\n  work item ${a.workItemId}  ·  ${
        allowed ? "ALLOWED (sandbox)" : "BLOCKED (not the approved write target)"
      }`
    );
    console.log(`  ${a.method} ${a.url}`);
    console.log(`  Content-Type: ${a.contentType}`);
    console.log("  " + JSON.stringify(a.patch.map((o) => ({ op: o.op, path: o.path })), null, 0));
    console.log("  ---");
    console.log(a.commentMarkdown.split("\n").map((l) => "  " + l).join("\n"));
  }
  console.log(
    `\n  ${apply ? "APPLY requested" : "DRY RUN"} — writes are performed by the ADO connector, ` +
      "never by this engine. The test on /rev and the write are one document, so a stale " +
      "revision rejects the comment with VS403351."
  );

  fs.writeFileSync(
    path.join(DATA, "write-actions.json"),
    JSON.stringify(actions, null, 2)
  );
  console.log("  Wrote data/write-actions.json");
}

function wrap(s: string, width: number, indent: string): string {
  const words = s.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n" + indent);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
