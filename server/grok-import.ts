// Adapted from upstream OpenMausBot PR #3073, merge 1da83432c (Apache-2.0):
// server/team-library.ts (fetchGrokTemplateCard, the x.ai page reader) and
// shared/grok-import.ts (grokExportToPackage, grokStarterPackage, the schedule
// reader). Modifications Copyright 2026 Ferrox Labs, AGPL-3.0-or-later.
//
// One Import surface for a shared Grok Bot: a public x.ai/bot/<id> link or the
// export text the person's own Grok Bot writes. Either one becomes an ordinary
// murage.package (one bot, its instructions, its skills as playbooks, paused
// routines), so the usual preview, Skill Guard check and /api/teams/import
// rules apply and the bot works on every engine. Upstream's Cursor sign-in
// and private Cursor API half is deliberately not taken.
import { parseBotPackage, type ParsedBotPackage } from "./bot-package.ts";
import {
  GrokImportError, assertGrokPasteSize, grokShareIdFrom, grokShareUrl, looksLikeGrokLink, oneLine, parseGrokExport,
  type GrokExport, type GrokTemplateCard,
} from "../shared/grok-import.ts";

type Fetcher = typeof fetch;

const GROK_HOSTS = new Set(["x.ai", "www.x.ai"]);
export const MAX_GROK_PAGE_BYTES = 2 * 1024 * 1024;
export const GROK_TIMEOUT_MS = 20_000;
export const MAX_GROK_REDIRECTS = 3;
/** The route's body cap: room for a full-size paste once JSON escapes it, well under 1 MB. */
export const GROK_IMPORT_BODY_MAX_BYTES = 900_000;

const DESCRIPTION_MAX = 4_000;
const PLAYBOOK_MAX = 24_000;
const MAX_PLAYBOOKS = 80;
const MAX_ROUTINES = 50;
const MAX_APPS = 30;

function onGrokHost(url: URL): boolean {
  return url.protocol === "https:" && GROK_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new GrokImportError("That x.ai page is larger than a Grok Bot page can be, so paste the bot's export instead.", 502);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function metaContent(html: string, property: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`\\b(?:property|name)=["']${property}["']`, "i").test(tag)) continue;
    const content = tag.match(/\bcontent=(?:"([^"]*)"|'([^']*)')/i);
    if (content) return decodeEntities(content[1] ?? content[2] ?? "").trim();
  }
  return "";
}

const cardText = (value: string, max: number) =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);

/** Name, creator and description from a share page's og tags ("<name> by <creator>"). */
export function grokCardFromHtml(html: string, shareId: string): GrokTemplateCard {
  const title = metaContent(html, "og:title");
  const by = title.lastIndexOf(" by ");
  const name = oneLine(cardText(by > 0 ? title.slice(0, by) : title, 100));
  const creator = by > 0 ? oneLine(cardText(title.slice(by + 4), 100)) : "";
  const description = cardText(metaContent(html, "og:description"), 2_000);
  if (!name || (/^grok\s*bot$/i.test(name) && !description)) {
    throw new GrokImportError("That x.ai page did not show a Grok Bot, so the link may be private, team only or removed.", 404);
  }
  return { shareId, name, ...(creator ? { creator } : {}), description, url: grokShareUrl(shareId) };
}

/** An x.ai page's HTML: only https://x.ai (or www) and at most three redirects that stay there, within the time and size caps. */
async function fetchGrokPage(target: URL, fetcher: Fetcher, signal: AbortSignal): Promise<string> {
  const sharePath = target.pathname;
  for (let hop = 0; ; hop += 1) {
    if (!onGrokHost(target)) throw new GrokImportError("That Grok Bot link led away from x.ai, so Murage did not follow it.", 502);
    const response = await fetcher(target.toString(), { headers: { accept: "text/html" }, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop >= MAX_GROK_REDIRECTS) throw new GrokImportError("x.ai kept redirecting that link, so paste the bot's export instead.", 502);
      target = new URL(location, target);
      continue;
    }
    if (response.status === 404) throw new GrokImportError("That Grok Bot link was not found, so it may be private, team only or removed.", 404);
    if (!response.ok) throw new GrokImportError(`x.ai answered with error ${response.status}, so try again in a moment or paste the bot's export.`, 502);
    // a redirect that ends anywhere but the bot's own page (x.ai's homepage, say) carries some other page's card, never this bot's
    if (target.pathname.replace(/\/+$/, "") !== sharePath) {
      throw new GrokImportError("That Grok Bot link opened a different x.ai page, so paste the bot's export instead.", 404);
    }
    return readCapped(response, MAX_GROK_PAGE_BYTES);
  }
}

