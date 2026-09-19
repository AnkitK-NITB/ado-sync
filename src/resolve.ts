import * as fs from "fs";
import * as readline from "node:readline/promises";
import { signalTerms } from "./normalize";
import { Card, EnrollmentFile, WorkItem } from "./types";

export interface Confirmation {
  speaker: string;
  phrase: string;
  workItemId: number;
  confirmedAt: string;
}

export function derivePhrase(updateText: string, chosen: WorkItem): string {
  const updateTokens = significantTokens(updateText);
  const titleTokens = significantTokens(chosen.title);
  const titleJoined = ` ${titleTokens.join(" ")} `;

  let best: string[] = [];
  for (let start = 0; start < updateTokens.length; start++) {
    for (let end = start + 1; end <= updateTokens.length; end++) {
      const run = updateTokens.slice(start, end);
      const phrase = ` ${run.join(" ")} `;
      if (phrase.length <= best.join(" ").length) continue;
      if (titleJoined.includes(phrase)) best = run;
    }
  }

  const longestRun = best.join(" ");
  if (isUsable(longestRun)) return longestRun;

  const titleSet = new Set(titleTokens);
  const sharedTerms = updateTokens
    .filter((term, index) => titleSet.has(term) && updateTokens.indexOf(term) === index)
    .sort((a, b) => b.length - a.length || updateTokens.indexOf(a) - updateTokens.indexOf(b));
  const twoTerms = sharedTerms.slice(0, 2).join(" ");
  if (isUsable(twoTerms)) return twoTerms;

  const distinctive = [...new Set(updateTokens)].sort((a, b) => b.length - a.length)[0];
  if (isUsable(distinctive)) return distinctive;

  const readable = updateText
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .find((word) => word.length >= 4);
  return readable ?? "work";
}

export async function resolveInteractive(
  cards: Card[],
  workItems: WorkItem[],
  enrollment: EnrollmentFile,
  enrollmentPath: string,
  confirmedAt = new Date().toISOString()
): Promise<Confirmation[]> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const confirmations: Confirmation[] = [];
    for (const card of cards) {
      if (card.status === "ambiguous") {
        const chosen = await askAmbiguousChoice(rl, card, workItems);
        if (chosen) confirmations.push(confirm(enrollment, card, chosen, confirmedAt));
      } else if (card.status === "unresolved" && isEnrolled(card.speaker, enrollment)) {
        const chosen = await askWorkItemId(rl, card, workItems);
        if (chosen) confirmations.push(confirm(enrollment, card, chosen, confirmedAt));
      }
    }

    if (confirmations.length > 0) {
      writeEnrollmentAtomic(enrollmentPath, enrollment);
    }
    return confirmations;
  } finally {
    rl.close();
  }
}

export function upsertConfirmedMatch(
  enrollment: EnrollmentFile,
  speaker: string,
  phrase: string,
  workItemId: number,
  confirmedAt: string
): boolean {
  const person = enrollment.enrolled.find(
    (e) => e.teamsDisplayName.toLowerCase() === speaker.toLowerCase() && !e.paused
  );
  if (!person) return false;

  const normalizedPhrase = safePhrase(phrase);
  const existing = person.confirmedMatches.find(
    (cm) => cm.phrase.toLowerCase() === normalizedPhrase.toLowerCase()
  );
  if (existing) {
    existing.workItemId = workItemId;
    existing.confirmedAt = confirmedAt;
  } else {
    person.confirmedMatches.push({ phrase: normalizedPhrase, workItemId, confirmedAt });
  }
  return true;
}

export function writeEnrollmentAtomic(enrollmentPath: string, enrollment: EnrollmentFile): void {
  const tempPath = `${enrollmentPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(enrollment, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, enrollmentPath);
}

function significantTokens(text: string): string[] {
  const terms = new Set(signalTerms(text));
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => terms.has(word));
}

function isUsable(phrase: string | undefined): phrase is string {
  return Boolean(phrase && phrase.trim().length >= 4);
}

function safePhrase(phrase: string): string {
  const clean = phrase.trim().toLowerCase();
  return clean.length >= 4 ? clean : "work";
}

function isEnrolled(speaker: string, enrollment: EnrollmentFile): boolean {
  return enrollment.enrolled.some(
    (e) => e.teamsDisplayName.toLowerCase() === speaker.toLowerCase() && !e.paused
  );
}

async function askAmbiguousChoice(
  rl: readline.Interface,
  card: Card,
  workItems: WorkItem[]
): Promise<WorkItem | undefined> {
  console.log(`\nResolve ambiguous update for ${card.speaker}:`);
  console.log(`  "${card.yourUpdate}"`);
  const choices = card.choices ?? [];
  choices.forEach((item, index) => {
    console.log(
      `  ${index + 1}) ${item.type} ${item.id} — ${item.title} (${item.state})`
    );
  });
  console.log("  o) Enter a different work item id");
  console.log("  s) Skip");

  while (true) {
    const answer = (await rl.question("Choose an option: ")).trim().toLowerCase();
    if (answer === "" || answer === "s" || answer === "skip") return undefined;
    if (answer === "o" || answer === "other") return askWorkItemId(rl, card, workItems);

    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index];

    const directId = Number(answer);
    const direct = workItems.find((item) => item.id === directId);
    if (direct) return direct;
    console.log("Please enter a listed number, a work item id, 'o', or 's'.");
  }
}

async function askWorkItemId(
  rl: readline.Interface,
  card: Card,
  workItems: WorkItem[]
): Promise<WorkItem | undefined> {
  console.log(`\nResolve unresolved update for ${card.speaker}:`);
  console.log(`  "${card.yourUpdate}"`);
  while (true) {
    const answer = (await rl.question("Enter a work item id, or 's' to skip: "))
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "s" || answer === "skip") return undefined;

    const id = Number(answer);
    const chosen = workItems.find((item) => item.id === id);
    if (chosen) return chosen;
    console.log("That work item id was not found in the captured work item set.");
  }
}

function confirm(
  enrollment: EnrollmentFile,
  card: Card,
  chosen: WorkItem,
  confirmedAt: string
): Confirmation {
  const phrase = derivePhrase(card.yourUpdate, chosen);
  upsertConfirmedMatch(enrollment, card.speaker, phrase, chosen.id, confirmedAt);
  console.log(
    `Confirmed "${phrase}" → ${chosen.type} ${chosen.id} (${chosen.title}) for ${card.speaker}.`
  );
  return { speaker: card.speaker, phrase, workItemId: chosen.id, confirmedAt };
}
