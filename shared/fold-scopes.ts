// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 1.2: which standing scopes an approval card offers.
// The server classifies every held permission card once, when it opens
// (`CardClass`, written beside `held`), and this one pure function turns the
// class and the keys the server put on the card into the rows the fold shows.
// The card renders these rows; every save route calls the same function and
// refuses a scope it would not show, before anything is staged or delivered.
//
// No English here: each row carries structured facts (what kind of scope,
// which place, program, tool, action, server, bot or routine, which window,
// which surface may give it) and the client words them.
import type { AutoVerdictSource } from "../server/auto-approve.ts";
import type { RoutineGrantOffer } from "./approval-grant-request.ts";
import { durableGrantAllowed } from "./durable-grant-allowed.ts";
import { APP_ACTION_PREFIX } from "./app-action-words.ts";
import { parseAcpToolKey } from "./mount-identity.ts";
import { parseExactCommandKey } from "./exact-command.ts";
import { isCommandTool } from "./grant-tool-names.ts";

export type CardReason = AutoVerdictSource | "question";

/** The fields of a card that carry a standing key. */
export type CardKeyField = "allowKey" | "allowKeys" | "exactAllowKey" | "taskAllowKey" | "routineAllowKey" | "routineOffer";

/** 1.2: content free, built from facts the server has when the request opens. */
export interface CardClass {
  reason: CardReason;
  stop?: { kind: "delete" | "pay" | "message"; public: boolean; placed: boolean; places: number };
  /** the card was raised by a routine's run (server proven, as routineCardFields does) */
  routine?: { routineId: string };
  /** the turn was marked unattended (webhook, channel, unproven origin) */
  unattended: boolean;
  /** a routine's or an automation's turn: the task allowance reader ignores it */
  automated: boolean;
  scope?: "local-computer";
  /** which standing-key fields the server put on the card */
  keys: CardKeyField[];
}

/** The keys a card carries, as stored on it. */
export interface CardKeys {
  allowKey?: string;
  allowKeys?: string[];
  exactAllowKey?: string;
  taskAllowKey?: string;
  routineAllowKey?: string;
  routineId?: string;
  /** grantRequest.routine */
  routineOffer?: RoutineGrantOffer;
}

/** What a row covers, for the client to word. */
export type FoldTarget =
  /** a folder path: "in {folder}", covers its subfolders */
  | { kind: "delete-folder"; folder: string }
  /** `app:<app>`, `sql:<tool>` or `git:<repo>`: "on {place}" */
  | { kind: "delete-place"; where: "app" | "sql" | "git"; name: string }
  /** a delete Murage could not place: this exact command in this folder, any engine */
  | { kind: "delete-command"; folder: string; command: string }
  /** a public post, `github:<owner/repo>` or an app */
  | { kind: "public"; where: string }
  /** a payment: `<app>:<payee>` */
  | { kind: "pay"; payee: string }
  /** this exact command here, on this engine, in this folder */
  | { kind: "exact-command"; command: string; folder: string; engine: string }
  /** any {program} command */
  | { kind: "program"; program: string; tool: string }
  /** a native tool by its own name (Read, Write, Edit, Glob) */
  | { kind: "native-tool"; tool: string }
  /** one connected-app action (`app-action:<SLUG>`), worded by actionGrantWords */
  | { kind: "app-action"; key: string }
  /** several actions remembered as their whole set */
  | { kind: "action-set"; keys: string[] }
  /** a tool on a mounted server */
  | { kind: "mount-tool"; mountId: string; tool: string }
  /** asking another bot */
  | { kind: "ask-bot"; bot: string }
  /** "Always, when {routine} runs" */
  | { kind: "routine"; routineId: string; routineName?: string };

export interface FoldScope {
  /** a stable row id */
  id: "task" | "always" | "always-exact" | "always-set" | "routine";
  /** where the grant is kept */
  scope: "task" | "bot" | "routine";
  /** "desktop": bot-level rows are given on the computer only (1.5); "any": desktop and the paired app */
  surface: "any" | "desktop";
  /** the keys choosing this row saves (for a routine row, what the offer saves) */
  keys: string[];
  target: FoldTarget;
  /** the task window, for a task row */
  window?: { hours: 12; where: "conversation" };
}

/** 1.2 table, the reason column. Every verdict source has an entry, so a new
 * source cannot reach a card without a decision here (test 1).
 *  - "none": the card never offers a standing scope (guards, the host
 *    block, a question, a source that holds no card)
 *  - "class": the stop finding or the no-grant row decides */
