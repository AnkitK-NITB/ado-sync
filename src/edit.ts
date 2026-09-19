import { buildGroupProposal } from "./consolidate";
import { CardUpdate, EditProvenance, WorkItemCard } from "./types";

/**
 * Applies a person's edits to a consolidated card.
 *
 * Two editing models coexist, and the difference matters for more than
 * convenience. Per-line edits keep the card's structure, so it stays knowable
 * which update was changed and whether a vocabulary correction was taken --
 * that is the signal the auto-comment decision rests on. A raw edit hands the
 * whole body to the person, which is freer but discards that structure: once
 * the text is theirs, no part of it can be attributed back to a particular
 * thing they said.
 */

export type CardEdit =
  /** Rewrite one update's text. */
  | { kind: "edit-update"; index: number; text: string }
  /** Drop one update from the comment entirely. */
  | { kind: "remove-update"; index: number }
  /** Take a vocabulary repair into the text, deliberately. */
  | { kind: "accept-correction"; index: number }
  /** Replace the whole comment body by hand. */
  | { kind: "replace-body"; markdown: string };

export class EditConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditConflictError";
  }
}

export interface EditedCard {
  card: WorkItemCard;
  provenance: EditProvenance;
}

const emptyProvenance = (): EditProvenance => ({
  editedUpdates: [],
  removedUpdates: [],
  correctionsAccepted: 0,
  rawEdited: false,
});

export function applyEdits(
  card: WorkItemCard,
  edits: CardEdit[],
  meetingDate: Date
): EditedCard {
  let updates: (CardUpdate | null)[] = card.updates.map((u) => ({ ...u }));
  const provenance = emptyProvenance();
  let authoredBody: string | null = null;

  const live = (index: number): CardUpdate => {
    const u = updates[index];
    if (index < 0 || index >= updates.length || u === null) {
      throw new RangeError(`no update at index ${index}`);
    }
    return u;
  };

  for (const edit of edits) {
    // Once someone has written the body themselves, regenerating it from the
    // structure would silently throw their writing away. Refuse instead.
    if (authoredBody !== null && edit.kind !== "replace-body") {
      throw new EditConflictError(
        "The comment body was edited by hand, so per-line edits would discard it. " +
          "Replace the body again, or start over from the proposal."
      );
    }

    switch (edit.kind) {
      case "edit-update": {
        const u = live(edit.index);
        if (u.text !== edit.text) {
          u.text = edit.text;
          if (!provenance.editedUpdates.includes(edit.index)) {
            provenance.editedUpdates.push(edit.index);
          }
        }
        break;
      }

      case "accept-correction": {
        const u = live(edit.index);
        for (const fix of u.corrections ?? []) {
          const re = new RegExp(escapeRegExp(fix.heard), "gi");
          if (re.test(u.text)) {
            u.text = u.text.replace(re, fix.canonical);
            provenance.correctionsAccepted++;
          }
        }
        // The repair is now in the text, so there is nothing left to offer.
        u.corrections = undefined;
        if (!provenance.editedUpdates.includes(edit.index)) {
          provenance.editedUpdates.push(edit.index);
        }
        break;
      }

      case "remove-update": {
        live(edit.index);
        updates[edit.index] = null;
        if (!provenance.removedUpdates.includes(edit.index)) {
          provenance.removedUpdates.push(edit.index);
        }
        break;
      }

      case "replace-body": {
        authoredBody = edit.markdown;
        provenance.rawEdited = true;
        break;
      }
    }
  }

  const kept = updates.filter((u): u is CardUpdate => u !== null);

  // Removing everything is a decision not to comment, not an empty comment.
  if (kept.length === 0 && authoredBody === null) {
    return {
      card: {
        ...card,
        updates: [],
        proposed: undefined,
        status: "duplicate-skipped",
        skipReason: "Every update was removed, so there is nothing left to post.",
        controls: ["Skip"],
      },
      provenance,
    };
  }

  const proposed =
    authoredBody !== null
      ? {
          ...(card.proposed ?? buildGroupProposal(kept, card.workItem, meetingDate)),
          commentMarkdown: authoredBody,
          bodyAuthoredByUser: true,
        }
      : buildGroupProposal(kept, card.workItem, meetingDate);

  return { card: { ...card, updates: kept, proposed }, provenance };
}

/** Whether anything at all was changed. */
export function wasEdited(p: EditProvenance): boolean {
  return (
    p.rawEdited ||
    p.editedUpdates.length > 0 ||
    p.removedUpdates.length > 0 ||
    p.correctionsAccepted > 0
  );
}

/**
 * Accepting a vocabulary repair and nothing else is a different act from
 * rewriting what you said. Counting them the same would make the engine look
 * less trustworthy than it is.
 */
export function onlyAcceptedCorrections(p: EditProvenance): boolean {
  return (
    p.correctionsAccepted > 0 &&
    !p.rawEdited &&
    p.removedUpdates.length === 0
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
