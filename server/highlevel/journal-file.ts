// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The durable HighLevel action journal (GAP-HIGHLEVEL-109 sections 7 and 9.3). One JSON line per write, appended and
// fsynced before put() returns, so a record exists on disk before anything is sent. The file holds ids, digests,
// phases, record ids and field names only: never review values, CRM data or credentials (actions.ts keeps the values
// in memory, so after a restart an open review goes stale and a change that may have been sent becomes outcome_unknown).
//
// The log is rewritten (atomically: temp file, fsync, rename) when it grows past twice the live rows plus a margin, so
// reading it at boot stays bounded by ACTION_MAX_IDENTITIES. A torn last line from a crash mid-append is skipped; any
// other unreadable line makes the whole journal refuse to load, and the caller then holds changes (fail closed).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { renameWithRetry } from "../atomic.ts";
import { HIGHLEVEL_FAMILY_TOOLS, LEGACY_TOOL_TO_OPERATION, isHighLevelToolName } from "../../shared/highlevel.ts";
import type { ActionIntent, ActionJournal, ActionPhase } from "./actions.ts";
import { providerOperation } from "./provider-manifest.ts";

const PHASES: ReadonlySet<ActionPhase> = new Set(["awaiting_approval", "approved", "dispatching", "applied", "not_applied", "outcome_unknown", "stale", "read_done", "read_withheld"]);
const COMPACT_MARGIN = 256;

type Line = { v: 1; put: ActionIntent } | { v: 1; delete: string };

const isString = (value: unknown): value is string => typeof value === "string";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isInt = (value: unknown): value is number => Number.isSafeInteger(value);

