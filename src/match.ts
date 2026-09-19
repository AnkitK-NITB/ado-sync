import { overlapScore, signalTerms } from "./normalize";
import {
  Candidate,
  Enrollment,
  Match,
  MatchOutcome,
  SpeakerUpdate,
  WorkItem,
} from "./types";

/**
 * Tier weights implement the stated matching order. A lower tier can never
 * outrank a higher one, no matter how strong its text overlap — that is the
 * whole point of publishing the order.
 */
const TIER_BASE: Record<Candidate["tier"], number> = {
  "explicit-id": 1000,
  pinned: 800,
  "confirmed-before": 600,
  assigned: 400,
  "recently-touched": 200,
  // Reachable only by following a link from something you own. Bands stay 200
  // apart so a full text bonus (100) can never lift a linked item into the
  // recently-touched band.
  linked: 0,
};

/** Below this, a text-similarity match is not worth proposing. */
const MIN_TEXT_SCORE = 0.55;

/**
 * Text similarity only ever moves a candidate *within* its tier band. Bands are
 * 200 apart, so the bonus is capped well below that -- otherwise a strong text
 * match on a low tier could outrank a high tier, which would quietly break the
 * published ordering.
 */
const MAX_TEXT_BONUS = 100;

function textBonus(terms: string[], title: string): number {
  return MAX_TEXT_BONUS * Math.min(1, overlapScore(terms, title));
}

/**
 * How much a title term narrows things down, measured against the candidate
 * set. Work item titles in one area carry heavy boilerplate -- "[NODE WKLD]"
 * prefixes 16 of 50 titles in the real contoso/Engineering set, and "wkld" appears in 24
 * -- so raw word overlap mostly measures how long a title is. Weighting by
 * inverse document frequency makes a rare word like "parity" count for more
 * than a ubiquitous one like "wkld".
 */
const idfCache = new WeakMap<WorkItem[], Map<string, number>>();

