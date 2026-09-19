import { Receipt } from "./types";

const DEVOPS_BASE = "https://dev.azure.com/contoso/Engineering/_workitems/edit";

export function renderReceiptMarkdown(receipt: Receipt): string {
  const { name, date } = splitMeeting(receipt.meeting);
  const lines = [
    "# ADO Sync Receipt",
    "",
    `- Meeting: ${name}`,
    `- Date: ${date}`,
    `- Generated: ${receipt.generatedAt}`,
    `- Mode: ${receipt.mode}`,
    `- Dry run: ${receipt.dryRun ? "yes" : "no"}`,
    "",
    "## Updated",
    ...renderUpdated(receipt),
    "",
    "## Skipped",
    ...renderSkipped(receipt),
    "",
    "## Unresolved",
    ...renderUnresolved(receipt),
    "",
    "Restricted work-item detail is never posted to the shared meeting chat.",
    "",
  ];
  return lines.join("\n");
}

function splitMeeting(meeting: string): { name: string; date: string } {
  const parts = meeting.split(" — ");
  if (parts.length >= 2) return { name: parts.slice(0, -1).join(" — "), date: parts.at(-1)! };
  return { name: meeting, date: "unknown" };
}

function renderUpdated(receipt: Receipt): string[] {
  if (receipt.updated.length === 0) return ["- None"];
  return receipt.updated.map(
    (item) =>
      `- [${item.workItemId}](${DEVOPS_BASE}/${item.workItemId}) — ${item.title}: ${item.summary}`
  );
}

function renderSkipped(receipt: Receipt): string[] {
  if (receipt.skipped.length === 0) return ["- None"];
  return receipt.skipped.map((item) => {
    if (!item.workItemId) return `- ${item.reason}`;
    return `- [${item.workItemId}](${DEVOPS_BASE}/${item.workItemId}) — ${
      item.title ?? "Untitled"
    }: ${item.reason}`;
  });
}

function renderUnresolved(receipt: Receipt): string[] {
  if (receipt.unresolved.length === 0) return ["- None"];
  return receipt.unresolved.map(
    (item) => `- ${item.speaker}: ${item.reason}\n  > ${item.text}`
  );
}
