// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the stop line (server/stop-line.ts) remembers between requests.
//
// Two small things, deliberately kept apart:
//
//   - Task allowances: the owner pressed "Allow for this task" on a stop card,
//     or said so in chat ("you can delete anything in ~/Projects/site today").
//     Held in memory only, per bot and conversation, and gone when Murage
//     restarts, when the conversation is reset or after TASK_ALLOWANCE_TTL_MS.
//     A task in Murage is a conversation with no end of its own, so the day is
//     the bound: an allowance given this morning does not quietly cover next
//     week.
//   - Recipients: everyone a bot has already sent a message to, so the next
//     message to them is a reply-in-kind rather than "someone new". Durable,
//     one small JSON file per bot under the data dir, on this desktop only.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeRecipient, stopLineKeyCovers, type StopHit } from "./stop-line.ts";

export const TASK_ALLOWANCE_TTL_MS = 12 * 60 * 60_000;
const MAX_ALLOWANCES_PER_TASK = 50;
const MAX_RECIPIENTS = 2_000;

interface Allowance {
  key: string;
  at: number;
}

export class TaskAllowances {
  private readonly byTask = new Map<string, Allowance[]>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  private live(botId: string, threadId: string): Allowance[] {
    const id = `${botId}:${threadId}`;
    const list = (this.byTask.get(id) ?? []).filter((item) => this.now() - item.at < TASK_ALLOWANCE_TTL_MS);
    if (list.length) this.byTask.set(id, list);
    else this.byTask.delete(id);
    return list;
  }
  grant(botId: string, threadId: string, key: string): void {
    const list = this.live(botId, threadId).filter((item) => item.key !== key);
    list.push({ key, at: this.now() });
    this.byTask.set(`${botId}:${threadId}`, list.slice(-MAX_ALLOWANCES_PER_TASK));
  }
  /** The allowance that covers this hit, if the owner gave one for this task. */
  covering(botId: string, threadId: string, hit: StopHit): string | undefined {
    return this.live(botId, threadId).find((item) => stopLineKeyCovers(item.key, hit))?.key;
  }
  /** A reset or deleted conversation is a new task. */
  clearThread(threadId: string): void {
    for (const id of [...this.byTask.keys()]) if (id.endsWith(`:${threadId}`)) this.byTask.delete(id);
  }
}

const BOT_ID = /^[\w-]{1,128}$/;

function recipientsFile(dataDir: string, botId: string): string | undefined {
  return BOT_ID.test(botId) ? join(dataDir, "stop-line", "recipients", `${botId}.json`) : undefined;
}

/** Everyone this bot has already sent a message to. A missing or unreadable
 * record is an empty one: the next message then asks, which is the side
 * this is allowed to fail on. */
export function knownRecipients(dataDir: string, botId: string): Set<string> {
  const file = recipientsFile(dataDir, botId);
  if (!file || !existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { recipients?: unknown };
    return new Set(Array.isArray(parsed.recipients) ? parsed.recipients.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remember recipients once a message to them was allowed. Newest last; the
 * oldest fall off past MAX_RECIPIENTS. */
export function rememberRecipients(dataDir: string, botId: string, recipients: readonly string[]): void {
  const file = recipientsFile(dataDir, botId);
  const fresh = recipients.map(normalizeRecipient).filter((item) => item && item.length <= 320);
  if (!file || !fresh.length) return;
  const known = [...knownRecipients(dataDir, botId)].filter((item) => !fresh.includes(item));
  const next = [...known, ...new Set(fresh)].slice(-MAX_RECIPIENTS);
  mkdirSync(join(dataDir, "stop-line", "recipients"), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ recipients: next }), { mode: 0o600 });
  renameSync(temp, file);
}

export interface ChatAllowanceRequest {
  kind: "delete" | "message" | "pay";
  place: string;
  app?: string;
}

/** Turn what the owner said in chat ("you can delete anything in
 * ~/Projects/site today") into a task allowance, or refuse it.
 *
 * The bot asks for it through a tool, which means the words reaching here
 * are the model's. So the place must appear in the OWNER's own latest
 * message, as written, as its ~ form or as its full path: a page, a file or
 * another bot telling the model "allow deleting ~" never put those words in
 * the owner's mouth. The caller has already refused any turn the owner is
 * not at. */
export function chatAllowance(
  request: ChatAllowanceRequest,
  ownerText: string,
  home: string,
  realpath: (path: string) => string = (path) => path,
): { ok: true; key: string; note: string } | { ok: false; error: string } {
  const said = ownerText.toLowerCase();
  const place = request.place.trim();
  if (!place) return { ok: false, error: "Say which folder, person or payee the owner named." };
  if (request.kind === "delete") {
    const home_ = home.replace(/\/+$/, "");
    const absolute = place === "~" || place.startsWith("~/") ? `${home_}${place.slice(1)}` : place;
    if (!absolute.startsWith("/")) return { ok: false, error: "Give the folder as a full path or starting with ~/." };
    const clean = absolute.replace(/\/+$/, "").replace(/\/\.(?=\/|$)/g, "");
    if (clean.split("/").includes("..")) return { ok: false, error: "Give the folder without .. in it." };
    if (!clean || clean === home_) return { ok: false, error: "Murage does not allow deleting across the whole home folder or disk. Ask the owner to name a folder." };
    const tilde = clean.startsWith(`${home_}/`) ? `~${clean.slice(home_.length)}` : clean;
    if (![place, clean, tilde].some((form) => said.includes(form.toLowerCase()))) {
      return { ok: false, error: "The owner's latest message does not name that folder. Ask the owner to say it in their own words." };
    }
    return { ok: true, key: `stop:delete:${realpath(clean)}`, note: `You allowed deleting anything in ${tilde} for the rest of this task.` };
  }
  const who = normalizeRecipient(place);
  const bare = who.replace(/^[@#]/, "");
  if (!bare || !said.includes(bare)) {
    return { ok: false, error: `The owner's latest message does not name ${place}. Ask the owner to say it in their own words.` };
  }
  if (request.kind === "message") {
    return { ok: true, key: `stop:message:${who}`, note: `You allowed messaging ${place} for the rest of this task.` };
  }
  const app = request.app?.trim().toLowerCase();
  if (!app || !/^[a-z0-9_-]{1,60}$/.test(app)) return { ok: false, error: "Say which payment app, such as stripe." };
  return { ok: true, key: `stop:pay:${app}:${who}`, note: `You allowed payments to ${place} through ${app} for the rest of this task.` };
}
