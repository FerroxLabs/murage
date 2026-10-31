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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";

import { joinReal, realDir, realPathInOrder } from "../shared/in-project.ts";
import { canonPath, nativePath, normalizeRecipient, stopLineKey, stopLineKeyCovers, type StopHit } from "./stop-line.ts";

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
  /** Gives (or renews) one allowance. True when it was not already held, so
   * the card's Undo takes back only an allowance this answer added. */
  grant(botId: string, threadId: string, key: string): boolean {
    const live = this.live(botId, threadId);
    const list = live.filter((item) => item.key !== key);
    const added = list.length === live.length;
    list.push({ key, at: this.now() });
    this.byTask.set(`${botId}:${threadId}`, list.slice(-MAX_ALLOWANCES_PER_TASK));
    return added;
  }
  /** The allowance that covers this hit, if the owner gave one for this task. */
  covering(botId: string, threadId: string, hit: StopHit): string | undefined {
    return this.live(botId, threadId).find((item) => stopLineKeyCovers(item.key, hit))?.key;
  }
  /** Every live allowance for this task, so a connector batch's findings are
   * each covered on their own (AMEND-13 Rule 79b). */
  keys(botId: string, threadId: string): string[] {
    return this.live(botId, threadId).map((item) => item.key);
  }
  /** A reset or deleted conversation is a new task. */
  clearThread(threadId: string): void {
    for (const id of [...this.byTask.keys()]) if (id.endsWith(`:${threadId}`)) this.byTask.delete(id);
  }
  /** UX-TRUST-MOMENTS-1012 2.3.8: take back one allowance (Undo of a task
   * row). True when it was held; every other allowance stays. */
  revoke(botId: string, threadId: string, key: string): boolean {
    const list = this.live(botId, threadId);
    const kept = list.filter((item) => item.key !== key);
    if (kept.length === list.length) return false;
    if (kept.length) this.byTask.set(`${botId}:${threadId}`, kept);
    else this.byTask.delete(`${botId}:${threadId}`);
    return true;
  }
  /** Every live allowance this bot holds, across its open conversations
   * (2.3.12, the Settings line). */
  countForBot(botId: string): number {
    let count = 0;
    for (const id of [...this.byTask.keys()]) {
      if (!id.startsWith(`${botId}:`)) continue;
      count += this.live(botId, id.slice(botId.length + 1)).length;
    }
    return count;
  }
  /** Settings "Clear": every allowance of this bot, in every conversation.
   * Returns how many it cleared. */
  clearBot(botId: string): number {
    const count = this.countForBot(botId);
    for (const id of [...this.byTask.keys()]) if (id.startsWith(`${botId}:`)) this.byTask.delete(id);
    return count;
  }
}

/** 2.3.7: the recipients an allowed message makes known. A public post is
 * never learned (Sean, 2026-10-30): only "Always, for posts on {where}"
 * stands for it, which Settings lists and Take back removes. */
export function recipientsToRemember(hit: StopHit | undefined): string[] {
  if (hit?.kind !== "message" || !hit.recipients?.length) return [];
  if (hit.place?.startsWith("public:")) return [];
  return hit.recipients.filter((recipient) => !isPublicDestination(recipient));
}

/** A destination the stop line names for a public post (`github:<owner/repo>`),
 * never a person. */
export function isPublicDestination(recipient: string): boolean {
  return /^github:[^/\s]+\/[^/\s]+$/i.test(recipient);
}

/** F16: remember the recipients of an allowed send, best effort. Returns the
 * ones that could not be noted (the write threw), so the caller can say so in
 * the transcript; the next send to them asks again. */
export function rememberStopRecipientsFor(dataDir: string, botId: string, hit: StopHit | undefined, write: typeof rememberRecipients = rememberRecipients): string[] {
  const fresh = recipientsToRemember(hit);
  if (!fresh.length) return [];
  try {
    write(dataDir, botId, fresh);
    return [];
  } catch (error) {
    console.warn(`[stop-line] could not record recipients: ${error instanceof Error ? error.message : String(error)}`);
    return fresh;
  }
}

/** F16, the transcript line (the English of `ux.l1.why.recipientNotNoted`,
 * src/locales/en-ux/l1.json; a test keeps the two the same). */
