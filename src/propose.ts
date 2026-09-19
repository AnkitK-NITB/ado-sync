import { Card, Match, ProposedUpdate, WorkItem } from "./types";

const COMMENT_MARKER = "<!-- ado-sync -->";

/** Phrases that signal work finished, vs. work still outstanding. */
const DONE_HINTS = [/\bdone\b/i, /\bfinished\b/i, /\bcompleted?\b/i, /\bclosed\b/i];
const PENDING_HINTS = [
  /\bstill\b/i, /\bpending\b/i, /\bremaining\b/i, /\boutstanding\b/i,
  /\bneed to\b/i, /\byet to\b/i, /\bin progress\b/i, /\bblocked\b/i,
];

export function buildProposal(update: string, item: WorkItem): ProposedUpdate {
  const saysDone = DONE_HINTS.some((r) => r.test(update));
  const saysPending = PENDING_HINTS.some((r) => r.test(update));

  // Finishing one activity is not the same as finishing the work item.
  // A state change is only ever proposed when nothing is left outstanding.
  const proposeDone = saysDone && !saysPending && item.state !== "Done";

  const stateChange = proposeDone ? { from: item.state, to: "Done" } : null;
  const stateRationale = proposeDone
    ? "The update reports completion with nothing outstanding."
    : saysDone && saysPending
    ? "Part of the work is finished but something remains outstanding, so the state is left unchanged."
    : "No completion was reported, so the state is left unchanged.";

  return {
    commentMarkdown: [
      COMMENT_MARKER,
      `**Standup update — ${new Date().toISOString().slice(0, 10)}**`,
      "",
      update.trim(),
      "",
      `_Proposed by ADO Sync from a Teams standup transcript and approved by the work item owner. State ${
        stateChange ? `change proposed: ${stateChange.from} → ${stateChange.to}` : "left unchanged"
      }._`,
    ].join("\n"),
    stateChange,
    nextAction: deriveNextAction(update),
    stateRationale,
  };
}

function deriveNextAction(update: string): string {
  const m =
    update.match(/(?:still |i )?need to ([^.;]+)/i) ??
    update.match(/(?:yet to) ([^.;]+)/i) ??
    update.match(/(?:will|i'll) ([^.;]+)/i);
  if (m) return capitalize(m[1].trim()) + ".";
  const pending = update.match(/([^.;]*\b(?:pending|outstanding|remaining)\b[^.;]*)/i);
  if (pending) return capitalize(pending[1].trim()) + ".";
  return "Confirm whether anything remains before changing state.";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Suppresses an update that adds nothing over what is already on the item.
 * This is what stops "same as yesterday" turning into comment spam.
 */
export function isDuplicate(
  proposedBody: string,
  existingComments: string[]
): boolean {
  // Strip any HTML comment rather than one specific marker, so renaming the
  // product never silently breaks dedupe against comments already posted.
  const norm = (s: string) =>
    s
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/&lt;!--[\s\S]*?--&gt;/g, "")
      .replace(/\*\*Standup update[^\n]*\*\*/i, "")
      .replace(/_Proposed by [\s\S]*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const target = norm(proposedBody);
  if (!target) return true;
  return existingComments.some((c) => {
    const other = norm(c);
    if (!other) return false;
    return other === target || jaccard(target, other) > 0.85;
  });
}

function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function buildCard(
  match: Match,
  existingComments: Map<number, string[]>
): Card {
  const { update, outcome } = match;
  const controls = ["Approve", "Edit", "Choose another item", "Skip"];

  if (outcome.kind === "unresolved") {
    return {
      speaker: update.speaker,
      adoIdentity: update.adoIdentity,
      status: "unresolved",
      yourUpdate: update.text,
      skipReason: outcome.reason,
      controls: update.enrolled ? ["Choose an item", "Skip"] : ["Skip"],
    };
  }

  if (outcome.kind === "ambiguous") {
    return {
      speaker: update.speaker,
      adoIdentity: update.adoIdentity,
      status: "ambiguous",
      yourUpdate: update.text,
      choices: outcome.choices.map((c) => c.item),
      ambiguityReason: outcome.reason,
      controls: ["Pick one", "Skip"],
    };
  }

  const item = outcome.candidate.item;
  const proposed = buildProposal(update.text, item);
  const existing = existingComments.get(item.id) ?? [];

  if (isDuplicate(proposed.commentMarkdown, existing)) {
    return {
      speaker: update.speaker,
      adoIdentity: update.adoIdentity,
      status: "duplicate-skipped",
      yourUpdate: update.text,
      matchedWorkItem: item,
      matchTier: outcome.candidate.tier,
      matchReason: outcome.candidate.reason,
      skipReason: "Same as an update already on this item — nothing new to add.",
      controls: ["Comment anyway", "Skip"],
    };
  }

  return {
    speaker: update.speaker,
    adoIdentity: update.adoIdentity,
    status: "proposed",
    yourUpdate: update.text,
    matchedWorkItem: item,
    matchTier: outcome.candidate.tier,
    matchReason: outcome.candidate.reason,
    proposed,
    controls,
  };
}
