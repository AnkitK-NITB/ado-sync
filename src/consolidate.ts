import { isDuplicate } from "./propose";
import {
  Candidate,
  CardUpdate,
  Match,
  ProposedUpdate,
  WorkItem,
  WorkItemCard,
} from "./types";

const COMMENT_MARKER = "<!-- ado-sync -->";

/** Phrases that signal work finished, vs. work still outstanding. */
const DONE_HINTS = [/\bdone\b/i, /\bfinished\b/i, /\bcompleted?\b/i, /\bclosed\b/i];
const PENDING_HINTS = [
  /\bstill\b/i, /\bpending\b/i, /\bremaining\b/i, /\boutstanding\b/i,
  /\bneed to\b/i, /\byet to\b/i, /\bin progress\b/i, /\bblocked\b/i,
  /\bwill\b/i, /\bnext\b/i,
];

/**
 * How many separate parts of one meeting must independently point at the same
 * work item before repetition is treated as evidence.
 */
const CORROBORATION_THRESHOLD = 2;

function topCandidate(m: Match): Candidate | null {
  if (m.outcome.kind === "matched") return m.outcome.candidate;
  if (m.outcome.kind === "ambiguous") return m.outcome.choices[0] ?? null;
  return null;
}

/**
 * Turns per-topic matches into one card per work item.
 *
 * Two things happen here that cannot happen while each sentence is judged
 * alone. Several topics that land on the same item become a single comment
 * rather than five near-identical ones. And repetition becomes evidence: one
 * topic ranking an item first by a narrow margin is genuinely ambiguous, but
 * several topics in the same meeting independently ranking it first is not a
 * coincidence, so the question is dropped.
 */
export function consolidate(
  matches: Match[],
  existingComments: Map<number, string[]>,
  today = new Date()
): WorkItemCard[] {
  const groups = new Map<string, { candidate: Candidate; matches: Match[] }>();
  const leftovers: Match[] = [];

  for (const m of matches) {
    const top = topCandidate(m);
    if (!top || !m.update.enrolled) {
      leftovers.push(m);
      continue;
    }
    const key = `${m.update.speaker}::${top.item.id}`;
    const g = groups.get(key);
    if (g) g.matches.push(m);
    else groups.set(key, { candidate: top, matches: [m] });
  }

  const cards: WorkItemCard[] = [];

  for (const { candidate, matches: group } of groups.values()) {
    const first = group[0].update;
    const decided = group.filter((m) => m.outcome.kind === "matched").length;
    const corroborated = group.length >= CORROBORATION_THRESHOLD;

    const updates: CardUpdate[] = group.map((m) => ({
      text: m.update.text,
      topic: m.update.topic,
      progress: m.update.progress,
      tier: candidate.tier,
      reason:
        m.outcome.kind === "matched" ? m.outcome.candidate.reason : candidate.reason,
      corroborated: m.outcome.kind !== "matched",
      corrections: m.update.corrections,
    }));

    // Still unsettled: nothing decided on its own, and not enough repetition
    // to stand in for a decision.
    if (decided === 0 && !corroborated) {
      const outcome = group[0].outcome;
      cards.push({
        speaker: first.speaker,
        adoIdentity: first.adoIdentity,
        status: "ambiguous",
        workItem: candidate.item,
        updates,
        choices: outcome.kind === "ambiguous" ? outcome.choices.map((c) => c.item) : undefined,
        ambiguityReason: outcome.kind === "ambiguous" ? outcome.reason : undefined,
        controls: ["Pick one", "Skip"],
      });
      continue;
    }

    const proposed = buildGroupProposal(updates, candidate.item, today);
    const existing = existingComments.get(candidate.item.id) ?? [];

    if (isDuplicate(proposed.commentMarkdown, existing)) {
      cards.push({
        speaker: first.speaker,
        adoIdentity: first.adoIdentity,
        status: "duplicate-skipped",
        workItem: candidate.item,
        updates,
        skipReason: "Same as an update already on this item — nothing new to add.",
        controls: ["Comment anyway", "Skip"],
      });
      continue;
    }

    cards.push({
      speaker: first.speaker,
      adoIdentity: first.adoIdentity,
      status: "proposed",
      workItem: candidate.item,
      updates,
      proposed,
      corroboration:
        decided === 0 && corroborated
          ? `${group.length} separate parts of your update point at this item, which settles what no single one did.`
          : undefined,
      controls: ["Approve", "Edit", "Choose another item", "Skip"],
    });
  }

  return cards;
}