export const REASON_FOLD: Readonly<Record<CardReason, "none" | "class">> = {
  "always-ask": "none",
  narrow: "none",
  "always-allow": "none",
  "exact-command": "none",
  "auto-mode": "none",
  "full-access": "none",
  "no-limits": "none",
  "own-workspace": "none",
  "own-tool-results": "none",
  "project-work-roots": "none",
  "own-unasked": "none",
  "stop-line": "class",
  "task-allowance": "none",
  "routine-allow": "none",
  "unattended-block": "none",
  "local-computer-block": "none",
  "destructive-guard": "none",
  "sensitive-guard": "none",
  "unread-call": "none",
  "prompt-guard": "none",
  "question-tool": "none",
  "no-grant": "class",
  question: "none",
};

const TASK_WINDOW = { hours: 12, where: "conversation" } as const;
const PROGRAM_GRANT = /^(?:mcp__.+__)?(?:[\w-]+\.)?(bash|shell|execute|exec_command|run_command|computer_exec|terminal|powershell|pwsh):([^:\s]+)$/i;

/** What a stop key covers, or undefined when it is not one this table offers. */
function stopTarget(key: string): FoldTarget | undefined {
  if (key.startsWith("stop:public:")) return { kind: "public", where: key.slice("stop:public:".length) };
  const pay = /^stop:pay:(.+)$/.exec(key);
  if (pay) return { kind: "pay", payee: pay[1]! };
  const del = /^stop:delete:(.+)$/.exec(key);
  if (!del) return undefined;
  const place = del[1]!;
  if (place.startsWith("unplaced:")) {
    try {
      const parts: unknown = JSON.parse(place.slice("unplaced:".length));
      if (Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === "string")) return { kind: "delete-command", folder: parts[0] as string, command: parts[1] as string };
    } catch { /* not one of ours */ }
    return undefined;
  }
  const named = /^(app|sql|git):(.+)$/.exec(place);
  if (named) return { kind: "delete-place", where: named[1] as "app" | "sql" | "git", name: named[2]! };
  return place.startsWith("/") ? { kind: "delete-folder", folder: place } : undefined;
}

/** What a bot-level "always" key covers on a no-grant card. */
function grantTarget(key: string): FoldTarget | undefined {
  const exact = parseExactCommandKey(key);
  if (exact) return { kind: "exact-command", command: exact.command, folder: exact.cwd, engine: exact.engine };
  if (key.startsWith(APP_ACTION_PREFIX)) return { kind: "app-action", key };
  const mount = parseAcpToolKey(key);
  if (mount) return { kind: "mount-tool", mountId: mount.mountId, tool: mount.tool };
  if (key.startsWith("ask_bot:")) return { kind: "ask-bot", bot: key.slice("ask_bot:".length).replace(/^@/, "") };
  const program = PROGRAM_GRANT.exec(key);
  if (program) return { kind: "program", tool: key.slice(0, key.length - program[2]!.length - 1), program: program[2]! };
  // a host key, a stop key or a command tool's bare name is never a bot-level "always"
  if (key.startsWith("local-computer:") || key.startsWith("stop:") || key.startsWith("exact:") || isCommandTool(key)) return undefined;
  // any other key is the tool's own name as approvalKey wrote it (Read, an MCP tool)
  return { kind: "native-tool", tool: key };
}

const always = (id: FoldScope["id"], keys: string[], target: FoldTarget): FoldScope => ({ id, scope: "bot", surface: "desktop", keys, target });

/** The routine row, from the card's offer (or a legacy single routine key). */
function routineRow(keys: CardKeys, routineId: string | undefined): FoldScope[] {
  const offer = keys.routineOffer;
  if (offer) {
    if (!offer.eligible || (routineId !== undefined && offer.routineId !== routineId)) return [];
    const saved = [...offer.actionKeys, ...offer.stopKeys.map((stop) => stop.key)].filter(durableGrantAllowed);
    return saved.length ? [{ id: "routine", scope: "routine", surface: "any", keys: saved, target: { kind: "routine", routineId: offer.routineId, routineName: offer.routineName } }] : [];
  }
  const id = routineId ?? keys.routineId;
  if (!id || !keys.routineAllowKey || !durableGrantAllowed(keys.routineAllowKey)) return [];
  return [{ id: "routine", scope: "routine", surface: "any", keys: [keys.routineAllowKey], target: { kind: "routine", routineId: id } }];
}

/** The "always" rows a no-grant card's keys offer: the action set whole, the
 * exact command, then the program, tool, action, mount or bot key. */