/** The public card for a Grok Bot share link. Fetches only x.ai pages. */
export async function fetchGrokTemplateCard(input: string, fetcher: Fetcher = fetch, timeoutMs = GROK_TIMEOUT_MS): Promise<GrokTemplateCard> {
  const shareId = grokShareIdFrom(input);
  if (!shareId) {
    throw new GrokImportError("Paste a Grok Bot share link that looks like https://x.ai/bot/ followed by its id, or paste the bot's export.");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return grokCardFromHtml(await fetchGrokPage(new URL(grokShareUrl(shareId)), fetcher, signal), shareId);
  } catch (error) {
    if (signal.aborted || (error as { name?: string }).name === "TimeoutError") {
      throw new GrokImportError(`x.ai did not answer within ${Math.round(timeoutMs / 1000)} seconds, so try again or paste the bot's export.`, 504);
    }
    if (error instanceof GrokImportError) throw error;
    throw new GrokImportError("Murage could not reach x.ai, so check your connection or paste the bot's export.", 502);
  }
}

// ---- export -> murage.package -------------------------------------------------

/** The bot colours (server/store.ts EmberColor). */
const PALETTE = {
  green: "#009957", blue: "#377FE6", red: "#D94B52", orange: "#E78531", purple: "#8057C8",
  cyan: "#0EA5C6", pink: "#D84F8B", yellow: "#D8A729", teal: "#01A492", coral: "#E5634E",
} as const;
type BotColor = keyof typeof PALETTE;

function rgb(hex: string): [number, number, number] | null {
  const match = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const digits = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join("") : match[1]!;
  return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as [number, number, number];
}

/** The nearest bot colour; greys and unreadable values get blue. */
export function nearestBotColor(hex: string | undefined): BotColor {
  const value = hex ? rgb(hex) : null;
  if (!value || Math.max(...value) - Math.min(...value) < 40) return "blue";
  let best: BotColor = "blue", distance = Infinity;
  for (const [name, swatch] of Object.entries(PALETTE) as Array<[BotColor, string]>) {
    const other = rgb(swatch)!;
    const next = value.reduce((sum, channel, index) => sum + (channel - other[index]!) ** 2, 0);
    if (next < distance) [best, distance] = [name, next];
  }
  return best;
}

const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);
const slug = (value: string, max: number) =>
  value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

function uniqueSlug(value: string, fallback: string, taken: Set<string>, max = 60): string {
  const base = slug(value, max - 4) || fallback;
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  taken.add(candidate);
  return candidate;
}

/** FNV-1a: a short stable suffix for the package id, not a security boundary. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/** Cut at the last paragraph or sentence end that fits. */
function fitChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf(". "));
  return (at > max * 0.6 ? head.slice(0, at + 1) : head).trimEnd();
}

type DailySchedule = { type: "daily"; time: string; weekdays: number[] };

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const EVENT_WORDS = /\b(?:when|whenever|each time|every time|on (?:new|each|every)|webhook|mention(?:ed|s)?|incoming|arrives?|opens?|merged?|pushed?)\b/i;

/** "Weekdays at 9am", "every day at 18:30", "Mondays and Thursdays at 10" as a daily schedule. */
function dailyFromWords(text: string): DailySchedule | null {
  const lower = text.toLowerCase();
  if (EVENT_WORDS.test(lower) || /\b(?:hour|hourly|minute|minutes|month|monthly|year)\b/.test(lower)) return null;
  let hour: number, minute = 0;
  const clock = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/) ?? lower.match(/\b(\d{1,2}):(\d{2})\b/) ?? lower.match(/\bat (\d{1,2})\b/);
  if (/\bnoon\b/.test(lower)) hour = 12;
  else if (/\bmidnight\b/.test(lower)) hour = 0;
  else if (clock) {
    hour = Number(clock[1]);
    minute = clock[2] ? Number(clock[2]) : 0;
    const half = clock[3]?.[0];
    if (half && (hour < 1 || hour > 12)) return null;
    if (half === "p" && hour < 12) hour += 12;
    if (half === "a" && hour === 12) hour = 0;
  } else return null;
  if (hour > 23 || minute > 59) return null;
  let weekdays: number[];
  if (/\bweekdays?\b|\bmon(?:day)?s?\s*(?:-|to|through)\s*fri(?:day)?\b|\bbusiness days?\b|\bworkdays?\b/.test(lower)) weekdays = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/.test(lower)) weekdays = [0, 6];
  else if (/\b(?:daily|every ?day|each day|every (?:morning|evening|night|afternoon))\b/.test(lower)) weekdays = [0, 1, 2, 3, 4, 5, 6];
  else weekdays = WEEKDAYS.flatMap((day, index) => (new RegExp(`\\b${day}(?:[a-z]*day)?s?\\b`).test(lower) ? [index] : []));
  if (!weekdays.length) return null;
  return { type: "daily", time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, weekdays };
}

