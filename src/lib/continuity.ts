// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Continuity (PIP P1): what an owner writes for one bot, carried into every
// conversation on any engine. Pure helpers for the settings block, kept free
// of the store so they run under node. The server owns every rule; these only
// shape requests and put its refusals into plain sentences.

export type ContinuityKind = "continuity-brief" | "relation" | "commitment" | "self-trait";

export interface ContinuityRecord {
  id: string;
  version: number;
  kind: ContinuityKind | string;
  key: string;
  text: string;
  editedAt?: number | string | null;
  /** "observed": confirmed from the owner's own words. Absent means the owner wrote it. */
  tier?: "observed" | string;
  generation?: number;
  disputed?: boolean;
}

export interface ContinuityLimits { perKind: number; bytes: number; briefBytes: number }
export interface ContinuityCoverage { brought: number; total: number; at?: number | string | null }
export interface ContinuityView { records: ContinuityRecord[]; limits: ContinuityLimits; coverage: ContinuityCoverage | null }

export const DEFAULT_CONTINUITY_LIMITS: ContinuityLimits = { perKind: 24, bytes: 4096, briefBytes: 768 };
export const RELATION_KEY = "owner";
export const BRIEF_KEY = "core";
export const SLUG_PATTERN = /^[a-z0-9-]{1,48}$/;

export const CONTINUITY_HEADLINE = "Keep a continuous self";
export const CONTINUITY_SENTENCE = "This bot carries what you write here into every conversation, on any engine. Only you can change it.";
export const CONTINUITY_NEEDS_MEMORY = "Continuity needs memory turned on";

export const continuityBytes = (text: string): number => new TextEncoder().encode(text).length;

export function continuityReadBody(botId: string) { return { action: "continuity-read", botId }; }

export function continuityWriteBody(input: { botId: string; kind: ContinuityKind; key: string; expectedVersion: number; expectedId?: string; text: string }) {
  return { action: "identity-write", botId: input.botId, kind: input.kind, key: input.key, expectedVersion: input.expectedVersion, ...(input.expectedId ? { expectedId: input.expectedId } : {}), text: input.text, basis: "owner-fact", audience: "owner-private" };
}

export function continuityDeleteBody(input: { botId: string; kind: ContinuityKind; key: string; expectedVersion: number; expectedId?: string }) {
  return { action: "identity-delete", botId: input.botId, kind: input.kind, key: input.key, expectedVersion: input.expectedVersion, ...(input.expectedId ? { expectedId: input.expectedId } : {}) };
}

/** Body for the toggle: exactly `true` to turn on, `false` to turn off. */
export const continuityPatchBody = (on: boolean) => ({ continuity: on === true });

/** A key from the first words of what was written, so the owner never meets a slug. */
export function slugFromText(text: string): string {
  const words = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6);
  const slug = words.join("-").slice(0, 48).replace(/-+$/, "");
  return slug || "note";
}

