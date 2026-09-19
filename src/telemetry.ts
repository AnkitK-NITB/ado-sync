import { onlyAcceptedCorrections } from "./edit";
import { EditProvenance, MatchTier, WorkItemCard } from "./types";

/**
 * Records what happened to each suggestion, so the decision to relax the
 * Approve button can be made on evidence rather than optimism.
 *
 * The number that matters is not "how often did people approve" -- people
 * approve to clear a queue. It is **how often they approved without editing**,
 * split by tier. An explicit id spoken aloud and a text match on an assigned
 * item are not the same claim, and blending them would either over-automate the
 * weak tier or hold back the strong one.
 */

export type DecisionOutcome =
  | "approved-unchanged"
  | "approved-after-edit"
  | "reassigned"
  | "skipped";

export interface CardDecision {
  decidedAt: string;
  meeting: string;
  speaker: string;
  workItemId?: number;
  tier?: MatchTier;
  /** How many spoken updates this one card carried. */
  updateCount: number;
  /** True when repetition across the meeting is what settled the match. */
  usedCorroboration: boolean;
  /** Vocabulary repairs offered on this card, and whether they were taken. */
  correctionsOffered: number;
  correctionsAccepted: number;
  /** How many update lines were rewritten, and how many dropped. */
  updatesEdited: number;
  updatesRemoved: number;
  /** True when the body was rewritten by hand, discarding the structure. */
  rawEdited: boolean;
  /**
   * True when the only change was taking a vocabulary repair. This is not the
   * engine being wrong -- it proposed the repair and the person agreed -- so
   * counting it as an edit would understate how good the output was.
   */
  correctionOnly: boolean;
  outcome: DecisionOutcome;
}

export function recordDecision(
  card: WorkItemCard,
  meeting: string,
  outcome: DecisionOutcome,
  opts: { provenance?: EditProvenance; now?: Date } = {}
): CardDecision {
  const correctionsOffered = card.updates.reduce(
    (n, u) => n + (u.corrections?.length ?? 0),
    0
  );
  const p = opts.provenance;
  return {
    decidedAt: (opts.now ?? new Date()).toISOString(),
    meeting,
    speaker: card.speaker,
    workItemId: card.workItem?.id,
    tier: card.updates[0]?.tier,
    updateCount: card.updates.length,
    usedCorroboration: Boolean(card.corroboration),
    correctionsOffered,
    correctionsAccepted: Math.min(p?.correctionsAccepted ?? 0, correctionsOffered || (p?.correctionsAccepted ?? 0)),
    updatesEdited: p?.editedUpdates.length ?? 0,
    updatesRemoved: p?.removedUpdates.length ?? 0,
    rawEdited: p?.rawEdited ?? false,
    correctionOnly: p ? onlyAcceptedCorrections(p) && p.editedUpdates.length > 0 : false,
    outcome,
  };
}

export interface TierAcceptance {
  tier: MatchTier;
  total: number;
  approvedUnchanged: number;
  approvedAfterEdit: number;
  reassigned: number;
  skipped: number;
  /** Share approved with no edit at all. The figure the auto decision rests on. */
  cleanAcceptanceRate: number;
  /**
   * Share approved where the only change was accepting a vocabulary repair the
   * engine itself proposed. Kept separate because it is agreement, not
   * correction, and folding it into the edit rate would understate the output.
   */
  correctionOnlyRate: number;
  /** How often people abandoned the structure and rewrote the body by hand. */
  rawEditRate: number;
}

/**
 * Per-tier acceptance. Deliberately not a single blended number: a headline
 * rate would hide exactly the difference that decides where automation is safe.
 */
export function summarise(decisions: CardDecision[]): TierAcceptance[] {
  const byTier = new Map<MatchTier, CardDecision[]>();
  for (const d of decisions) {
    if (!d.tier) continue;
    byTier.set(d.tier, [...(byTier.get(d.tier) ?? []), d]);
  }

  return [...byTier.entries()]
    .map(([tier, rows]) => {
      const count = (o: DecisionOutcome) => rows.filter((r) => r.outcome === o).length;
      const approvedUnchanged = count("approved-unchanged");
      const correctionOnly = rows.filter((r) => r.correctionOnly).length;
      const rawEdited = rows.filter((r) => r.rawEdited).length;
      return {
        tier,
        total: rows.length,
        approvedUnchanged,
        approvedAfterEdit: count("approved-after-edit"),
        reassigned: count("reassigned"),
        skipped: count("skipped"),
        cleanAcceptanceRate: rows.length === 0 ? 0 : approvedUnchanged / rows.length,
        correctionOnlyRate: rows.length === 0 ? 0 : correctionOnly / rows.length,
        rawEditRate: rows.length === 0 ? 0 : rawEdited / rows.length,
      };
    })
    .sort((a, b) => b.cleanAcceptanceRate - a.cleanAcceptanceRate);
}

/**
 * Whether a tier has earned automation yet.
 *
 * Both conditions matter. A high rate over four cards is noise, and a large
 * sample with a mediocre rate means people are routinely fixing the output.
 */
export function qualifiesForAutomation(
  t: TierAcceptance,
  minSample: number,
  minRate: number
): boolean {
  return t.total >= minSample && t.cleanAcceptanceRate >= minRate;
}
