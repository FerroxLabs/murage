// SPDX-License-Identifier: AGPL-3.0-or-later
// Murage for Chrome activity log (spec section 5, tests F12). One line per
// browser action: when, site, action kind, target label, level, decision, who
// decided and outcome. Never a typed value, a field value or a secret: the
// record shape is a fixed allowlist, typed text is kept as a length only, and
// every string is cleaned and capped. Lives in the data folder under browser-extension/
// activity/<bindingId>.ndjson, inside the reserved browser-extension component
// that a backup never takes and a restore refuses.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { redactPageOutput } from "./browser-output-redaction.ts";

export const ACTIVITY_MAX_LINES = 2000;
export const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const ACTIVITY_MAX_LINE_BYTES = 512;
/** The file is compacted once it holds this many lines over the cap, so a busy task does not rewrite it on every action. */
const COMPACT_SLACK = 100;

export const ACTIVITY_DECISIONS = ["free", "allowed for this task", "you allowed", "you denied", "your turn", "not done", "Full permissive", "intent card"] as const;
export const ACTIVITY_DECIDERS = ["owner", "grant", "full-permissive", "policy", "checker"] as const;
export const ACTIVITY_OUTCOMES = ["done", "failed", "denied", "waiting", "handed over"] as const;

export type BrowserActivityDecision = typeof ACTIVITY_DECISIONS[number];
export type BrowserActivityDecider = typeof ACTIVITY_DECIDERS[number];
export type BrowserActivityOutcome = typeof ACTIVITY_OUTCOMES[number];