/** A fresh key that is not in `taken` (active keys plus any known retired ones). */
export function freshKey(text: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugFromText(text);
  if (!used.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 48 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 40).replace(/-+$/, "")}-${Date.now().toString(36)}`.slice(0, 48);
}

/** Server refusals, said the way a person would. */
export const CONTINUITY_ERRORS: Record<string, string> = {
  MEMORY_IDENTITY_PIP_CAP: "This list is full. Remove one before adding another.",
  MEMORY_IDENTITY_PIP_KEY_INVALID: "That name could not be used. Try different words.",
  MEMORY_IDENTITY_PIP_BASIS_INVALID: "Only you can write this, from this screen.",
  MEMORY_VERSION_CONFLICT: "This changed in another window. Here is the latest.",
  MEMORY_IDENTITY_PIP_USE_CONTINUITY: "This is managed in Continuity. Change it in the bot's Memory settings.",
  MEMORY_NOT_FOUND: "That entry is already gone.",
  MEMORY_RECORD_UNAVAILABLE: "That name was used before; pick another.",
  INVALID_MEMORY_ARGUMENTS: "That could not be saved. Check the text and try again.",
};

export const PIP_ERRORS: Record<string, string> = {
  stale: "This changed in another window. Here is the latest.",
  invalid: "That suggestion could not be used.",
  cap: "This list is full. Remove one before adding another.",
  "not-found": "That suggestion is already gone.",
  retired: "That suggestion was removed before.",
};
export const pipRefusalSentence = (reason: string | undefined, fallback = "That did not save. Try again."): string =>
  (reason && PIP_ERRORS[reason]) || fallback;

export function continuityErrorCode(cause: unknown): string | null {
  const known = Object.keys(CONTINUITY_ERRORS);
  const body = (cause as { body?: { code?: unknown; error?: unknown } } | null | undefined)?.body;
  const candidates = [body?.code, body?.error, cause instanceof Error ? cause.message : undefined];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const hit = known.find((code) => candidate.includes(code));
    if (hit) return hit;
  }
  return null;
}

export function continuityErrorSentence(cause: unknown, fallback = "That did not save. Try again."): string {
  const code = continuityErrorCode(cause);
  return code ? CONTINUITY_ERRORS[code] : fallback;
}

/** "Brought 5 of 9 into the last conversation"; nothing when there is no count yet. */
export function coverageLine(coverage: ContinuityCoverage | null | undefined): string | null {
  if (!coverage || !Number.isFinite(coverage.brought) || !Number.isFinite(coverage.total)) return null;
  return `Brought ${coverage.brought} of ${coverage.total} into the last conversation`;
}

/** "You wrote this" plus when it was last edited. */
export function wroteLine(editedAt: number | string | null | undefined, now: number): string {
  const at = typeof editedAt === "string" ? Date.parse(editedAt) : editedAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return "You wrote this";
  const diff = Math.max(0, now - at);
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  const when = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : hours < 24 ? `${hours} hr ago` : days === 1 ? "yesterday" : `${days} days ago`;
  return `You wrote this, edited ${when}`;
}

export function byteCounter(text: string, limit: number): string { return `${continuityBytes(text)} of ${limit} bytes`; }

export const recordsOfKind = (records: ContinuityRecord[], kind: ContinuityKind) => records.filter((record) => record.kind === kind);

/** Rows written in Continuity: the generic memory screen leaves them alone. */
export const MANAGED_IN_CONTINUITY_KINDS: readonly string[] = ["commitment", "self-trait", "relation"];
export const managedInContinuity = (kind: string): boolean => MANAGED_IN_CONTINUITY_KINDS.includes(kind);

/** A draft remembers the version AND the record id it was started from (a re-created relation is a new id that
 * restarts at version 1); it is stale when either moved on. A draft on a new row has no id. */
export interface ContinuityDraft { text: string; base: number; baseId?: string }
export const CONTINUITY_CHANGED_SENTENCE = "This changed in another window.";
export const recordVersion = (record: { version: number } | null | undefined): number => record?.version ?? 0;
export const draftIsStale = (draft: ContinuityDraft | null, record: { version: number; id?: string } | null | undefined): boolean =>
  draft !== null && (draft.base !== recordVersion(record) || draft.baseId !== record?.id);
/** Owner chose to keep editing: same words, now based on the current version and record. */
export const rebaseDraft = (draft: ContinuityDraft, record: { version: number; id?: string } | null | undefined): ContinuityDraft =>
  ({ text: draft.text, base: recordVersion(record), ...(record?.id ? { baseId: record.id } : {}) });

/**
 * Load once for one effect run. `isCurrent` is per run, so a StrictMode
 * mount, cleanup, re-mount replay finishes the second run and drops the first.
 */
export async function loadContinuity(
  read: () => Promise<Partial<ContinuityView>>,
  isCurrent: () => boolean,
  apply: { start: () => void; data: (view: ContinuityView) => void; error: (sentence: string) => void; end: () => void },
): Promise<void> {
  apply.start();
  try {
    const result = await read();
    if (!isCurrent()) return;
    apply.data({ records: result.records ?? [], limits: result.limits ?? DEFAULT_CONTINUITY_LIMITS, coverage: result.coverage ?? null });
  } catch (cause) {
    if (isCurrent()) apply.error(continuityErrorSentence(cause, "Continuity could not be loaded. Try again."));
  } finally {
    if (isCurrent()) apply.end();
  }
}

// ---- PIP P2: reflection between conversations ----

export interface ProposalView {
  id: string; version: number; targetKind: "commitment" | "self-trait"; statement: string; state: "proposed"; createdAt: number; act: string;
  quotes: { sourceId: string; text: string }[];
}
export interface DisputeView {
  targetId: string; text: string; kind: "commitment" | "self-trait"; generation: number; counterVersion: number; unkept: number; support: number;
}
export interface ReflectionStatus {
  engine?: string;
  support: { status: "ok" | "unsupported" | "transient" | "unknown"; reason: string; copy: string | null; retryAt?: number };
  lastRunAt: number | null; lastAppliedAt?: number | null; reportedOverLimit?: boolean; dailyRuns: number; dailyCap: number;
  refusals: { at: number; runId: string; state: string; reason: string }[];
  running: boolean; cooldownUntil: number; unreflected: number; excludedThreads?: string[];
}
export interface ProposalConfirmResult { ok: boolean; id?: string; version?: number; recordId?: string; already?: true; reason?: string }

export const REFLECT_HEADLINE = "Reflect between conversations";
export const REFLECT_SENTENCE = "After you talk, this bot reads your own words and suggests things to keep. Proposed commitments and traits are added when you confirm them.";
export const PROPOSED_HEADLINE = "Proposed";
export const CONFIRMED_LABEL = "Confirmed from your own words";
export const DISPUTED_SENTENCE = "Some of your later words point the other way";
export const STATUS_HEADLINE = "Reflection status";
export const NOT_REFLECTED_SENTENCE = "Not reflected yet";
export const WRONG_TEMPLATE_TEXT = "Tell me when I am wrong, with evidence, once.";
export const PIP_NEW_SENTENCES = [REFLECT_HEADLINE, REFLECT_SENTENCE, PROPOSED_HEADLINE, CONFIRMED_LABEL, DISPUTED_SENTENCE, STATUS_HEADLINE, NOT_REFLECTED_SENTENCE, ...Object.values(PIP_ERRORS)];

export const proposalsReadBody = (botId: string) => ({ action: "pip-proposals", botId });
export const proposalConfirmBody = (botId: string, id: string, expectedVersion: number) => ({ action: "pip-proposal-confirm", botId, id, expectedVersion });
export const proposalDismissBody = (botId: string, id: string, expectedVersion: number) => ({ action: "pip-proposal-dismiss", botId, id, expectedVersion });
export const keepBody = (botId: string, targetId: string, generation: number, counterVersion: number) => ({ action: "pip-keep", botId, targetId, generation, counterVersion });
export const reflectStatusBody = (botId: string) => ({ action: "pip-reflect-status", botId });
export const reflectExcludeBody = (botId: string, threadId: string, excluded: boolean) => ({ action: "pip-reflect-exclude", botId, threadId, excluded });
export const reflectRetryBody = (botId: string) => ({ action: "pip-reflect-retry", botId });

/** Body for the reflection switch: `{reflect:true}` to turn on, null to clear. */
export const continuityOptionsPatchBody = (on: boolean) => ({ continuityOptions: on === true ? { reflect: true } : null });

export const proposalsChip = (count: number): string | null => (count > 0 ? `${count} to review` : null);
export const proposalQuoteLine = (text: string): string => `You said: "${text}"`;

/** The tier label for a row: confirmed rows say so, everything else keeps "You wrote this". */
export const rowOriginLine = (record: ContinuityRecord, now: number): string =>
  record.tier === "observed" ? CONFIRMED_LABEL : wroteLine(record.editedAt, now);

const REFUSAL_LINES: Record<string, string> = {
  "refused:cap": "Stopped: daily limit reached",
  "refused:off": "Stopped: reflection was switched off",
  "refused:unsupported": "Held: this engine cannot answer using only text",
  "refused:transient": "Paused: the engine did not answer in time",
  "refused:unstable": "Stopped: three attempts did not finish",
  "refused:bad-output": "Stopped: the answer was not usable",
  "refused:isolation": "Stopped: the engine did more than return text",
};
/** One plain line for a refused run. The server sends state ("refused") and a reason ("cap"). */
export function refusalLine(state: string, reason: string): string {
  for (const key of [`${state}:${reason}`, state, reason, `refused:${reason}`]) if (REFUSAL_LINES[key]) return REFUSAL_LINES[key] + (/leftover process|inspection-failed|plugins/i.test(reason) ? ": " + reason.replace(/\u2014/g, "-").slice(0, 400) : "");
  return "Stopped";
}

export function reflectedLine(lastRunAt: number | null | undefined, now: number): string {
  if (typeof lastRunAt !== "number" || !Number.isFinite(lastRunAt)) return NOT_REFLECTED_SENTENCE;
  const diff = Math.max(0, now - lastRunAt);
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  const when = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : hours < 24 ? `${hours} hr ago` : days === 1 ? "yesterday" : `${days} days ago`;
  return `Last reflected ${when}`;
}
export const dailyRunsLine = (status: Pick<ReflectionStatus, "dailyRuns" | "dailyCap">): string => `${status.dailyRuns} of ${status.dailyCap} reflections today`;
export const canRetryReflection = (status: ReflectionStatus | null | undefined): boolean =>
  !!status && (status.support.status === "unsupported" || status.support.status === "transient" || status.refusals.length > 0);