function idfFor(items: WorkItem[]): Map<string, number> {
  const cached = idfCache.get(items);
  if (cached) return cached;

  const df = new Map<string, number>();
  for (const item of items) {
    for (const t of new Set(signalTerms(item.title))) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const n = items.length;
  const idf = new Map<string, number>();
  for (const [t, count] of df) idf.set(t, Math.log((n + 1) / (count + 1)));

  idfCache.set(items, idf);
  return idf;
}

/** Total weight of the informative words an update and a title share. */
function matchedMass(
  spoken: Set<string>,
  title: string,
  idf: Map<string, number>
): number {
  let mass = 0;
  for (const t of new Set(signalTerms(title))) {
    if (spoken.has(t)) mass += idf.get(t) ?? 0;
  }
  return mass;
}

/** Two candidates this close together are ambiguous, not a winner. */
const AMBIGUITY_MARGIN = 40;

const RECENT_DAYS = 14;

/** Choices shown when the person has to pick a level in the hierarchy. */
const MAX_HIERARCHY_CHOICES = 4;

function scoreIn(tier: Candidate["tier"], terms: string[], title: string): number {
  return TIER_BASE[tier] + textBonus(terms, title);
}

/**
 * Words in a child's title that belong to that child alone -- not to its parent
 * and not to any sibling. These are the only words capable of distinguishing
 * one level of the hierarchy from another, because everything else is shared
 * vocabulary that every item in the family would match on equally.
 */
function distinctiveTerms(
  child: WorkItem,
  parent: WorkItem,
  siblings: WorkItem[]
): string[] {
  const own = new Set(signalTerms(child.title));
  for (const t of signalTerms(parent.title)) own.delete(t);
  for (const s of siblings) {
    if (s.id === child.id) continue;
    for (const t of signalTerms(s.title)) own.delete(t);
  }
  return [...own];
}

/**
 * The mirror image: words belonging to the parent and to none of its children.
 * A parent is usually a real piece of work in its own right, not just a folder
 * -- "Perf parity between HBADevTest, CPU & NODE WKLD" is a different subject
 * from its "SSD WKLD Parity" and "CMR HDD WKLD Parity" children. Naming the
 * parent's own subject is as clear a signal as naming a child's.
 */
function parentDistinctiveTerms(parent: WorkItem, children: WorkItem[]): string[] {
  const own = new Set(signalTerms(parent.title));
  for (const c of children) {
    for (const t of signalTerms(c.title)) own.delete(t);
  }
  return [...own];
}

/**
 * Decides which level of the hierarchy an update belongs on.
 *
 * Commenting on a parent when the work sits in one of its children puts the
 * update on the wrong item, and the two are never separable by overall title
 * similarity -- a parent and its children share most of their vocabulary, and
 * raw overlap mostly measures title length.
 *
 * So the test is not "which scored higher" but "which one did you actually
 * name": a child is taken only when the update contains a word specific to
 * that child and to no other. Name none, or name more than one, and the choice
 * goes back to the person.
 *
 * Returns null when there is no hierarchy to resolve, leaving the caller's
 * original outcome untouched.
 */
export function resolveHierarchy(
  candidate: Candidate,
  items: WorkItem[],
  update: SpeakerUpdate
): MatchOutcome | null {
  // An id spoken aloud, or an item the person pinned, is a direct statement of
  // intent. Second-guessing it with its own children would override the person.
  if (candidate.tier === "explicit-id" || candidate.tier === "pinned") return null;

  const parent = candidate.item;
  const children = (parent.childIds ?? [])
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is WorkItem => Boolean(i));
  if (children.length === 0) return null;

  const spoken = new Set(update.signalTerms);
  const named = children.filter((c) =>
    distinctiveTerms(c, parent, children).some((t) => spoken.has(t))
  );

  if (named.length === 1) {
    const child = named[0];
    const hits = distinctiveTerms(child, parent, children).filter((t) => spoken.has(t));
    return {
      kind: "matched",
      candidate: {
        item: child,
        tier: candidate.tier,
        score: scoreIn(candidate.tier, update.signalTerms, child.title),
        reason:
          `A child of ${parent.id}. You said ${hits.map((h) => `"${h}"`).join(", ")}, ` +
          "which points at this child and no other.",
      },
      runnersUp: [],
    };
  }

  // No child was named. If the update speaks to the parent's own subject, the
  // parent is the answer and there is nothing to ask about.
  if (named.length === 0) {
    const parentHits = parentDistinctiveTerms(parent, children).filter((t) => spoken.has(t));
    if (parentHits.length > 0) return null;
  }

  const choices: Candidate[] = [
    {
      item: parent,
      tier: candidate.tier,
      score: scoreIn(candidate.tier, update.signalTerms, parent.title),
      reason: candidate.reason,
    },
    // Ranked, because a parent can have more children than are worth showing
    // and an arbitrary slice would bury the one the person means. Children the
    // update actually named come first; the rest fall back to title overlap.
    ...children
      .map((item) => ({
        item,
        tier: candidate.tier,
        score: scoreIn(candidate.tier, update.signalTerms, item.title),
        reason: named.includes(item)
          ? `A child of ${parent.id}, and you named it.`
          : `A child of ${parent.id}.`,
      }))
      .sort((a, b) => {
        const byNamed = Number(named.includes(b.item)) - Number(named.includes(a.item));
        return byNamed !== 0 ? byNamed : b.score - a.score;
      }),
  ].slice(0, MAX_HIERARCHY_CHOICES);

  const reason =
    named.length === 0
      ? `${parent.id} has ${children.length} child item${
          children.length === 1 ? "" : "s"
        }, and nothing you said picks one. Choose where this update belongs.`
      : `You mentioned ${named.length} of the child items under ${parent.id}. ` +
        "Choose where this update belongs.";

  return { kind: "ambiguous", choices, reason };
}

export function matchAll(
  updates: SpeakerUpdate[],
  items: WorkItem[],
  enrolled: Enrollment[]
): Match[] {
  const byName = new Map(
    enrolled.map((e) => [e.teamsDisplayName.toLowerCase(), e])
  );
  return updates.map((update) => ({
    update,
    outcome: matchOne(update, items, byName.get(update.speaker.toLowerCase())),
  }));
}

