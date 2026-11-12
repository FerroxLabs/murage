import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { canonicalBindingJson as canonicalJson } from "./binding-json.ts";
import { assertJournalStorage, journalStorageError, syncJournalDirectory, syncJournalEntry, syncJournalFile } from "./approval-journal-storage.ts";

export type ApprovalConflictReason = "approval_binding" | "identity_conflict" | "negative_confirmation" | "unconfirmed" | "authority_changed";
export type ApprovalOutcome = { readonly status: "applied"; readonly result: unknown }
  | { readonly status: "conflict"; readonly reason: ApprovalConflictReason };
export type ApprovalIdempotencyRecord = { readonly approvalId: string; readonly requestDigest: string } & (
  | { readonly state: "pending" }
  | { readonly state: "applied"; readonly result: unknown }
  | { readonly state: "conflict"; readonly reason: ApprovalConflictReason }
);
export interface ApprovalJournal {
  /** Stable storage identity: instances sharing storage must share this key. */
  readonly key: string;
  get(approvalId: string): ApprovalIdempotencyRecord | undefined;
  /** Atomic insert-if-absent, durably committed BEFORE returning true. */
  claim(approvalId: string, requestDigest: string): boolean;
  /** Immutable first terminal outcome wins, including across processes. */
  settle(approvalId: string, requestDigest: string, outcome: ApprovalOutcome): ApprovalOutcome;
}
const reasons = new Set<ApprovalConflictReason>(["approval_binding", "identity_conflict", "negative_confirmation", "unconfirmed", "authority_changed"]);
const refused = (): never => { throw new Error("HighLevel approval journal refused"); };
function validateRecord(value: unknown): ApprovalIdempotencyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refused();
  const r = value as Record<string, unknown>;
  if (typeof r.approvalId !== "string" || !r.approvalId || typeof r.requestDigest !== "string" || !r.requestDigest) return refused();
  const allowed = ["approvalId", "requestDigest", "state"];
  if (r.state === "applied") { if (!Object.hasOwn(r, "result")) return refused(); canonicalJson(r.result); allowed.push("result"); }
  else if (r.state === "conflict") { if (!reasons.has(r.reason as ApprovalConflictReason)) return refused(); allowed.push("reason"); }
  else if (r.state !== "pending") return refused();
  if (Object.keys(r).some(k => !allowed.includes(k))) return refused();
  return structuredClone(r) as ApprovalIdempotencyRecord;
}
function outcomeOf(record: ApprovalIdempotencyRecord): ApprovalOutcome {
  if (record.state === "applied") return { status: "applied", result: structuredClone(record.result) };
  if (record.state === "conflict") return { status: "conflict", reason: record.reason };
  return refused();
}
/** Dedicated approval subjournal under the application's data directory. Each
 * approval has immutable pending and terminal entries. Atomic link publishes a
 * fully flushed entry without replacing another process's claim or outcome.
 * NTFS uses file barriers; POSIX also barriers the containing directory.
 * Corruption fails closed; pending entries are NEVER aged out or auto-resubmitted.
 * Results must be validated, projected receipts, never raw provider responses. */