/**
 * One comment covering everything the person said about this item.
 *
 * The state rule stays deliberately conservative across the group: finishing
 * one topic is not finishing the item, so anything still outstanding anywhere
 * in the group leaves the state alone.
 */
export function buildGroupProposal(
  updates: CardUpdate[],
  item: WorkItem,
  today = new Date()
): ProposedUpdate {
  const all = updates.map((u) => u.text).join(" ");
  const saysDone = DONE_HINTS.some((r) => r.test(all));
  const saysPending =
    PENDING_HINTS.some((r) => r.test(all)) ||
    updates.some((u) => u.progress && /IN PROGRESS|NEXT|BLOCKED/i.test(u.progress));

  const proposeDone = saysDone && !saysPending && item.state !== "Done";
  const stateChange = proposeDone ? { from: item.state, to: "Done" } : null;

  const lines = updates.map((u) => {
    const label = u.topic ? `**${u.topic}** — ` : "";
    const tag = u.progress ? ` _(${u.progress.toLowerCase()})_` : "";
    return `- ${label}${u.text.trim()}${tag}`;
  });

  return {
    commentMarkdown: [
      COMMENT_MARKER,
      `**Standup update — ${today.toISOString().slice(0, 10)}**`,
      "",
      ...lines,
      "",
      `_Proposed by ADO Sync from a Teams standup transcript and approved by the work item owner. State ${
        stateChange ? `change proposed: ${stateChange.from} → ${stateChange.to}` : "left unchanged"
      }._`,
    ].join("\n"),
    stateChange,
    nextAction: deriveGroupNextAction(updates),
    stateRationale: proposeDone
      ? "Every part of this update reports completion with nothing outstanding."
      : saysDone && saysPending
      ? "Part of the work is finished but something remains outstanding, so the state is left unchanged."
      : "No completion was reported, so the state is left unchanged.",
  };
}

function deriveGroupNextAction(updates: CardUpdate[]): string {
  const next = updates.find((u) => u.progress && /NEXT|BLOCKED|IN PROGRESS/i.test(u.progress));
  if (next?.topic) return `${next.topic}.`;
  const m = updates
    .map((u) => u.text.match(/(?:still |i )?need to ([^.;]+)/i) ?? u.text.match(/(?:will|i'll) ([^.;]+)/i))
    .find(Boolean);
  if (m) return m[1].trim().charAt(0).toUpperCase() + m[1].trim().slice(1) + ".";
  return "Confirm whether anything remains before changing state.";
}

/** Matches that never reached a work item still need surfacing. */
export function unresolvedCards(matches: Match[]): WorkItemCard[] {
  return matches
    .filter((m) => m.outcome.kind === "unresolved")
    .map((m) => ({
      speaker: m.update.speaker,
      adoIdentity: m.update.adoIdentity,
      status: "unresolved" as const,
      workItem: undefined as unknown as WorkItem,
      updates: [
        {
          text: m.update.text,
          topic: m.update.topic,
          progress: m.update.progress,
          tier: "assigned" as const,
          reason: "",
          corroborated: false,
        },
      ],
      skipReason: m.outcome.kind === "unresolved" ? m.outcome.reason : undefined,
      controls: m.update.enrolled ? ["Choose an item", "Skip"] : ["Skip"],
    }));
}