export function matchOne(
  update: SpeakerUpdate,
  items: WorkItem[],
  enrollment?: Enrollment
): MatchOutcome {
  if (!update.enrolled || !enrollment) {
    return {
      kind: "unresolved",
      reason:
        "Speaker is not enrolled, so no identity link exists. Display names are never used to guess an Azure DevOps identity.",
    };
  }

  const candidates: Candidate[] = [];

  // Tier 1 - an id spoken aloud. Still checked for existence and ownership.
  for (const id of update.explicitIds) {
    const item = items.find((i) => i.id === id);
    if (!item) continue;
    candidates.push({
      item,
      tier: "explicit-id",
      score: TIER_BASE["explicit-id"],
      reason: `Work item ${id} was named directly in the meeting.`,
    });
  }

  // Tier 2 - the user pinned it themselves.
  for (const id of enrollment.pinnedWorkItemIds) {
    const item = items.find((i) => i.id === id);
    if (!item) continue;
    candidates.push({
      item,
      tier: "pinned",
      score: TIER_BASE.pinned + 0.1 * textBonus(update.signalTerms, item.title),
      reason: "You pinned this item as what you are currently discussing.",
    });
  }

  // Tier 3 - a mapping this person confirmed before.
  for (const cm of enrollment.confirmedMatches) {
    if (!update.text.toLowerCase().includes(cm.phrase.toLowerCase())) continue;
    const item = items.find((i) => i.id === cm.workItemId);
    if (!item) continue;
    candidates.push({
      item,
      tier: "confirmed-before",
      score: TIER_BASE["confirmed-before"],
      reason: `You previously confirmed that "${cm.phrase}" means this item.`,
    });
  }

  const mine = items.filter((i) => i.assignedTo === enrollment.adoIdentity);

  // Text-ranked candidates are scored in two passes. Candidacy stays absolute,
  // so a weak match never qualifies just by being the best of a bad field. Only
  // the ranking is relative, which is what preserves the winning margin that a
  // fixed cap used to flatten away.
  const idf = idfFor(items);
  const spoken = new Set(update.signalTerms);
  const textRanked: { item: WorkItem; tier: Candidate["tier"]; mass: number; reason: string }[] = [];

  // Tier 4 - assigned to this person, matched on what they said.
  for (const item of mine) {
    const text = overlapScore(update.signalTerms, item.title);
    if (text < MIN_TEXT_SCORE) continue;
    textRanked.push({
      item,
      tier: "assigned",
      mass: matchedMass(spoken, item.title, idf),
      reason: `Assigned to you, and your update overlaps its title (score ${text.toFixed(2)}).`,
    });
  }

  // Tier 5 - recently touched. Candidates only; touching is not owning.
  const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
  for (const item of items) {
    if (item.assignedTo === enrollment.adoIdentity) continue;
    if (new Date(item.changedDate).getTime() < cutoff) continue;
    const text = overlapScore(update.signalTerms, item.title);
    if (text < MIN_TEXT_SCORE) continue;
    textRanked.push({
      item,
      tier: "recently-touched",
      mass: matchedMass(spoken, item.title, idf),
      reason:
        "Recently touched and textually similar, but not assigned to you -- candidate only.",
    });
  }

  // Tier 6 - one hop along a link from something you own. A bug filed against
  // your PBI is often what you actually described, but its title need not
  // resemble the PBI's, so text matching alone never reaches it. Traversal is
  // one hop only: past that, "related to something related to mine" stops
  // meaning anything.
  const ownIds = new Set(mine.map((i) => i.id));
  const alreadyCandidate = new Set(textRanked.map((c) => c.item.id));
  const linkedIds = new Set<number>();
  for (const owned of mine) {
    for (const rid of owned.relatedIds ?? []) {
      if (!ownIds.has(rid) && !alreadyCandidate.has(rid)) linkedIds.add(rid);
    }
  }
  for (const id of linkedIds) {
    const item = items.find((i) => i.id === id);
    if (!item) continue;
    const text = overlapScore(update.signalTerms, item.title);
    if (text < MIN_TEXT_SCORE) continue;
    textRanked.push({
      item,
      tier: "linked",
      mass: matchedMass(spoken, item.title, idf),
      reason:
        "Linked to an item assigned to you, and textually similar -- candidate only.",
    });
  }

  // Normalising against the strongest candidate keeps the bonus inside the tier
  // band while letting the gap between first and second place survive. When no
  // candidate carries any distinguishing weight the bonus is zero for all of
  // them, and they correctly read as a tie.
  const maxMass = textRanked.reduce((m, c) => Math.max(m, c.mass), 0);
  for (const c of textRanked) {
    const bonus = maxMass > 0 ? MAX_TEXT_BONUS * (c.mass / maxMass) : 0;
    candidates.push({
      item: c.item,
      tier: c.tier,
      score: TIER_BASE[c.tier] + bonus,
      reason: c.reason,
    });
  }

  if (candidates.length === 0) {
    return {
      kind: "unresolved",
      reason:
        "Nothing in your assigned or recently touched work matched this update closely enough to propose.",
    };
  }

  // Deduplicate by work item, keeping the strongest tier for each.
  const best = new Map<number, Candidate>();
  for (const c of candidates) {
    const prev = best.get(c.item.id);
    if (!prev || c.score > prev.score) best.set(c.item.id, c);
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);

  const [top, second] = ranked;
  if (second && top.score - second.score < AMBIGUITY_MARGIN) {
    return { kind: "ambiguous", choices: ranked.slice(0, 3) };
  }

  // Touching an item is not owning it, and neither is being linked to it.
  // Both are offered as a choice and wait for you rather than auto-matching.
  if (top.tier === "recently-touched" || top.tier === "linked") {
    return { kind: "ambiguous", choices: ranked.slice(0, 3) };
  }

  // The item matched may be a parent standing in for work tracked in its
  // children. Settle which level the update belongs on before proposing.
  const hierarchy = resolveHierarchy(top, items, update);
  if (hierarchy) return hierarchy;

  return { kind: "matched", candidate: top, runnersUp: ranked.slice(1, 3) };
}

function confirmedBeforeScoreRemoved(): void {
  // Intentionally removed. Once the text bonus is capped, confirmed-before
  // always outranks assigned on its tier base alone, so no boost is needed.
}

