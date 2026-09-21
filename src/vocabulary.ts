import { VocabularyFile, VocabularyTerm, WordCorrection } from "./types";
import { sameSignalTerms } from "./terms";

/**
 * Repairs domain vocabulary that speech-to-text mangled.
 *
 * This matters more than it looks. The matcher keys on signal terms, and a
 * product name is usually the most discriminating word in an update -- so a
 * mangled name does not merely weaken a match, it deletes the best evidence
 * for it. "ACHME SDK" and "ACHMES DK" are both AcmeSDK, which appears in 4096
 * work items; as transcribed, neither matches anything at all.
 *
 * Corrections apply to MATCHING only. What a person said is never rewritten in
 * a comment posted under their name -- the correction is surfaced on the card
 * so they can take it into the text deliberately.
 */

/** Separators speech-to-text puts between the parts of one spoken term. */
const SEP = "[\\s\\-_]+";

interface Variant {
  variant: string;
  canonical: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A variant as a pattern that tolerates however the transcriber spaced it.
 *
 * A two-word term has to match when the recogniser doubled the space, wrote a
 * hyphen, or broke the line -- whitespace and hyphenation in a transcript are
 * an artefact of the recogniser, not something the speaker chose. One separator
 * is still required, so a variant can never match its own canonical form
 * ("start Cosmos" must not eat "StartCosmos") and turn the repair into a no-op
 * that still reports itself.
 */
function variantPattern(variant: string): string {
  const parts = variant.trim().split(/[\s\-_]+/).filter(Boolean).map(escapeRegExp);
  return parts.join(SEP);
}

/** Longest variants first, so "hardware lock collector" wins over "hardware lock". */
function orderedVariants(terms: VocabularyTerm[]): Variant[] {
  const pairs: Variant[] = [];
  const claimed = new Map<string, string>();

  for (const t of terms) {
    if (!t.canonical || !t.canonical.trim()) continue;

    for (const v of t.variants) {
      if (!v || !v.trim()) continue;

      // A variant that leaves the matcher's terms unchanged is a spelling
      // difference, not a transcription error. This asks the question in the
      // matcher's own tokenisation: "XPF" and "xPF" really are the same term,
      // but "start Cosmos" is two terms where "StartCosmos" is one, so that
      // one is a repair worth making.
      if (sameSignalTerms(v, t.canonical)) continue;

      // The same variant claimed by two canonicals is a data error. Resolving
      // it by array order would be silent and arbitrary, so the first claim
      // wins here and validateVocabulary() reports the conflict.
      const key = v.trim().toLowerCase();
      if (claimed.has(key) && claimed.get(key) !== t.canonical) continue;
      claimed.set(key, t.canonical);

      pairs.push({ variant: v, canonical: t.canonical });
    }
  }

  return pairs.sort((a, b) => b.variant.length - a.variant.length);
}

/**
 * Rewrites known mis-transcriptions into their canonical form for matching, and
 * reports what it changed.
 *
 * One pass, not one pass per variant: replacing sequentially lets a canonical
 * produced by an earlier rule be matched and mangled by a later one, which is
 * silent and very hard to spot. Scanning once means every position is decided
 * against the ORIGINAL text, and output is only ever appended.
 */
export function canonicalize(
  text: string,
  vocabulary: VocabularyFile
): { normalized: string; corrections: WordCorrection[] } {
  const variants = orderedVariants(vocabulary.terms);
  if (variants.length === 0) return { normalized: text, corrections: [] };

  // Each alternative is its own capture group, so the variant that matched --
  // and therefore the canonical to substitute -- is known from which group set.
  const combined = new RegExp(
    variants
      .map((v) => `((?<![A-Za-z0-9])(?:${variantPattern(v.variant)})(?![A-Za-z0-9]))`)
      .join("|"),
    "gi"
  );

  // Distinct spellings per canonical: a term heard twice with different casing
  // is two things the person can usefully be shown, not one.
  const heardFor = new Map<string, Set<string>>();
  const order: string[] = [];

  let normalized = "";
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = combined.exec(text)) !== null) {
    const which = m.slice(1).findIndex((g) => g !== undefined);
    if (which < 0) continue;

    const { canonical } = variants[which];
    const heard = m[0];

    // Defence in depth against a vocabulary defining a variant that happens to
    // match its own canonical: substituting would change nothing downstream
    // while still claiming a repair.
    if (sameSignalTerms(heard, canonical)) continue;

    normalized += text.slice(last, m.index) + canonical;
    last = m.index + heard.length;

    if (!heardFor.has(canonical)) {
      heardFor.set(canonical, new Set());
      order.push(canonical);
    }
    heardFor.get(canonical)!.add(heard);
  }
  normalized += text.slice(last);

  const corrections: WordCorrection[] = [];
  for (const canonical of order) {
    for (const heard of heardFor.get(canonical)!) {
      corrections.push({ heard, canonical });
    }
  }

  return { normalized, corrections };
}

export interface VocabularyIssue {
  kind: "ambiguous-variant" | "empty-canonical" | "empty-variant" | "no-op-variant";
  detail: string;
}

/**
 * Reports data errors that would otherwise be resolved silently.
 *
 * A vocabulary is hand-written from observed transcripts, so it drifts: the
 * same variant gets attached to two canonicals, or one gets added that changes
 * nothing. Neither throws, and both quietly weaken matching -- exactly the
 * class of fault this layer exists to prevent.
 */
export function validateVocabulary(vocabulary: VocabularyFile): VocabularyIssue[] {
  const issues: VocabularyIssue[] = [];
  const claimed = new Map<string, string>();

  for (const t of vocabulary.terms) {
    if (!t.canonical || !t.canonical.trim()) {
      issues.push({
        kind: "empty-canonical",
        detail: `a term with variants [${t.variants.join(", ")}] has no canonical form`,
      });
      continue;
    }

    for (const v of t.variants) {
      if (!v || !v.trim()) {
        issues.push({ kind: "empty-variant", detail: `${t.canonical} has an empty variant` });
        continue;
      }

      if (sameSignalTerms(v, t.canonical)) {
        issues.push({
          kind: "no-op-variant",
          detail: `"${v}" is indistinguishable from "${t.canonical}" to the matcher, so it is ignored`,
        });
        continue;
      }

      const key = v.trim().toLowerCase();
      const owner = claimed.get(key);
      if (owner && owner !== t.canonical) {
        issues.push({
          kind: "ambiguous-variant",
          detail: `"${v}" is claimed by both "${owner}" and "${t.canonical}"; "${owner}" wins`,
        });
        continue;
      }
      claimed.set(key, t.canonical);
    }
  }

  return issues;
}

/** Empty vocabulary, for callers that have none configured. */
export const NO_VOCABULARY: VocabularyFile = { terms: [] };
