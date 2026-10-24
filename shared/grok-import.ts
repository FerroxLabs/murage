// Adapted from upstream OpenMausBot PR #3073, merge 1da83432c (Apache-2.0):
// shared/grok-import.ts (share-link and export readers). Modifications
// Copyright 2026 Ferrox Labs, AGPL-3.0-or-later. The grokbot-bundle/v1 field
// names follow pi-grokbot-import (MIT, github.com/Shixuuu/pi-grokbot-import).
//
// Bringing a shared Grok Bot into Murage. Pure text, read by the renderer and
// the server: a public x.ai/bot/<id> link, or the export a person's own Grok
// Bot writes when they paste GROK_EXPORT_PROMPT into it. Turning either into a
// bot package is server work (server/grok-import.ts).

export const GROK_EXPORT_FORMAT = "murage.grok/1";
/** Exports written for the upstream prompt read the same way. */
export const GROK_UPSTREAM_EXPORT_FORMAT = "openmaus.grok/1";
export const GROK_BUNDLE_FORMAT = "grokbot-bundle/v1";
const FORMATS = new Set<unknown>([GROK_EXPORT_FORMAT, GROK_UPSTREAM_EXPORT_FORMAT, GROK_BUNDLE_FORMAT]);

/** The largest export Murage reads. A real export is a few KB; a 1 MB paste is
 * refused before any parsing. */
export const GROK_PASTE_MAX_BYTES = 512 * 1024;

/** What the public share page shows. */
export interface GrokTemplateCard {
  shareId: string;
  name: string;
  creator?: string;
  description: string;
  url: string;
}

export interface GrokExport {
  name: string;
  title?: string;
  description: string;
  instructions: string;
  creator?: string;
  sourceUrl?: string;
  color?: string;
  skills: Array<{ name: string; description: string; body: string }>;
  routines: Array<{ name: string; schedule: string; cron: string; prompt: string }>;
  apps: string[];
  memories: string[];
}

/** Every message is one plain sentence a person can act on. */
export class GrokImportError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "GrokImportError";
    this.status = status;
  }
}

const SHARE_ID = /^[A-Za-z0-9_-]{21}$/;