/** What a caller hands over. Extra keys are ignored, so a typed value passed by mistake is never written. */
export type BrowserActivityInput = {
  botId: string; bindingId: string; taskId: string;
  site: string; action: string; target?: string;
  /** True when the target label came from the page, not from Murage. */
  fromPage?: boolean;
  level: 1 | 2 | 3;
  decision: BrowserActivityDecision;
  decidedBy?: BrowserActivityDecider;
  outcome?: BrowserActivityOutcome;
  /** Length of text typed, never the text. */
  textLength?: number;
  routine?: boolean;
};
export type BrowserActivityLine = {
  at: number; botId: string; bindingId: string; taskId: string; site: string; action: string; target: string; fromPage: boolean;
  level: 1 | 2 | 3; decision: BrowserActivityDecision; decidedBy: BrowserActivityDecider; outcome: BrowserActivityOutcome;
  textLength?: number; routine?: true;
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
/** Control, bidi and zero-width characters out, whitespace collapsed, cut by code point. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
  return [...text].slice(0, max).join("");
}

function build(input: BrowserActivityInput, at: number): BrowserActivityLine | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (![input.botId, input.bindingId, input.taskId].every(v => typeof v === "string" && ID.test(v))) return undefined;
  if (input.level !== 1 && input.level !== 2 && input.level !== 3) return undefined;
  if (!oneOf(ACTIVITY_DECISIONS, input.decision)) return undefined;
  if (input.decidedBy !== undefined && !oneOf(ACTIVITY_DECIDERS, input.decidedBy)) return undefined;
  if (input.outcome !== undefined && !oneOf(ACTIVITY_OUTCOMES, input.outcome)) return undefined;
  // Page-derived strings (the site, the target label) pass the shared page-output redaction before they are cleaned and capped.
  const action = clean(input.action, 40), site = clean(redactPageOutput(typeof input.site === "string" ? input.site : ""), 80);
  if (!action) return undefined;
  const line: BrowserActivityLine = {
    at, botId: input.botId, bindingId: input.bindingId, taskId: input.taskId, site, action,
    target: clean(redactPageOutput(typeof input.target === "string" ? input.target : ""), 80), fromPage: input.fromPage === true,
    level: input.level, decision: input.decision, decidedBy: input.decidedBy ?? "policy", outcome: input.outcome ?? "done",
  };
  if (Number.isSafeInteger(input.textLength) && input.textLength! >= 0) line.textLength = Math.min(input.textLength!, 1_000_000);
  if (input.routine === true) line.routine = true;
  // Fit the line budget (the newline counts): shorten the free-text fields, never the ids.
  const size = () => Buffer.byteLength(JSON.stringify(line)) + 1;
  while (size() > ACTIVITY_MAX_LINE_BYTES && line.target.length > 0) line.target = [...line.target].slice(0, Math.max(0, [...line.target].length - 8)).join("");
  while (size() > ACTIVITY_MAX_LINE_BYTES && line.site.length > 0) line.site = [...line.site].slice(0, Math.max(0, [...line.site].length - 8)).join("");
  return size() <= ACTIVITY_MAX_LINE_BYTES ? line : undefined;
}

function parse(raw: string, cutoff: number): BrowserActivityLine | undefined {
  try {
    const value = JSON.parse(raw) as BrowserActivityLine;
    if (!value || typeof value !== "object" || !Number.isFinite(value.at) || value.at < cutoff) return undefined;
    if (![value.botId, value.bindingId, value.taskId].every(v => typeof v === "string" && ID.test(v))) return undefined;
    return value;
  } catch { return undefined; }
}

export class BrowserActivityStore {
  private readonly dir: string;
  private readonly now: () => number;
  /** Lines in each file, read once then counted as they are written. */
  private counts = new Map<string, number>();
  constructor(dir: string, now: () => number = Date.now) { this.dir = dir; this.now = now; }

  private file(bindingId: string) { return join(this.dir, `${bindingId}.ndjson`); }
  private read(bindingId: string): BrowserActivityLine[] {
    const path = this.file(bindingId);
    if (!existsSync(path)) return [];
    const cutoff = this.now() - ACTIVITY_MAX_AGE_MS;
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map(raw => parse(raw, cutoff)).filter((line): line is BrowserActivityLine => !!line && line.bindingId === bindingId);
  }
  private rewrite(bindingId: string, lines: BrowserActivityLine[]) {
    const kept = lines.slice(-ACTIVITY_MAX_LINES);
    if (!kept.length) { rmSync(this.file(bindingId), { force: true }); this.counts.delete(bindingId); return; }
    writeFileAtomic(this.file(bindingId), kept.map(line => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600 });
    this.counts.set(bindingId, kept.length);
  }

  /** Best effort: a log failure must never stop or fail a browser action. */
  record(input: BrowserActivityInput): boolean {
    try {
      const line = build(input, this.now());
      if (!line) return false;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.file(line.bindingId), JSON.stringify(line) + "\n", { mode: 0o600 });
      const count = (this.counts.get(line.bindingId) ?? this.read(line.bindingId).length - 1) + 1;
      this.counts.set(line.bindingId, count);
      if (count > ACTIVITY_MAX_LINES + COMPACT_SLACK) this.rewrite(line.bindingId, this.read(line.bindingId));
      return true;
    } catch { return false; }
  }

  /** Oldest first. Always scoped to one bot, so a binding id of another bot's shows nothing. */
  list(query: { botId: string; bindingId?: string; taskId?: string }): BrowserActivityLine[] {
    try {
      if (!ID.test(query.botId)) return [];
      if (query.bindingId !== undefined && !ID.test(query.bindingId)) return [];
      if (query.taskId !== undefined && !ID.test(query.taskId)) return [];
      const ids = query.bindingId ? [query.bindingId] : this.bindingIds();
      const out: BrowserActivityLine[] = [];
      for (const id of ids) for (const line of this.read(id)) if (line.botId === query.botId && (!query.taskId || line.taskId === query.taskId)) out.push(line);
      out.sort((a, b) => a.at - b.at);
      return out.slice(-ACTIVITY_MAX_LINES);
    } catch { return []; }
  }

  /** Called when a binding is removed: its log goes with it. */
  deleteBinding(bindingId: string): void {
    if (!ID.test(bindingId)) return;
    try { rmSync(this.file(bindingId), { force: true }); } catch { /* nothing to delete */ }
    this.counts.delete(bindingId);
  }

  /** Drops lines past 30 days and files that are left empty. Safe to run at start and on a timer. */
  prune(): void {
    try {
      for (const id of this.bindingIds()) { const path = this.file(id); if (statSync(path).isFile()) this.rewrite(id, this.read(id)); }
    } catch { /* best effort */ }
  }

  private bindingIds(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter(name => name.endsWith(".ndjson")).map(name => name.slice(0, -7)).filter(id => ID.test(id));
  }
}

let active: BrowserActivityStore | undefined;
/** index.ts sets the store once it knows the data folder; tests pass undefined to reset. */
export function configureBrowserActivity(store: BrowserActivityStore | undefined): void { active = store; }
export function browserActivityStore(): BrowserActivityStore | undefined { return active; }
/** The call later tasks make once per action. Returns false, and writes nothing, when the log is off or the entry is refused. */
export function recordBrowserActivity(input: BrowserActivityInput): boolean { return active ? active.record(input) : false; }