function grantRows(keys: CardKeys): FoldScope[] {
  const rows: FoldScope[] = [];
  if (keys.allowKeys && keys.allowKeys.length > 1) {
    if (keys.allowKeys.every(durableGrantAllowed)) rows.push(always("always-set", [...keys.allowKeys], { kind: "action-set", keys: [...keys.allowKeys] }));
    return rows;
  }
  if (keys.exactAllowKey && durableGrantAllowed(keys.exactAllowKey)) {
    const target = grantTarget(keys.exactAllowKey);
    if (target?.kind === "exact-command") rows.push(always("always-exact", [keys.exactAllowKey], target));
  }
  if (keys.allowKey && durableGrantAllowed(keys.allowKey)) {
    const target = grantTarget(keys.allowKey);
    if (target && target.kind !== "exact-command") rows.push(always("always", [keys.allowKey], target));
  }
  return rows;
}

/** The stop rows: a task row (12 h, this conversation, this place) when the
 * task allowance reader would honor it, and an "always" row when the key may
 * be kept for good. A message to someone new offers nothing: sending is
 * what makes them known. */
function stopRows(cardClass: CardClass, keys: CardKeys): FoldScope[] {
  const stop = cardClass.stop!;
  if (!stop.placed) return [];
  if (stop.kind === "message" && !stop.public) return [];
  const rows: FoldScope[] = [];
  const has = (field: CardKeyField) => cardClass.keys.includes(field);
  const taskOk = !cardClass.unattended && !cardClass.automated && !cardClass.scope;
  if (taskOk && has("taskAllowKey") && keys.taskAllowKey) {
    const target = stopTarget(keys.taskAllowKey);
    if (target) rows.push({ id: "task", scope: "task", surface: "any", keys: [keys.taskAllowKey], target, window: TASK_WINDOW });
  }
  if (stop.kind !== "pay" && has("allowKey") && keys.allowKey && durableGrantAllowed(keys.allowKey)) {
    const target = stopTarget(keys.allowKey);
    if (target) rows.push(always("always", [keys.allowKey], target));
  }
  return rows;
}

/** A card from an older build (no class): the most restrictive class its keys
 * allow (F18). No task row; a routine row only when the card names its
 * routine, and then no bot row; bot rows only for keys the current policy keeps. */
function legacyRows(keys: CardKeys): FoldScope[] {
  if (keys.routineId || keys.routineOffer) return routineRow(keys, keys.routineId);
  if (keys.allowKey && keys.allowKey.startsWith("stop:")) {
    if (!durableGrantAllowed(keys.allowKey)) return [];
    const target = stopTarget(keys.allowKey);
    return target ? [always("always", [keys.allowKey], target)] : [];
  }
  return grantRows(keys);
}

/** 1.2: the rows the fold shows for this card, read top down. */
export function foldScopes(cardClass: CardClass | undefined, keys: CardKeys): FoldScope[] {
  if (!cardClass) return legacyRows(keys);
  // host consent, guards, questions, unattended turns: nothing
  if (cardClass.scope === "local-computer") return [];
  if (REASON_FOLD[cardClass.reason] !== "class") return [];
  if (cardClass.unattended) return [];
  // a routine's card: the routine's own row, never a bot-level scope
  if (cardClass.routine) return cardClass.keys.includes("routineOffer") || cardClass.keys.includes("routineAllowKey") ? routineRow(keys, cardClass.routine.routineId) : [];
  if (cardClass.stop) return stopRows(cardClass, keys);
  if (cardClass.reason !== "no-grant") return [];
  const listed: CardKeys = {
    ...(cardClass.keys.includes("allowKey") && keys.allowKey ? { allowKey: keys.allowKey } : {}),
    ...(cardClass.keys.includes("allowKeys") && keys.allowKeys ? { allowKeys: keys.allowKeys } : {}),
    ...(cardClass.keys.includes("exactAllowKey") && keys.exactAllowKey ? { exactAllowKey: keys.exactAllowKey } : {}),
  };
  return grantRows(listed);
}

/** Every key a bot-level save of this card may write: the union of its bot rows. */
export function botFoldKeys(cardClass: CardClass | undefined, keys: CardKeys): string[] {
  return [...new Set(foldScopes(cardClass, keys).filter((row) => row.scope === "bot").flatMap((row) => row.keys))];
}

/** Whether choosing these keys on the bot route is a row this card offers. */
export function botScopeOffered(cardClass: CardClass | undefined, keys: CardKeys, chosen: readonly string[]): boolean {
  const unique = [...new Set(chosen)];
  return foldScopes(cardClass, keys).some((row) => row.scope === "bot" && row.keys.length === unique.length && unique.every((key) => row.keys.includes(key)));
}

/** Whether the card's task row (if any) is this key. */
export function taskScopeOffered(cardClass: CardClass | undefined, keys: CardKeys, key: string): boolean {
  return foldScopes(cardClass, keys).some((row) => row.scope === "task" && row.keys[0] === key);
}