/** A five-field cron with one fixed minute and hour, any day of month and month, and a weekday list or range. */
function dailyFromCron(expression: string): DailySchedule | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || dom !== "*" || month !== "*") return null;
  const m = Number(minute), h = Number(hour);
  if (m > 59 || h > 23) return null;
  const days = new Set<number>();
  if (dow === "*" || dow === "?") [0, 1, 2, 3, 4, 5, 6].forEach((day) => days.add(day));
  else {
    for (const part of dow.split(",")) {
      const range = part.toLowerCase().match(/^([0-7]|[a-z]{3})(?:-([0-7]|[a-z]{3}))?$/);
      if (!range) return null;
      const day = (token: string) => (/^\d$/.test(token) ? Number(token) % 7 : WEEKDAYS.indexOf(token));
      const from = day(range[1]!), to = range[2] === undefined ? from : day(range[2]);
      if (from < 0 || to < 0) return null;
      if (range[2] === "7") { for (let d = from; d <= 6; d += 1) days.add(d); days.add(0); continue; }
      if (to < from) return null;
      for (let d = from; d <= to; d += 1) days.add(d);
    }
  }
  return { type: "daily", time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, weekdays: [...days].sort() };
}

function routineSchedule(routine: GrokExport["routines"][number]): DailySchedule | string {
  const timed = (routine.cron && dailyFromCron(routine.cron)) || dailyFromCron(routine.schedule) || dailyFromWords(routine.schedule);
  if (timed) return timed;
  if (EVENT_WORDS.test(routine.schedule)) return "it starts on an event, not at a set time, so set it up again from the bot's Routines";
  return routine.schedule || routine.cron
    ? "its schedule is more than a daily time, so set it up again from the bot's Routines"
    : "the export gave no schedule for it";
}

export interface GrokImportResult {
  document: ParsedBotPackage;
  /** One plain sentence for each thing the bot could not bring with it. */
  notes: string[];
}