/** A record read back from disk, checked field by field. Values never appear here, so none are accepted. */
export function parseIntent(value: unknown): ActionIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  // Previous journals lack F0 bindings. Preserve their status but never revive approval.
  if (row.kind === undefined && row.upload === undefined) {
    const legacy = parseLegacyIntent(row);
    if (!legacy) return null;
    const operation = String(legacy.operation ?? LEGACY_TOOL_TO_OPERATION[String(legacy.tool)] ?? '');
    const manifest = providerOperation(operation);
    if (!manifest) return null;
    const { uploadDigest: _oldUploadDigest, ...rest } = legacy;
    const active = ['awaiting_approval', 'approved', 'dispatching'].includes(String(legacy.phase));
    const risk = legacy.risk === 'S' ? 'C' : legacy.risk ?? manifest.risk;
    return parseIntent({ ...rest, operation, risk, kind: risk === 'R' ? 'read' : 'change', upload: null,
      escalation: legacy.escalation ?? 'none', basis: legacy.basis ?? 'owner_exact_review',
      resource: legacy.resource ?? `location:${legacy.locationId}`, requestDigest: legacy.requestDigest ?? '0'.repeat(64), bodySha256: legacy.bodySha256 ?? '0'.repeat(64),
      ...(active ? { phase: legacy.phase === 'dispatching' && Number(legacy.dispatchAttempts) > 0 && risk !== 'R' ? 'outcome_unknown' : 'stale',
        outcomeCode: legacy.phase === 'dispatching' && Number(legacy.dispatchAttempts) > 0 && risk !== 'R' ? 'interrupted_after_send' : 'review_values_gone', approvalId: undefined } : {}),
    });
  }
  const uploadOk = row.upload === null || (!!row.upload && typeof row.upload === 'object' && !Array.isArray(row.upload)
    && Object.keys(row.upload).length === 3 && Object.keys(row.upload).every(k => ['name', 'size', 'sha256'].includes(k))
    && isString((row.upload as Record<string, unknown>).name) && isInt((row.upload as Record<string, unknown>).size)
    && Number((row.upload as Record<string, unknown>).size) >= 0
    && isString((row.upload as Record<string, unknown>).sha256) && /^[a-f0-9]{64}$/.test(String((row.upload as Record<string, unknown>).sha256)));
  const ok = (row.kind === 'read' || row.kind === 'change') && uploadOk && isString(row.actionId) && row.actionId.startsWith("hla_") && isString(row.botId) && isString(row.threadId) && isString(row.turnGeneration)
    && (row.completionKind === undefined || (row.operation === 'users.create' && row.completionKind === 'private_generated_password_v1'))
    && isString(row.connectionId) && isInt(row.connectionEpoch) && isString(row.locationId) && isString(row.companyId) && isInt(row.grantRevision)
    && isInt(row.accessRevision) && isInt(row.policyRevision) && isString(row.roleBinding) && (isHighLevelToolName(row.tool) || (isString(row.tool) && (Object.values(HIGHLEVEL_FAMILY_TOOLS) as string[]).includes(row.tool))) && isString(row.argumentsDigest)
    && (isString(row.operation) && providerOperation(row.operation) !== undefined)
    && (["R", "C", "D"].includes(String(row.risk)))
    && (["none", "send_count", "targets", "identical_loop"].includes(String(row.escalation)))
    && (isString(row.requestDigest) && /^[a-f0-9]{64}$/.test(row.requestDigest))
    && (isString(row.bodySha256) && /^[a-f0-9]{64}$/.test(row.bodySha256))
    && isString(row.resource)
    && (row.approvalContextDigest === undefined || (isString(row.approvalContextDigest) && /^[a-f0-9]{64}$/u.test(row.approvalContextDigest)))
    && (["owner_exact_review", "owner_no_limits", "owner_no_limits_attended"].includes(String(row.basis)))
    && isStrings(row.recordRefs) && isStrings(row.fields) && isString(row.reviewDigest) && PHASES.has(row.phase as ActionPhase)
    && isInt(row.dispatchAttempts) && isInt(row.createdAt) && isInt(row.expiresAt)
    && (row.approvalId === undefined || isString(row.approvalId)) && (row.outcomeCode === undefined || isString(row.outcomeCode))
    && (row.receipt === undefined || (Boolean(row.receipt) && typeof row.receipt === "object" && isString((row.receipt as Record<string, unknown>).recordId)
      && Object.keys(row.receipt as object).every(key => ["recordId", "fields", "approvalBasis"].includes(key))
      && isStrings((row.receipt as Record<string, unknown>).fields) && ["owner_exact_review", "owner_no_limits", "owner_no_limits_attended"].includes(String((row.receipt as Record<string, unknown>).approvalBasis))));
  if (!ok) return null;
  const allowed = new Set(["actionId", "botId", "threadId", "turnGeneration", "connectionId", "connectionEpoch", "locationId", "companyId", "grantRevision", "accessRevision",
    "policyRevision", "roleBinding", "tool", "argumentsDigest", "recordRefs", "fields", "reviewDigest", "phase", "approvalId", "dispatchAttempts", "createdAt", "expiresAt", "outcomeCode", "receipt", "kind", "operation", "risk", "basis", "escalation", "upload", "requestDigest", "resource", "bodySha256", "approvalContextDigest", "completionKind"]);
  if (Object.keys(row).some((key) => !allowed.has(key))) return null;
  return structuredClone(row) as unknown as ActionIntent;
}