export class FileApprovalJournal implements ApprovalJournal {
  readonly key: string;
  constructor(directory: string) {
    this.key = resolve(directory);
    try {
      mkdirSync(this.key, { recursive: true, mode: 0o700 });
      assertJournalStorage(this.key);
      // Also retry ancestors that a previous creator left visible but unflushed
      // before it died. mkdir returning EEXIST is not a durability barrier.
      const device = statSync(this.key).dev;
      for (let current = this.key; ; current = dirname(current)) {
        syncJournalDirectory(current);
        const parent = dirname(current);
        // The mount's parent belongs to another volume (e.g. macOS's read-only
        // system volume). Its mount point predates our journal directory.
        if (current === parent || statSync(parent).dev !== device) break;
      }
    } catch (error) { throw journalStorageError(error); }
  }
  #path(approvalId: string, kind: "pending" | "outcome"): string {
    if (typeof approvalId !== "string" || !approvalId || approvalId.length > 1024) return refused();
    return join(this.key, `${createHash("sha256").update(approvalId).digest("hex")}.${kind}.json`);
  }
  #read(approvalId: string, kind: "pending" | "outcome"): ApprovalIdempotencyRecord | undefined {
    let text: string;
    try { text = readFileSync(this.#path(approvalId, kind), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return refused(); }
    let record: ApprovalIdempotencyRecord;
    try { record = validateRecord(JSON.parse(text)); } catch { return refused(); }
    if (record.approvalId !== approvalId || (kind === "pending") !== (record.state === "pending")) return refused();
    try { syncJournalEntry(this.#path(approvalId, kind), this.key); }
    catch (error) { throw journalStorageError(error); }
    return record;
  }
  #publish(path: string, record: ApprovalIdempotencyRecord): boolean {
    const bytes = canonicalJson(validateRecord(record));
    const temp = join(this.key, `.entry-${randomUUID()}.tmp`);
    let ownsTemp = false;
    try {
      const fd = openSync(temp, "wx", 0o600);
      ownsTemp = true;
      try {
        writeFileSync(fd, bytes);
        syncJournalFile(fd);
        try { linkSync(temp, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
        // NTFS supports atomic no-replace hard links. Flush the linked file
        // after publication; Windows must never open/fsync a directory.
        syncJournalFile(fd);
        syncJournalDirectory(this.key);
      } finally { closeSync(fd); }
      return true;
    } catch (error) { throw journalStorageError(error); }
    finally {
      // Orphans are inert, including after process death. Cleanup must not
      // mask a failed barrier or turn a committed claim into a failed call.
      if (ownsTemp) try { unlinkSync(temp); } catch { /* safe to leave the unique temp */ }
    }
  }
  get(approvalId: string): ApprovalIdempotencyRecord | undefined {
    const pending = this.#read(approvalId, "pending");
    const outcome = this.#read(approvalId, "outcome");
    if (outcome && (!pending || pending.requestDigest !== outcome.requestDigest)) return refused();
    return outcome ?? pending;
  }
  claim(approvalId: string, requestDigest: string): boolean {
    if (this.get(approvalId)) return false;
    return this.#publish(this.#path(approvalId, "pending"), { approvalId, requestDigest, state: "pending" });
  }
  settle(approvalId: string, requestDigest: string, outcome: ApprovalOutcome): ApprovalOutcome {
    const record = this.get(approvalId);
    if (!record || record.requestDigest !== requestDigest) return refused();
    if (record.state !== "pending") return outcomeOf(record);
    const terminal: ApprovalIdempotencyRecord = outcome.status === "applied"
      ? { approvalId, requestDigest, state: "applied", result: outcome.result }
      : { approvalId, requestDigest, state: "conflict", reason: outcome.reason };
    this.#publish(this.#path(approvalId, "outcome"), terminal);
    return outcomeOf(this.get(approvalId)!);
  }
}
const inFlight = new Map<string, Promise<ApprovalOutcome>>();
export interface ApprovedWriteCallbacks {
  /** Send once, validate identities, project and pass authority/release checks.
   * Return only a safe receipt; settlement/publication follows durable storage. */
  dispatch(): Promise<ApprovalOutcome>;
  /** Read-only reconciliation (existing recheck path). Must establish the actual
   * approved effect, not merely that a target still exists or remains writable.
   * Ambiguous/absent effects return conflict; this callback MUST NEVER resend. */
  reconcile(): Promise<ApprovalOutcome>;
}
/** Only a never-seen approval dispatches. Exceptions leave pending for a read on
 * replay. Approval/current-authority verification still belongs to the caller;
 * caching never grants authority to release results after a role/epoch change. */
export async function runApprovedWrite(journal: ApprovalJournal, approvalId: string, requestDigest: string, callbacks: ApprovedWriteCallbacks): Promise<ApprovalOutcome> {
  const existing = journal.get(approvalId);
  if (existing && existing.requestDigest !== requestDigest) return { status: "conflict", reason: "approval_binding" };
  if (existing && existing.state !== "pending") return outcomeOf(existing);
  const key = JSON.stringify([journal.key, approvalId]);
  const running = inFlight.get(key);
  if (running) return structuredClone(await running);
  const claimed = journal.claim(approvalId, requestDigest);
  // Re-read after an atomic claim race; a different process may have bound the
  // same approval to another digest or already committed the terminal outcome.
  const current = journal.get(approvalId);
  if (!current || current.requestDigest !== requestDigest) return { status: "conflict", reason: "approval_binding" };
  if (current.state !== "pending") return outcomeOf(current);
  const work = Promise.resolve().then(async () => {
    const outcome = await (claimed ? callbacks.dispatch() : callbacks.reconcile());
    return journal.settle(approvalId, requestDigest, outcome);
  });
  inFlight.set(key, work);
  try { return structuredClone(await work); }
  finally { if (inFlight.get(key) === work) inFlight.delete(key); }
}