export function recipientsNotNotedLine(names: readonly string[]): string {
  const name = names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Murage could not note ${name} as known, so the next email to ${name} asks again.`;
}

const BOT_ID = /^[\w-]{1,128}$/;

/** Murage's own record folder under its data dir (a fixed name, never a
 * path a tool call named). */
const recipientsDir = (dataDir: string) => [dataDir, "stop-line", "recipients"].join(sep);

function recipientsFile(dataDir: string, botId: string): string | undefined {
  return BOT_ID.test(botId) ? [recipientsDir(dataDir), `${botId}.json`].join(sep) : undefined;
}

/** Bots whose dropped public destinations were already counted in the log. */
const publicDropLogged = new Set<string>();

/** Everyone this bot has already sent a message to. A missing or unreadable
 * record is an empty one: the next message then asks, which is the side
 * this is allowed to fail on. */
export function knownRecipients(dataDir: string, botId: string): Set<string> {
  const file = recipientsFile(dataDir, botId);
  if (!file || !existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { recipients?: unknown };
    const listed = Array.isArray(parsed.recipients) ? parsed.recipients.filter((item): item is string => typeof item === "string") : [];
    // 2.3.7 migration: a public destination an older build learned is not a
    // person; dropped here (the next write leaves it out), counted once per bot
    const people = listed.filter((item) => !isPublicDestination(item));
    if (people.length !== listed.length && !publicDropLogged.has(botId)) {
      publicDropLogged.add(botId);
      console.warn(`[stop-line] dropped ${listed.length - people.length} public destinations from a bot's known recipients`);
    }
    return new Set(people);
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
  mkdirSync(recipientsDir(dataDir), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ recipients: next }), { mode: 0o600 });
  renameSync(temp, file);
}

export interface ChatAllowanceRequest {
  kind: "delete" | "message" | "pay";
  place: string;
  app?: string;
}

/** Whether `said` names `path` as a whole path: not as the start of a folder
 * inside it ("/Users" in "/Users/ada/site") and not as the tail of another
 * path ("/tmp/x" in "/private/tmp/x"). A trailing slash, quote or sentence
 * punctuation still ends it. */
