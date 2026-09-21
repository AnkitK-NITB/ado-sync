/**
 * The one definition of "what the matcher actually sees".
 *
 * This lives on its own because three layers depend on agreeing about it: the
 * matcher scores on these terms, normalisation produces them, and the
 * vocabulary layer decides whether a repair is worth making by asking whether
 * it changes them. When that last question was answered with a different
 * tokenisation, repairs that mattered were silently discarded -- "start Cosmos"
 * and "StartCosmos" look identical if you strip all punctuation into one blob,
 * but they are two terms versus one to everything downstream.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "is", "was", "are", "were", "be", "been", "i", "we", "you", "it", "this",
  "that", "my", "me", "will", "have", "has", "had", "do", "did", "done",
  "still", "need", "needs", "more", "most", "time", "yesterday", "today",
  "around", "through", "from", "can", "cant", "about", "there", "then",
  "going", "go", "just", "also", "out", "up", "on", "at", "by", "so", "not",
  // Generic quantifiers and filler. These carry no information, but inverse
  // document frequency cannot detect that: across 110 short work item titles
  // "any" appears once, so it scores as maximally distinctive while actually
  // distinguishing nothing. Rarity in a small corpus is not informativeness,
  // which is why this class has to be listed rather than inferred.
  "any", "some", "all", "get", "got", "day", "days", "week", "thing", "things",
  "lot", "bit", "much", "many", "few", "really", "actually", "basically",
]);

export function signalTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * Whether two spellings are indistinguishable to the matcher.
 *
 * Used to tell a real transcription error from a capitalisation difference:
 * repairing "XPF" to "xPF" changes nothing anyone downstream can observe, so
 * surfacing it to a person as a correction would be noise.
 */
export function sameSignalTerms(a: string, b: string): boolean {
  const ta = signalTerms(a);
  const tb = signalTerms(b);
  return ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}
