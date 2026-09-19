/**
 * Turns a raw transcript file into the shape the card builder consumes.
 *
 * Two formats are supported because they are the two you actually get out of a
 * Teams meeting: the `.vtt` caption track from a recording, and a Markdown
 * recap pasted from Copilot or written by hand.
 *
 * Neither parser invents structure. A `.vtt` has no notion of topics, so a
 * speaker's contiguous run of cues becomes one topic and nothing is guessed
 * about status. Markdown carries whatever structure the author wrote, so
 * headings and status prefixes are read when present and left empty when not.
 */

export interface ParsedTopic {
  title: string;
  status?: string;
  text: string;
}

export interface ParsedTranscript {
  id: string;
  label: string;
  meeting: string;
  date: string;
  speaker: string;
  topics: ParsedTopic[];
  exclude: string[];
  /** Speakers seen in the file, so the caller can tell whose updates these are. */
  speakers: string[];
  format: "vtt" | "markdown" | "json";
}

/** Statuses a recap line may be tagged with. Anything else stays untagged. */
const STATUS_WORDS = ["DONE", "NEXT", "IN PROGRESS", "BLOCKED", "DOING", "TODO"];

function cleanSpeaker(raw: string): string {
  return raw
    .replace(/\s*\(.*?\)\s*$/, "")
    .replace(/[:：]\s*$/, "")
    .trim();
}

/** `00:01:23.456` or `01:23.456` -> seconds. */
function timecodeToSeconds(tc: string): number {
  const parts = tc.trim().split(":").map((p) => parseFloat(p.replace(",", ".")));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

interface Cue {
  speaker: string;
  text: string;
  start: number;
}

/**
 * Reads WEBVTT cues. Teams writes the speaker as `<v Name>text</v>`; some
 * exports instead prefix the line with `Name:`. Both appear in the wild, so
 * both are read, and a cue with neither is attributed to the previous speaker
 * rather than dropped -- a continuation line is still that person talking.
 */
export function parseVttCues(text: string): Cue[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const cues: Cue[] = [];
  let start = 0;
  let lastSpeaker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("-->")) {
      start = timecodeToSeconds(line.split("-->")[0]);
      continue;
    }
    const body = line.trim();
    if (!body || /^WEBVTT/i.test(body) || /^NOTE\b/i.test(body)) continue;
    // A bare number or uuid is a cue identifier, not speech.
    if (/^[\w-]+$/.test(body) && !/\s/.test(body) && !/[.!?]/.test(body)) continue;

    let speaker = "";
    let content = body;

    const v = body.match(/^<v\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/i);
    if (v) {
      speaker = cleanSpeaker(v[1]);
      content = v[2].trim();
    } else {
      const prefixed = body.match(/^([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3})\s*:\s*(.+)$/);
      if (prefixed) {
        speaker = cleanSpeaker(prefixed[1]);
        content = prefixed[2].trim();
      }
    }

    content = content.replace(/<[^>]+>/g, "").trim();
    if (!content) continue;

    if (!speaker) speaker = lastSpeaker;
    if (!speaker) continue;
    lastSpeaker = speaker;
    cues.push({ speaker, text: content, start });
  }
  return cues;
}

/**
 * Groups a speaker's contiguous cues into one topic.
 *
 * Captions are fragmented by design -- a sentence is split across cues at
 * whatever moment the encoder chose. Matching a three-word fragment against a
 * work item title is noise, so the run is joined back into continuous speech
 * before the engine ever sees it.
 */
export function parseVtt(text: string): ParsedTopic[] {
  const cues = parseVttCues(text);
  const topics: ParsedTopic[] = [];
  let current: { speaker: string; parts: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const joined = current.parts.join(" ").replace(/\s+/g, " ").trim();
    if (joined) topics.push({ title: current.speaker, text: joined });
    current = null;
  };

  for (const c of cues) {
    if (!current || current.speaker !== c.speaker) {
      flush();
      current = { speaker: c.speaker, parts: [] };
    }
    current.parts.push(c.text);
  }
  flush();
  return topics;
}

export function vttSpeakers(text: string): string[] {
  return [...new Set(parseVttCues(text).map((c) => c.speaker))];
}