/** A Grok Bot export as one Murage bot package, plus what could not travel. */
export function grokExportToPackage(x: GrokExport, options: { sourceUrl?: string } = {}): GrokImportResult {
  const notes: string[] = [];
  const shareId = grokShareIdFrom(options.sourceUrl ?? "") ?? grokShareIdFrom(x.sourceUrl ?? "");
  const sourceUrl = shareId ? grokShareUrl(shareId) : undefined;
  const name = clip(oneLine(x.name) || "Grok Bot", 100);
  const agentKey = slug(name, 60) || "grok-bot";
  const summarySource = x.description.trim() || `${name}, brought over from Grok Bot.`;

  let instructions = x.instructions.trim();
  if (instructions.length > DESCRIPTION_MAX) {
    instructions = fitChars(instructions, DESCRIPTION_MAX);
    notes.push(`Its standing instructions were longer than ${DESCRIPTION_MAX.toLocaleString("en-US")} characters, so the end was cut; check them on the bot's profile after you add it.`);
  }

  const playbookKeys = new Set<string>();
  const playbooks = x.skills.flatMap((skill, index) => {
    const label = oneLine(skill.name) || `Skill ${index + 1}`;
    const body = skill.body.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    if (!body) { notes.push(`The skill "${label}" had no text in the export, so it was left out.`); return []; }
    if (playbookKeys.size >= MAX_PLAYBOOKS) { notes.push(`The skill "${label}" was left out because a bot holds at most ${MAX_PLAYBOOKS} playbooks.`); return []; }
    const key = uniqueSlug(label, `skill-${index + 1}`, playbookKeys);
    const trigger = clip(label.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(), 100);
    if (body.length > PLAYBOOK_MAX) notes.push(`The skill "${label}" was longer than ${PLAYBOOK_MAX.toLocaleString("en-US")} characters, so the end was cut.`);
    return [{
      key,
      name: clip(label, 100),
      summary: clip(oneLine(skill.description) || oneLine(body.split("\n").find((line) => line.trim()) ?? "").replace(/^#+\s*/, "") || label, 300),
      triggers: [trigger || key],
      instructions: fitChars(body, PLAYBOOK_MAX),
    }];
  });

  const routineKeys = new Set<string>();
  const routines = x.routines.flatMap((routine, index) => {
    const label = clip(oneLine(routine.name) || `Routine ${index + 1}`, 80);
    if (index >= MAX_ROUTINES) { notes.push(`The routine "${label}" was left out because a bot package holds at most ${MAX_ROUTINES} routines.`); return []; }
    if (!routine.prompt) { notes.push(`The routine "${label}" was left out because the export gave no prompt for it.`); return []; }
    const schedule = routineSchedule(routine);
    if (typeof schedule === "string") { notes.push(`The routine "${label}" was left out because ${schedule}.`); return []; }
    return [{
      key: uniqueSlug(label, `routine-${index + 1}`, routineKeys),
      name: label,
      agent: agentKey,
      prompt: routine.prompt.slice(0, 20_000),
      runOn: "ember" as const,
      schedule,
      durationMinutes: 30,
      enabledAfterInstall: false as const,
    }];
  });

  const appSlugs = new Set<string>();
  const apps = x.apps.flatMap((app) => {
    const label = clip(app, 100);
    const appSlug = slug(label, 60);
    if (!appSlug || appSlugs.has(appSlug)) return [];
    if (appSlugs.size >= MAX_APPS) { notes.push(`The app "${label}" was left out because a bot package lists at most ${MAX_APPS} apps.`); return []; }
    appSlugs.add(appSlug);
    return [{ slug: appSlug, label, reason: clip(`${name} used ${label} in Grok Bot.`, 240), optional: true }];
  });
  if (x.memories.length) notes.push("Memories from Grok Bot do not come across, so tell the bot anything it should remember in your first chat.");

  const draft = {
    format: "murage.package" as const,
    version: 1 as const,
    package: {
      id: `${slug(name, 60) || "grok-bot"}-${shortHash(shareId ?? `${name}\n${instructions}`)}`,
      release: "1.0.0",
      name,
      tagline: clip(oneLine(summarySource), 160),
      summary: clip(summarySource, 2_000),
      category: "Imported",
      author: { name: clip(x.creator || "Grok Bot creator", 100), ...(sourceUrl ? { url: sourceUrl } : {}) },
      license: "See source",
      outcomes: [clip(`${name} works in Murage on whichever engine you choose.`, 240)],
      setupMinutes: 5,
      requirements: { apps, capabilities: [] as string[] },
      agents: [{
        key: agentKey,
        name,
        ...(x.title ? { title: clip(oneLine(x.title), 200) } : {}),
        description: instructions,
        appearance: { color: nearestBotColor(x.color) },
        ...(playbooks.length ? { playbooks: playbooks.map((playbook) => playbook.key) } : {}),
      }],
      ...(routines.length ? { routines } : {}),
      ...(playbooks.length ? { playbooks } : {}),
    },
  };
  try {
    return { document: parseBotPackage(draft as unknown as ParsedBotPackage), notes };
  } catch {
    throw new GrokImportError("Murage could not turn that Grok Bot export into a bot, so ask your Grok Bot to write the export again.");
  }
}

/** A bot started from the public card alone: its name and description, credited to the share link. */
export function grokStarterPackage(card: GrokTemplateCard): GrokImportResult {
  const credit = `Based on x.ai/bot/${card.shareId}${card.creator ? ` by ${card.creator}` : ""}.`;
  const what = card.description.trim() || "The share page did not say what it does, so ask the person what they need.";
  const instructions = [
    `You are ${card.name}, a bot started from the Grok Bot "${card.name}"${card.creator ? ` by ${card.creator}` : ""} (x.ai/bot/${card.shareId}).`,
    `What you do: ${what}`,
    "Work in that spirit. Before acting, ask for anything you need to know about the person's accounts, projects or preferences, and keep answers short and practical.",
  ].join("\n\n");
  const result = grokExportToPackage({
    name: card.name,
    description: card.description.trim() ? `${card.description.trim()}\n\n${credit}` : credit,
    instructions,
    ...(card.creator ? { creator: card.creator } : {}),
    skills: [], routines: [], apps: [], memories: [],
  }, { sourceUrl: card.url });
  return {
    document: result.document,
    notes: ["The public page shows only the name and a short description, so for the bot's full instructions and skills paste its export here instead."],
  };
}

/** The one Import box: an x.ai share link fetches the public card; anything else is read as a pasted export. */
export async function grokImportFromInput(input: unknown, fetcher: Fetcher = fetch): Promise<GrokImportResult> {
  const text = typeof input === "string" ? input : "";
  if (!text.trim()) throw new GrokImportError("Paste a Grok Bot share link or the export your Grok Bot wrote.");
  assertGrokPasteSize(text);
  if (looksLikeGrokLink(text)) return grokStarterPackage(await fetchGrokTemplateCard(text, fetcher));
  return grokExportToPackage(parseGrokExport(text));
}
