import { WorkItem } from "./types";

/**
 * Maps an Azure DevOps work item response onto the engine's shape.
 *
 * The hierarchy rule in `match.ts` reads `parentId` and `childIds`, and nothing
 * populated them -- they were added to the fixture by hand, which left the rule
 * inert against live data. Relations only come back when the work item is
 * fetched with `$expand=Relations`, so that is the contract here.
 */

export interface AdoRelation {
  rel: string;
  url: string;
}

export interface AdoWorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations?: AdoRelation[];
}

const CHILD = "System.LinkTypes.Hierarchy-Forward";
const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const RELATED = "System.LinkTypes.Related";

/** Relation urls end in the work item id. */
function idFromUrl(url: string): number | null {
  const m = url.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export function relatedIds(item: AdoWorkItem): number[] {
  return (item.relations ?? [])
    .filter((r) => r.rel === RELATED)
    .map((r) => idFromUrl(r.url))
    .filter((id): id is number => id !== null);
}

/** `"Ankit Kushwaha <you@example.com>"`, or the expanded identity object. */
export function parseIdentity(value: unknown): { mail: string | null; name: string | null } {
  if (!value) return { mail: null, name: null };
  if (typeof value === "string") {
    const m = value.match(/^(.*?)\s*<(.+?)>\s*$/);
    if (m) return { name: m[1].trim(), mail: m[2].trim() };
    return { name: value.trim(), mail: null };
  }
  const o = value as Record<string, unknown>;
  return {
    name: typeof o.displayName === "string" ? o.displayName : null,
    mail: typeof o.uniqueName === "string" ? o.uniqueName : null,
  };
}

export function toWorkItem(item: AdoWorkItem): WorkItem {
  const f = item.fields;
  const identity = parseIdentity(f["System.AssignedTo"]);
  const childIds = (item.relations ?? [])
    .filter((r) => r.rel === CHILD)
    .map((r) => idFromUrl(r.url))
    .filter((id): id is number => id !== null);
  const related = relatedIds(item);

  const parentRelation = (item.relations ?? []).find((r) => r.rel === PARENT);
  const parentFromField = f["System.Parent"];
  const parentId =
    (parentRelation ? idFromUrl(parentRelation.url) : null) ??
    (typeof parentFromField === "number" ? parentFromField : null);

  return {
    id: item.id,
    rev: item.rev,
    type: String(f["System.WorkItemType"] ?? ""),
    state: String(f["System.State"] ?? ""),
    assignedTo: identity.mail,
    assignedToName: identity.name,
    changedDate: String(f["System.ChangedDate"] ?? ""),
    title: String(f["System.Title"] ?? ""),
    ...(parentId !== null ? { parentId } : {}),
    ...(childIds.length > 0 ? { childIds } : {}),
    ...(related.length > 0 ? { relatedIds: related } : {}),
  };
}

export function toWorkItems(items: AdoWorkItem[]): WorkItem[] {
  return items.map(toWorkItem);
}

/**
 * Children referenced by a parent but absent from the fetched set.
 *
 * Worth surfacing rather than ignoring: the hierarchy rule decides which words
 * are distinctive to a child by comparing against its siblings, so a partial
 * capture makes terms look more distinctive than they are.
 */
export function missingChildren(items: WorkItem[]): number[] {
  const present = new Set(items.map((i) => i.id));
  const missing = new Set<number>();
  for (const i of items) {
    for (const c of i.childIds ?? []) if (!present.has(c)) missing.add(c);
  }
  return [...missing];
}
