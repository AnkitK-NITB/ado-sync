import { VocabularyFile, VocabularyTerm, WordCorrection } from "./types";

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

/** Longest variants first, so "hardware lock collector" wins over "hardware lock". */
function orderedVariants(terms: VocabularyTerm[]): { variant: string; canonical: string }[] {
  const pairs: { variant: string; canonical: string }[] = [];
  for (const t of terms) {
    for (const v of t.variants) {
      // A variant that survives tokenisation identically to its canonical form
      // is a spelling difference, not a transcription error, and changes nothing.
      if (tokenise(v) === tokenise(t.canonical)) continue;
      pairs.push({ variant: v, canonical: t.canonical });
    }
  }
  return pairs.sort((a, b) => b.variant.length - a.variant.length);
}

function tokenise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites known mis-transcriptions into their canonical form for matching, and
 * reports what it changed.
 */
export function canonicalize(
  text: string,
  vocabulary: VocabularyFile
): { normalized: string; corrections: WordCorrection[] } {
  let normalized = text;
  const corrections: WordCorrection[] = [];

  for (const { variant, canonical } of orderedVariants(vocabulary.terms)) {
    const re = new RegExp(`\\b${escapeRegExp(variant)}\\b`, "gi");
    if (!re.test(normalized)) continue;
    re.lastIndex = 0;

    const seen = normalized.match(re);
    normalized = normalized.replace(re, canonical);
    if (seen) {
      corrections.push({ heard: seen[0], canonical });
    }
  }

  return { normalized, corrections };
}

/** Empty vocabulary, for callers that have none configured. */
export const NO_VOCABULARY: VocabularyFile = { terms: [] };