function namesWholePath(said: string, path: string): boolean {
  const form = path.replace(/[\\/]+$/, "");
  if (!form) return false;
  for (let at = said.indexOf(form); at >= 0; at = said.indexOf(form, at + 1)) {
    const before = at === 0 ? "" : said[at - 1];
    const after = said.slice(at + form.length);
    if (before && !/[\s"'`(<[]/.test(before)) continue;
    if (/^[\\/]?(?:$|[\s"'`,;:)!?\]>]|\.(?:$|[\s"'`)]))/.test(after)) return true;
  }
  return false;
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
  realpath: (path: string) => string | null = (path) => path,
): { ok: true; key: string; note: string } | { ok: false; error: string } {
  const said = ownerText.toLowerCase();
  const place = request.place.trim();
  if (!place) return { ok: false, error: "Say which folder, person or payee the owner named." };
  if (request.kind === "delete") {
    // The stop line's own form: POSIX, with a Windows folder as /C:/Users/…
    // (stop-line.ts canonPath), compared without regard to case there.
    const home_ = canonPath(home).replace(/\/+$/, "");
    const windows = /^\/(?:[A-Z]:|UNC)(?:\/|$)/.test(home_);
    const same = (path: string) => (windows ? path.toLowerCase() : path);
    // A backslash separates folders only on Windows; elsewhere it is part of a name.
    const fromHome = windows ? /^~[\\/]/.test(place) : place.startsWith("~/");
    const absolute = place === "~" || fromHome ? `${home_}${windows ? place.slice(1).replace(/\\/g, "/") : place.slice(1)}` : canonPath(place);
    if (!absolute.startsWith("/")) return { ok: false, error: "Give the folder as a full path or starting with ~/." };
    const clean = absolute.replace(/\/+$/, "").replace(/\/\.(?=\/|$)/g, "");
    if (clean.split("/").includes("..")) return { ok: false, error: "Give the folder without .. in it." };
    // A folder that holds the home (/Users, C:\Users) or a whole disk is as
    // broad as the home itself: its grant covers every other account.
    const broad = !clean || same(clean) === same(home_) || same(home_).startsWith(`${same(clean)}/`) || (windows && /^\/(?:[A-Za-z]:|UNC(?:\/[^/]+)?)$/i.test(clean));
    if (broad) return { ok: false, error: "Murage does not allow deleting across the whole home folder or disk. Ask the owner to name a folder." };
    const tilde = same(clean).startsWith(`${same(home_)}/`) ? `~${clean.slice(home_.length)}` : clean;
    if (![place, clean, tilde, nativePath(clean)].some((form) => namesWholePath(said, form.toLowerCase()))) {
      return { ok: false, error: "The owner's latest message does not name that folder. Ask the owner to say it in their own words." };
    }
    let real: string | null;
    try { real = realpath(nativePath(clean)); } catch { real = null; }
    if (real === null) return { ok: false, error: "Murage cannot place that folder on this computer. Ask the owner to name a folder that exists." };
    return { ok: true, key: `stop:delete:${canonPath(real)}`, note: `You allowed deleting anything in ${tilde} for the rest of this task.` };
  }
  const who = normalizeRecipient(place);
  const bare = who.replace(/^[@#]/, "");
  if (!bare || !said.includes(bare)) {
    return { ok: false, error: `The owner's latest message does not name ${place}. Ask the owner to say it in their own words.` };
  }
  if (request.kind === "message") {
    // through the one key builder: one recipient, never a combined place (A13-FIX-DESIGN C2)
    const key = stopLineKey({ kind: "message", place: who, what: "" });
    if (!key) return { ok: false, error: "Name one person at a time. Ask the owner to say each one in their own words." };
    return { ok: true, key, note: `You allowed messaging ${place} for the rest of this task.` };
  }
  const app = request.app?.trim().toLowerCase();
  if (!app || !/^[a-z0-9_-]{1,60}$/.test(app)) return { ok: false, error: "Say which payment app, such as stripe." };
  return { ok: true, key: `stop:pay:${app}:${who}`, note: `You allowed payments to ${place} through ${app} for the rest of this task.` };
}

/** Every spelling a channel id is addressed by in a tool call: bare, and as a
 * mention (`U123`, `@U123`, `<@U123>` all name the same person). */
export function recipientForms(ids: readonly string[]): string[] {
  return ids.flatMap((id) => {
    const bare = normalizeRecipient(id).replace(/^[@#]/, "");
    return bare ? [bare, `@${bare}`] : [];
  });
}

/** The GitHub `owner/repo` of a git config's origin remote, from its text. */
export function githubRepoFromGitConfig(config: string): string | undefined {
  const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? "";
  const url = /^\s*url\s*=\s*(\S+)/m.exec(section)?.[1];
  const m = url && /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The GitHub repository a folder belongs to, read from its git config
 * without running git: walk up to `.git`, follow a worktree's `gitdir:` and
 * `commondir`. Every path is placed in order (shared/in-project.ts), so a
 * `gitdir: link/../g` is read where the link leads. Undefined for anything
 * unusual or anything that cannot be placed; the post then stops with no
 * repository-scoped grant. */
export function githubRepoOf(dir: string): string | undefined {
  let current = realDir(dir);
  if (!current) return undefined;
  for (let i = 0; i < 40; i += 1) {
    const dotGit = joinReal(current, ".git");
    if ("cannot" in dotGit) return undefined;
    let found = true;
    try {
      statSync(dotGit.path);
    } catch {
      found = false;
    }
    if (found) {
      try {
        let gitDir = realDir(dotGit.path);
        if (!statSync(dotGit.path).isDirectory()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit.path, "utf8"))?.[1]?.trim();
          if (!pointer) return undefined;
          const placed = realPathInOrder(pointer, current);
          if ("cannot" in placed) return undefined;
          gitDir = placed.real;
          const common = joinReal(placed.real, "commondir");
          if ("cannot" in common) return undefined;
          if (existsSync(common.path)) {
            const shared = realPathInOrder(readFileSync(common.path, "utf8").trim(), placed.real);
            if ("cannot" in shared) return undefined;
            gitDir = shared.real;
          }
        }
        if (!gitDir) return undefined;
        const config = joinReal(gitDir, "config");
        return "cannot" in config ? undefined : githubRepoFromGitConfig(readFileSync(config.path, "utf8"));
      } catch {
        return undefined;
      }
    }
    const parent = realDir(dirname(current));
    if (!parent || parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** The stop line's resolver (server/stop-line.ts `StopLinePlace.realpath`):
 * the real path, every part resolved in order and a missing tail kept as
 * written, or null when it cannot be placed. Never a path as written. */
export function stopLineRealpath(path: string): string | null {
  const placed = realPathInOrder(path, "/");
  return "cannot" in placed ? null : placed.real;
}

/** The stop line's roots, each by its real path. A root that does not
 * resolve is dropped, so it never widens what counts as inside. */
export function stopLineRoots(roots: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (typeof root !== "string" || !root) continue;
    const real = realDir(root);
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
}