function parseLegacyIntent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = structuredClone(value) as Record<string, unknown>;
  if (row.operation === 'media.upload') row.operation = 'media.files.upload';
  const ok = isString(row.actionId) && row.actionId.startsWith("hla_") && isString(row.botId) && isString(row.threadId) && isString(row.turnGeneration)
    && isString(row.connectionId) && isInt(row.connectionEpoch) && isString(row.locationId) && isString(row.companyId) && isInt(row.grantRevision)
    && isInt(row.accessRevision) && isInt(row.policyRevision) && isString(row.roleBinding) && (isHighLevelToolName(row.tool) || (isString(row.tool) && (Object.values(HIGHLEVEL_FAMILY_TOOLS) as string[]).includes(row.tool))) && isString(row.argumentsDigest)
    && (row.operation === undefined || (isString(row.operation) && providerOperation(row.operation) !== undefined))
    && (row.risk === undefined || ["R", "C", "S", "D"].includes(String(row.risk)))
    && (row.escalation === undefined || ["none", "send_count", "targets", "identical_loop"].includes(String(row.escalation)))
    && (row.requestDigest === undefined || (isString(row.requestDigest) && /^[a-f0-9]{64}$/.test(row.requestDigest)))
    && (row.bodySha256 === undefined || (isString(row.bodySha256) && /^[a-f0-9]{64}$/.test(row.bodySha256)))
    && (row.resource === undefined || isString(row.resource))
    && (row.uploadDigest === undefined || (isString(row.uploadDigest) && /^[a-f0-9]{64}$/.test(row.uploadDigest)))
    && (row.basis === undefined || ["owner_exact_review", "owner_no_limits", "owner_no_limits_attended"].includes(String(row.basis)))
    && isStrings(row.recordRefs) && isStrings(row.fields) && isString(row.reviewDigest) && PHASES.has(row.phase as ActionPhase)
    && isInt(row.dispatchAttempts) && isInt(row.createdAt) && isInt(row.expiresAt)
    && (row.approvalId === undefined || isString(row.approvalId)) && (row.outcomeCode === undefined || isString(row.outcomeCode))
    && (row.receipt === undefined || (Boolean(row.receipt) && typeof row.receipt === "object" && isString((row.receipt as Record<string, unknown>).recordId)
      && Object.keys(row.receipt as object).every(key => ["recordId", "fields", "approvalBasis"].includes(key))
      && isStrings((row.receipt as Record<string, unknown>).fields) && ["owner_exact_review", "owner_no_limits", "owner_no_limits_attended"].includes(String((row.receipt as Record<string, unknown>).approvalBasis))));
  if (!ok) return null;
  const allowed = new Set(["actionId", "botId", "threadId", "turnGeneration", "connectionId", "connectionEpoch", "locationId", "companyId", "grantRevision", "accessRevision",
    "policyRevision", "roleBinding", "tool", "argumentsDigest", "recordRefs", "fields", "reviewDigest", "phase", "approvalId", "dispatchAttempts", "createdAt", "expiresAt", "outcomeCode", "receipt", "operation", "risk", "basis", "escalation", "uploadDigest", "requestDigest", "resource", "bodySha256"]);
  if (Object.keys(row).some((key) => !allowed.has(key))) return null;
  return structuredClone(row);
}

export class HighLevelJournalUnreadable extends Error {
  constructor() { super("The HighLevel change journal could not be read. Changes are held until it is repaired; reads still work."); this.name = "HighLevelJournalUnreadable"; }
}

export function defaultHighLevelJournalFile(dataDir: string): string { return join(dataDir, "highlevel", "actions.jsonl"); }

/** Append-only file journal. Every method throws on a write failure, which actions.ts turns into "nothing was sent". */
// Exact upload metadata belongs to the in-memory review. The request digest binds it;
// a restart has no held bytes and always stales an unsent action.
function durableIntent(row: ActionIntent): ActionIntent { return { ...row, upload: null }; }

export class FileActionJournal implements ActionJournal {
  readonly #file: string;
  readonly #rows = new Map<string, ActionIntent>();
  #lines = 0;

  constructor(file: string) {
    this.#file = file;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    lines.forEach((text, index) => {
      let line: Line | null = null;
      try { line = JSON.parse(text) as Line; } catch { line = null; }
      const intent = line && "put" in line && line.v === 1 ? parseIntent(line.put) : null;
      const removed = line && "delete" in line && line.v === 1 && isString(line.delete) ? line.delete : null;
      if (intent) this.#rows.set(intent.actionId, intent);
      else if (removed) this.#rows.delete(removed);
      // a crash mid-append leaves at most one torn line, and only at the end
      else if (index !== lines.length - 1) throw new HighLevelJournalUnreadable();
    });
    this.#lines = lines.length;
  }

  #append(line: Line): void {
    const fd = openSync(this.#file, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(line)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.#lines += 1;
  }

  #compactIfLong(): void {
    if (this.#lines <= this.#rows.size * 2 + COMPACT_MARGIN) return;
    const temp = `${this.#file}.${process.pid}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      const body = [...this.#rows.values()].map((put) => JSON.stringify({ v: 1, put: durableIntent(put) } satisfies Line)).join("\n");
      writeSync(fd, body ? `${body}\n` : "");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameWithRetry(temp, this.#file);
    this.#lines = this.#rows.size;
  }

  put(intent: ActionIntent): void {
    const row = structuredClone(intent);
    this.#append({ v: 1, put: durableIntent(row) });
    this.#rows.set(row.actionId, row);
    this.#compactIfLong();
  }

  delete(actionId: string): void {
    if (!this.#rows.has(actionId)) return;
    this.#append({ v: 1, delete: actionId });
    this.#rows.delete(actionId);
    this.#compactIfLong();
  }

  all(): ActionIntent[] { return [...this.#rows.values()].map((row) => structuredClone(row)); }
}
