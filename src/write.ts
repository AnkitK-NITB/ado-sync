import { ProposedUpdate, WorkItem, WorkItemCard, WriteAction } from "./types";

/**
 * Builds the guarded write.
 *
 * The original design asserted `/rev` with a JSON Patch `test` operation, but
 * posted the body through the `comments` endpoint -- and that endpoint does not
 * accept a patch document, so the assertion never protected the comment it was
 * supposed to protect. The rev check and the write were two separate calls, and
 * anything landing between them was lost.
 *
 * Posting through `System.History` puts both operations in one patch document,
 * so the server evaluates them atomically: a stale rev rejects the comment
 * itself with VS403351 rather than overwriting a newer human edit. Both
 * surfaces render in the work item's Discussion, so nothing is given up.
 */

const API_VERSION = "7.1";

export type JsonPatchOp =
  | { op: "test"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown };

export function workItemPatchUrl(org: string, project: string, id: number): string {
  return `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;
}

/**
 * System.History is an HTML field, not a markdown one. The comment is composed
 * as markdown for the card, so the subset we actually emit is converted here --
 * anything richer would render as literal asterisks in the Discussion tab.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inList = false;

  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/_(.+?)_/g, "<em>$1</em>");

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Preserved verbatim: this is the duplicate-suppression marker, and it has
    // to survive into the posted body or dedupe breaks on the next run.
    if (/^<!--[\s\S]*-->$/.test(line.trim())) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(line.trim());
      continue;
    }

    if (line.startsWith("- ")) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }

    if (inList) { out.push("</ul>"); inList = false; }
    if (line.trim() === "") continue;
    out.push(`<div>${inline(line)}</div>`);
  }

  if (inList) out.push("</ul>");
  return out.join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * One atomic patch per work item: assert the revision that was read, then
 * write. A state change rides in the same document, so it is covered by the
 * same assertion rather than racing behind it.
 */
export function buildPatch(item: WorkItem, proposed: ProposedUpdate): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [
    { op: "test", path: "/rev", value: item.rev },
    { op: "add", path: "/fields/System.History", value: markdownToHtml(proposed.commentMarkdown) },
  ];
  if (proposed.stateChange) {
    ops.push({ op: "add", path: "/fields/System.State", value: proposed.stateChange.to });
  }
  return ops;
}

export function buildWriteAction(
  card: WorkItemCard,
  org: string,
  project: string
): WriteAction | null {
  if (card.status !== "proposed" || !card.proposed || !card.workItem) return null;
  return {
    workItemId: card.workItem.id,
    expectedRev: card.workItem.rev,
    commentMarkdown: card.proposed.commentMarkdown,
    method: "PATCH",
    url: workItemPatchUrl(org, project, card.workItem.id),
    contentType: "application/json-patch+json",
    patch: buildPatch(card.workItem, card.proposed),
  };
}

export function buildWriteActions(
  cards: WorkItemCard[],
  org: string,
  project: string
): WriteAction[] {
  return cards
    .map((c) => buildWriteAction(c, org, project))
    .filter((a): a is WriteAction => a !== null);
}

/** The server's rejection when the asserted revision no longer holds. */
export const STALE_REV_ERROR = "VS403351";

export function isStaleRevRejection(responseBody: string): boolean {
  return responseBody.includes(STALE_REV_ERROR) || /Test Operation for path \/rev failed/i.test(responseBody);
}