/**
 * Reads a Markdown recap.
 *
 * `##` headings name a section, and bullets beneath become topics. A bullet may
 * carry a status prefix (`- DONE: ...`), which is kept. A paragraph with no
 * bullets is taken whole rather than dropped, because a recap written as prose
 * is still a recap.
 */
export function parseMarkdown(text: string): ParsedTopic[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const topics: ParsedTopic[] = [];
  let heading = "";
  let prose: string[] = [];

  const flushProse = () => {
    const joined = prose.join(" ").replace(/\s+/g, " ").trim();
    if (joined) topics.push({ title: heading || "Update", text: joined });
    prose = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      flushProse();
      heading = h[1].replace(/[*_`]/g, "").trim();
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.*)$/) || line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet) {
      flushProse();
      let body = bullet[1].replace(/[*_`]/g, "").trim();
      let status: string | undefined;
      for (const w of STATUS_WORDS) {
        const re = new RegExp("^" + w + "\\s*[:\\-–]\\s*", "i");
        if (re.test(body)) {
          status = w;
          body = body.replace(re, "").trim();
          break;
        }
      }
      if (body) topics.push({ title: heading || "Update", status, text: body });
      continue;
    }
    if (!line) {
      flushProse();
      continue;
    }
    prose.push(line.replace(/[*_`]/g, ""));
  }
  flushProse();
  return topics;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "transcript";
}

export interface ParseOptions {
  filename: string;
  content: string;
  /** Who this transcript belongs to; only their lines are kept for a .vtt. */
  speaker: string;
  meeting?: string;
  date?: string;
  label?: string;
}

/**
 * Parses an uploaded file into a transcript.
 *
 * For a `.vtt`, only the named speaker's turns are kept. The product rule is
 * that a person's update is theirs alone, and a caption file contains the whole
 * room -- keeping everyone would attribute other people's words to whoever
 * uploaded the file.
 */
export function parseTranscriptFile(opts: ParseOptions): ParsedTranscript {
  const { filename, content, speaker } = opts;
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();

  let topics: ParsedTopic[];
  let speakers: string[] = [];
  let format: ParsedTranscript["format"];

  if (ext === "vtt") {
    format = "vtt";
    speakers = vttSpeakers(content);
    const all = parseVtt(content);
    const mine = all.filter((t) => t.title.toLowerCase() === speaker.toLowerCase());
    // Falling back to every turn would put other people's words under this
    // person's name, so an unmatched speaker is reported as empty instead.
    topics = mine.map((t, i) => ({ title: "Turn " + (i + 1), text: t.text }));
  } else if (ext === "md" || ext === "markdown" || ext === "txt") {
    format = "markdown";
    const all = parseMarkdown(content);
    // A recap usually has one heading per person, so those headings are the
    // attribution. Filtering to the uploader's own section keeps the same rule
    // the .vtt path follows: a person's update is theirs alone.
    //
    // When no heading matches the speaker the headings are topics rather than
    // names, and everything is kept -- guessing otherwise would silently throw
    // away the whole recap.
    const own = all.filter((t) => t.title.toLowerCase() === speaker.toLowerCase());
    topics = own.length ? own : all;
    speakers = [...new Set(all.map((t) => t.title))];
  } else if (ext === "json") {
    format = "json";
    const j = JSON.parse(content);
    topics = Array.isArray(j.topics) ? j.topics : [];
    speakers = [j.speaker ?? speaker];
    return {
      id: j.id ?? slugify(filename),
      label: j.label ?? opts.label ?? filename,
      meeting: j.meeting ?? opts.meeting ?? "Meeting",
      date: j.date ?? opts.date ?? new Date().toISOString(),
      speaker: j.speaker ?? speaker,
      topics,
      exclude: j.exclude ?? [],
      speakers,
      format,
    };
  } else {
    throw new Error("Unsupported file type '." + ext + "'. Use .vtt, .md or .json.");
  }

  const date = opts.date ?? new Date().toISOString();
  const meeting = opts.meeting ?? "Meeting";
  const label = opts.label ?? meeting + " — " + new Date(date).toLocaleDateString();

  return {
    id: slugify(meeting + "-" + date.slice(0, 10)),
    label,
    meeting,
    date,
    speaker,
    topics,
    exclude: [],
    speakers,
    format,
  };
}