function grokUrl(text: string): URL | null {
  const raw = String(text ?? "").trim();
  try {
    return new URL(/^(?:www\.)?x\.ai\//i.test(raw) ? `https://${raw}` : raw);
  } catch {
    return null;
  }
}

/** The share id from https://x.ai/bot/<id> (www, a trailing slash or a query allowed). */
export function grokShareIdFrom(text: string): string | null {
  const url = grokUrl(text);
  if (!url || url.username || url.password || url.port) return null;
  if (url.protocol !== "https:" || (url.hostname !== "x.ai" && url.hostname !== "www.x.ai")) return null;
  const match = url.pathname.match(/^\/bot\/([^/]+)\/?$/);
  return match && SHARE_ID.test(match[1]!) ? match[1]! : null;
}

export const grokShareUrl = (shareId: string) => `https://x.ai/bot/${shareId}`;

/** Anything that reads as an x.ai address, valid share link or not. */
export function looksLikeGrokLink(text: string): boolean {
  const raw = String(text ?? "").trim();
  if (!raw || /\s/.test(raw) || raw.length > 2_000) return false;
  const url = grokUrl(raw);
  return Boolean(url && /(^|\.)x\.ai$/i.test(url.hostname));
}

export const GROK_EXPORT_PROMPT = `Please export your setup so I can bring you into Murage.

Reply with ONE JSON code block and nothing else, in exactly this shape:

\`\`\`json
{
  "format": "${GROK_EXPORT_FORMAT}",
  "name": "<your name>",
  "description": "<one or two sentences on what you do>",
  "instructions": "<your full standing instructions, word for word>",
  "skills": [{ "name": "<skill-name>", "description": "<when to use it>", "body": "<the whole skill, word for word>" }],
  "routines": [{ "name": "<name>", "schedule": "<when it runs, in plain words>", "cron": "<minute hour day-of-month month weekday>", "prompt": "<what it does, word for word>" }],
  "apps": ["<each app you use, such as Gmail, Slack or GitHub>"],
  "memories": []
}
\`\`\`

Rules:
- Copy your instructions, skills and routine prompts exactly. Do not summarise or shorten them.
- Give every timed routine a five-field cron. For a routine that starts on an event (a Slack message, a GitHub event, an email), leave "cron" empty and describe the event in "schedule".
- Fill "memories" with short facts you remember about me only if I say yes below. Otherwise leave it [].
- Never include API keys, tokens, passwords, email addresses, phone numbers or customer data. Write [removed] in their place.
- Use [] for anything you do not have.

Include memories: no`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const first = (...values: unknown[]) => values.map(str).find(Boolean) ?? "";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** One line of plain text: control and separator characters become spaces. */
export function oneLine(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const NOT_AN_EXPORT = "That is not a Grok Bot export, so copy the whole code block your Grok Bot wrote and paste it here.";

/** The JSON object in a pasted reply: inside a ```json fence, or the outermost braces. */
function replyObject(text: string): unknown {
  const candidates = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g)].map((match) => match[1]!);
  const open = text.indexOf("{"), close = text.lastIndexOf("}");
  if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate.trim());
      if (isRecord(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  throw new GrokImportError(NOT_AN_EXPORT);
}

/** Refuses a paste over GROK_PASTE_MAX_BYTES with one plain sentence. */
export function assertGrokPasteSize(text: string): void {
  if (text.length > GROK_PASTE_MAX_BYTES || utf8Bytes(text) > GROK_PASTE_MAX_BYTES) {
    throw new GrokImportError("That paste is larger than a Grok Bot export can be, so paste only the code block your Grok Bot wrote.", 413);
  }
}

/** Forgiving reader for murage.grok/1, openmaus.grok/1 and grokbot-bundle/v1: text (fenced or not) or an object. */
export function parseGrokExport(input: unknown): GrokExport {
  if (typeof input === "string") assertGrokPasteSize(input);
  const root = typeof input === "string" ? replyObject(input.replace(/^﻿/, "")) : input;
  if (!isRecord(root)) throw new GrokImportError(NOT_AN_EXPORT);
  const format = root.format;
  const bundle = format === GROK_BUNDLE_FORMAT;
  if (format !== undefined && !FORMATS.has(format)) throw new GrokImportError(NOT_AN_EXPORT);
  const persona = isRecord(root.persona) ? root.persona : {};
  const source = isRecord(root.source) ? root.source : {};
  const instructions = first(root.instructions, root.soul, root.systemPrompt, persona.instructions, persona.description);
  const name = oneLine(first(root.name, persona.name, root.botName));
  if (!instructions) {
    throw new GrokImportError("That Grok Bot export has no instructions, so ask your Grok Bot to write the export again and paste the whole reply.");
  }
  // A bundle keeps its instructions in persona.description: describe the bot by their first paragraph.
  const description = first(root.description, persona.description === instructions ? "" : persona.description) ||
    (bundle ? instructions.split(/\n\s*\n/)[0]!.trim().slice(0, 300) : "");
  const title = oneLine(first(root.title, persona.title));
  const creator = oneLine(first(root.creator, root.author, source.sharerName));
  const color = first(root.color, persona.avatarColor, source.color);
  const shareId = grokShareIdFrom(first(typeof root.source === "string" ? root.source : "", source.url, root.url, root.sourceUrl));
  const skills = list(root.skills).flatMap((skill) => {
    if (!isRecord(skill)) return [];
    return [{ name: first(skill.name, skill.title), description: first(skill.description, skill.summary), body: first(skill.body, skill.instructions, skill.content, skill.text) }];
  });
  const routines = list(root.routines).flatMap((routine) => {
    if (!isRecord(routine)) return [];
    return [{
      name: first(routine.name, routine.title),
      schedule: first(routine.schedule, routine.when, routine.trigger, routine.triggerSummary),
      cron: first(routine.cron, routine.cronExpression),
      prompt: first(routine.prompt, routine.instructions, routine.task),
    }];
  });
  const apps = list(root.apps ?? root.plugins ?? root.integrations).flatMap((app) => {
    const label = typeof app === "string" ? app.trim() : isRecord(app) ? first(app.name, app.label, app.id, app.slug) : "";
    return label ? [oneLine(label)] : [];
  });
  const memories = list(root.memories).map((memory) => (isRecord(memory) ? first(memory.text, memory.content) : str(memory))).filter(Boolean);
  return {
    name: name || "Grok Bot",
    ...(title ? { title } : {}),
    description,
    instructions,
    ...(creator ? { creator } : {}),
    ...(shareId ? { sourceUrl: grokShareUrl(shareId) } : {}),
    ...(color ? { color } : {}),
    skills,
    routines,
    apps,
    memories,
  };
}
