import { canonicalize, NO_VOCABULARY } from "./vocabulary";
import {
  Enrollment,
  SpeakerUpdate,
  Transcript,
  Utterance,
  VocabularyFile,
} from "./types";

/** Conversational filler that carries no status information. */
const CHATTER = [
  /^(hey|hi|hello|good morning|good evening)\b/i,
  /^(yeah|yes|no|okay|ok|sure|thanks|thank you)\b[.,!]?$/i,
  /^shall i start\b/i,
  /^(please )?go ahead\b/i,
  // Acknowledgement stacked in front of a hand-off, e.g. "Yeah, yeah, please go ahead."
  /^((yeah|yes|no|okay|ok|sure)[,\s]+)+(please\s+)?(go ahead|carry on|continue)\b/i,
];

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

export function isChatter(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return true;
  return CHATTER.some((re) => re.test(t));
}

/** Pulls work item ids that were actually spoken, e.g. "PBI 1234", "#1234". */
export function extractExplicitIds(text: string): number[] {
  const ids = new Set<number>();
  const patterns = [
    /\b(?:pbi|bug|task|feature|work item|workitem|ab)\s*#?\s*(\d{3,9})\b/gi,
    /#(\d{3,9})\b/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      ids.add(Number(m[1]));
    }
  }
  return [...ids];
}

export function signalTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * Collapses a transcript into one consolidated update per speaker.
 *
 * Filler is dropped. Speakers who are not enrolled are still surfaced, but
 * flagged unenrolled — the agent never acts on someone who has not verified
 * their own identity.
 */
export function normalize(
  transcript: Transcript,
  enrolled: Enrollment[],
  vocabulary: VocabularyFile = NO_VOCABULARY
): SpeakerUpdate[] {
  const byName = new Map<string, Enrollment>(
    enrolled.map((e) => [e.teamsDisplayName.toLowerCase(), e])
  );

  const grouped = new Map<string, Utterance[]>();
  for (const u of transcript.utterances) {
    if (isChatter(u.text)) continue;
    grouped.set(u.speaker, [...(grouped.get(u.speaker) ?? []), u]);
  }

  const updates: SpeakerUpdate[] = [];
  for (const [speaker, utterances] of grouped) {
    const enrollment = byName.get(speaker.toLowerCase());
    const enrolled = Boolean(enrollment) && !enrollment!.paused;
    const full = utterances.map((u) => u.text.trim()).join(" ");

    // One person usually covers several topics in a single turn. Matching the
    // whole turn as one blob makes every multi-topic update look ambiguous, so
    // split into topic segments and match each independently.
    const segments = enrolled ? segmentTopics(full) : [full];

    for (const text of segments) {
      // Matching runs on the repaired wording; the update keeps what was said.
      const { normalized, corrections } = canonicalize(text, vocabulary);
      updates.push({
        speaker,
        adoIdentity: enrollment?.adoIdentity,
        enrolled,
        text,
        explicitIds: extractExplicitIds(normalized),
        signalTerms: signalTerms(normalized),
        corrections: corrections.length > 0 ? corrections : undefined,
      });
    }
  }
  return updates;
}

/**
 * Splits a turn into topic segments on sentence boundaries, folding fragments
 * that are too thin to match on their own back into the previous segment.
 */
export function segmentTopics(text: string): string[] {
  const sentences = text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const segments: string[] = [];
  for (const s of sentences) {
    if (isChatter(s)) continue;
    if (signalTerms(s).length < 3 && segments.length > 0) {
      segments[segments.length - 1] += " " + s;
    } else {
      segments.push(s);
    }
  }
  return segments.length > 0 ? segments : [text];
}

/** Word-overlap similarity between an update and a work item title. */
export function overlapScore(terms: string[], title: string): number {
  const titleTerms = new Set(signalTerms(title));
  if (titleTerms.size === 0) return 0;
  let hits = 0;
  for (const t of terms) if (titleTerms.has(t)) hits++;
  return hits / Math.sqrt(titleTerms.size);
}
