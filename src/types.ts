export interface Utterance {
  speaker: string;
  text: string;
}

export interface Transcript {
  meeting: {
    title: string;
    organizer: string;
    occurredAt: string;
    source: string;
    transcriptAvailable: boolean;
  };
  utterances: Utterance[];
}

export interface WorkItem {
  id: number;
  rev: number;
  type: string;
  state: string;
  assignedTo: string | null;
  assignedToName: string | null;
  changedDate: string;
  title: string;
  /** Parent in the work item hierarchy, when one was captured. */
  parentId?: number | null;
  /** Children in the work item hierarchy, when they were captured. */
  childIds?: number[];
  /**
   * Non-hierarchical links ("Related"), when captured. A bug related to a PBI
   * you own is often the thing you actually spoke about, but it is reachable
   * only by following the link -- its title need not resemble the parent's.
   */
  relatedIds?: number[];
}

export interface WorkItemSet {
  capturedAt: string;
  org: string;
  project: string;
  areaPath: string;
  source: string;
  items: WorkItem[];
}

/** A domain term and the mis-transcriptions actually observed for it. */
export interface VocabularyTerm {
  canonical: string;
  variants: string[];
  what?: string;
  evidence?: string;
}

export interface VocabularyFile {
  note?: string;
  terms: VocabularyTerm[];
}

/** A mis-transcription repaired for matching, kept visible to the person. */
export interface WordCorrection {
  heard: string;
  canonical: string;
}

export interface Enrollment {
  teamsDisplayName: string;
  adoIdentity: string;
  verifiedAt: string;
  mode: "review-only" | "auto-comment" | "field-updates";
  paused: boolean;
  pinnedWorkItemIds: number[];
  confirmedMatches: { phrase: string; workItemId: number; confirmedAt: string }[];
  excludedMeetingTitles: string[];
}

export interface EnrollmentFile {
  enrolled: Enrollment[];
  writeTarget: { sandboxWorkItemId: number; reason: string };
}

/** One person's consolidated spoken update for a meeting. */
export interface SpeakerUpdate {
  speaker: string;
  /** Only set when the speaker is enrolled and identity-verified. */
  adoIdentity?: string;
  enrolled: boolean;
  text: string;
  /** Work item ids spoken aloud, e.g. "PBI 12345" or "#12345". */
  explicitIds: number[];
  signalTerms: string[];
  /** Short topic label, when the source already identified topics. */
  topic?: string;
  /** DONE / IN PROGRESS / BLOCKED / NEXT, when the source classified it. */
  progress?: string;
  /** Mis-transcriptions repaired before matching. */
  corrections?: WordCorrection[];
}

export type MatchTier =
  | "explicit-id"
  | "pinned"
  | "confirmed-before"
  | "assigned"
  | "recently-touched"
  | "linked";

export interface Candidate {
  item: WorkItem;
  tier: MatchTier;
  score: number;
  reason: string;
}

export type MatchOutcome =
  | { kind: "matched"; candidate: Candidate; runnersUp: Candidate[] }
  | { kind: "ambiguous"; choices: Candidate[]; reason?: string }
  | { kind: "unresolved"; reason: string };

export interface Match {
  update: SpeakerUpdate;
  outcome: MatchOutcome;
}

export interface ProposedUpdate {
  commentMarkdown: string;
  stateChange: null | { from: string; to: string };
  nextAction: string;
  /** Why the state was left alone, when it was. */
  stateRationale: string;
  /** True when the person replaced the body by hand. */
  bodyAuthoredByUser?: boolean;
}

/** What a person changed before approving, and how. */
export interface EditProvenance {
  /** Indexes of updates whose text was changed. */
  editedUpdates: number[];
  /** Indexes of updates dropped from the comment. */
  removedUpdates: number[];
  /** Vocabulary repairs taken into the text. */
  correctionsAccepted: number;
  /** True when the whole body was rewritten, which discards the structure. */
  rawEdited: boolean;
}

export type CardStatus = "proposed" | "duplicate-skipped" | "ambiguous" | "unresolved";

export interface Card {
  speaker: string;
  adoIdentity?: string;
  status: CardStatus;
  yourUpdate: string;
  matchedWorkItem?: WorkItem;
  matchTier?: MatchTier;
  matchReason?: string;
  choices?: WorkItem[];
  /** Why a choice is being asked for, when the reason is structural. */
  ambiguityReason?: string;
  proposed?: ProposedUpdate;
  skipReason?: string;
  controls: string[];
}

export interface WriteAction {
  workItemId: number;
  expectedRev: number;
  commentMarkdown: string;
  method: "PATCH";
  url: string;
  contentType: "application/json-patch+json";
  /** test on /rev and the write, in one document, evaluated atomically. */
  patch: { op: "test" | "add"; path: string; value: unknown }[];
}

/** One line of a consolidated card — a single thing the person said. */
export interface CardUpdate {
  text: string;
  topic?: string;
  progress?: string;
  tier: MatchTier;
  reason: string;
  /** True when this line alone was not decisive and leaned on corroboration. */
  corroborated: boolean;
  /** Mis-transcriptions repaired for matching, shown so they can be accepted. */
  corrections?: WordCorrection[];
}

/**
 * A card is per work item, not per sentence. One person usually touches the
 * same item several times in a single standup, and that is one comment on one
 * item, not five.
 */
export interface WorkItemCard {
  speaker: string;
  adoIdentity?: string;
  status: CardStatus;
  workItem: WorkItem;
  updates: CardUpdate[];
  proposed?: ProposedUpdate;
  skipReason?: string;
  choices?: WorkItem[];
  ambiguityReason?: string;
  /** Set when repetition across the meeting is what settled the match. */
  corroboration?: string;
  controls: string[];
}

export interface Receipt {
  meeting: string;
  generatedAt: string;
  mode: string;
  dryRun: boolean;
  updated: { workItemId: number; title: string; summary: string }[];
  skipped: { workItemId?: number; title?: string; reason: string }[];
  unresolved: { speaker: string; text: string; reason: string }[];
}
