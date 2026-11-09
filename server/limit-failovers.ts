// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-I I4: a chat that moved onto its bot's limit backup, one row per
// move in <dataDir>/limit-failovers.json. Row: pending -> applied ->
// restored (at the next turn after the reset) | cancelled (the owner picked
// a model meanwhile, or recovery could not prove the move). Kept 30 days.
//
// The chat record is the commit point: a row has authority only while its
// chat carries `limitFailover === rowId`. The chat patch (selection, marker,
// session reset) is one bots.json save; a pending row whose chat already
// carries its id therefore IS applied, and an applied row whose chat no
// longer carries it has lost its authority for good.
//
// The one-hop guard rides on the send, not the chat: the resend goes out
// under the row's own `resendSendId`, and a turn started from that send id
// never fails over again, whatever the chat's state is by then.
//
// A refusal on restart spans both files, so it has its own commit point: the
// row's `refusing` mark. A marked row is only ever finished (the chat back,
// the row cancelled), with no gate and no resend, whatever the gate says by
// then. The crash table is U22-REFUSAL-CRASH-NOTE.md.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { ModelSelection } from "./contracts.ts";
import type { BackupRefusal } from "./limit-backup-gate.ts";
import { sameSelection } from "./thread-follow-model.ts";
import { failoverResetAt } from "./turn-selection.ts";

export const LIMIT_FAILOVERS_FILE = "limit-failovers.json";
export const FAILOVER_KEEP_MS = 30 * 24 * 60 * 60_000;

export type FailoverState = "pending" | "applied" | "restored" | "cancelled";

export interface FailoverRow {
  rowId: string;
  state: FailoverState;
  botId: string;
  threadId: string;
  from: ModelSelection;
  was: "following" | ModelSelection;
  to: ModelSelection;
  resetsAt: number | null;
  at: number;
  sourceMessageId: string;
  /** a fresh 32-character send id for the resend (exact-id dedupe) */
  resendSendId: string;
  /** always 1: there is no second hop */
  hop: 1;
  updatedAt?: number;
  /** a committed refusal and why: this row is only ever finished, never applied or resent */
  refusing?: BackupRefusal;
  /** `was` is the chat's own restore point, never a backup. `create` always stamps it, so only a row from before 1.0.18 can be without it */
  wasChecked?: true;
}

export function newResendSendId(): string {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

/** Rows from before `wasChecked`, on every read, so no write has to succeed for a turn to see the right answer. Such a row cannot prove its `was`
 * was the owner's: the row before it may have aged out, and the first row of a chain looks the same as a later one. So a pinned `was` goes back
 * to following: at worst a pin lost once, never a backup with no gate. The row keeps its own reset. */
function withOwnRestorePoints(rows: FailoverRow[]): FailoverRow[] {
  for (const row of rows) {
    if (row.wasChecked) continue;
    row.was = "following";
    row.wasChecked = true;
  }
  return rows;
}

export class LimitFailoverStore {
  private readonly dataDir: () => string;
  private readonly now: () => number;
  constructor(dataDir: () => string, now: () => number = Date.now) { this.dataDir = dataDir; this.now = now; }
  private get file(): string { return join(this.dataDir(), LIMIT_FAILOVERS_FILE); }

  list(): FailoverRow[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(raw) ? withOwnRestorePoints(raw.filter((row): row is FailoverRow => Boolean(row) && typeof row === "object" && typeof (row as FailoverRow).rowId === "string")) : [];
    } catch { return []; }
  }
  /** The file is there but can't be read as rows. A missing row then proves nothing, so a chat's marker must not be taken as having no row behind it. */
  unreadable(): boolean {
    try { return !Array.isArray(JSON.parse(readFileSync(this.file, "utf8"))); }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  }
  /** Only a finished row ages out: an open one is what a chat still on its backup goes back by, however long that chat sits idle. */
  private write(rows: FailoverRow[]): void {
    const now = this.now();
    writeFileAtomic(this.file, JSON.stringify(rows.filter(row => (row.state !== "cancelled" && row.state !== "restored") || (row.updatedAt ?? row.at) > now - FAILOVER_KEEP_MS)), { mode: 0o600 });
  }
  get(rowId: string): FailoverRow | undefined { return this.list().find(row => row.rowId === rowId); }
  bySendId(sendId: string): FailoverRow | undefined { return this.list().find(row => row.resendSendId === sendId); }

  /** step (1): the row, pending, before the chat is touched */
  create(row: Omit<FailoverRow, "state" | "hop" | "rowId" | "resendSendId" | "wasChecked"> & { rowId?: string }): FailoverRow {
    const created: FailoverRow = { ...row, rowId: row.rowId ?? newResendSendId(), state: "pending", hop: 1, resendSendId: newResendSendId(), updatedAt: this.now(), wasChecked: true };
    this.write([...this.list(), created]);
    return created;
  }
  /** A new failover on a chat, read from that chat. An owner's pick clears the marker, so a chat still carrying one is on a backup, whatever a
   * stale-model repair has made of its model: the new row takes the carried row's restore point and reset. A backup is never what a chat "was",
   * so no later refusal of it can come back as a pick, in any order of events. A marker whose row is gone says the same with no pick left to go
   * back to, so the chat follows its bot. No marker: the selection is the owner's own. */
  startFrom(task: FailoverTaskView, row: Omit<FailoverRow, "state" | "hop" | "rowId" | "resendSendId" | "was" | "wasChecked">): FailoverRow {
    if (task.limitFailover) {
      const carried = this.get(task.limitFailover);
      return this.create(carried
        ? { ...row, was: structuredClone(carried.was), resetsAt: failoverResetAt(carried) }
        : { ...row, was: "following" });
    }
    return this.create({ ...row, was: task.modelSelection ? structuredClone(task.modelSelection) : "following" });
  }
  setState(rowId: string, state: FailoverState): FailoverRow | undefined {
    const rows = this.list();
    const row = rows.find(item => item.rowId === rowId);
    if (!row) return undefined;
    // a cancelled or restored row never regains authority
    if ((row.state === "cancelled" || row.state === "restored") && state !== row.state) return row;
    row.state = state; row.updatedAt = this.now();
    this.write(rows);
    return row;
  }
  cancel(rowId: string): FailoverRow | undefined { return this.setState(rowId, "cancelled"); }
  /** The refusal's commit point, one write. A pending row its chat carries is applied by then (see the header), and turn selection reads that. */
  markRefusing(rowId: string, reason: BackupRefusal, chatCarries: boolean): FailoverRow | undefined {
    const rows = this.list();
    const row = rows.find(item => item.rowId === rowId);
    if (!row) return undefined;
    if (row.state === "cancelled" || row.state === "restored") return row;
    row.refusing = reason;
    if (chatCarries && row.state === "pending") row.state = "applied";
    row.updatedAt = this.now();
    this.write(rows);
    return row;
  }
}

/** What a chat looks like to recovery. */
export interface FailoverTaskView { modelSelection?: ModelSelection; limitFailover?: string }

export type BootAction =
  | { kind: "apply"; row: FailoverRow }
  | { kind: "mark-applied"; row: FailoverRow }
  | { kind: "resend"; row: FailoverRow }
  | { kind: "cancel"; row: FailoverRow }
  | { kind: "finish-refusal"; row: FailoverRow };

/** What one refusal touches: the owner's line, the row, the chat. */
export interface FailoverRefusalSteps {
  line(reason: BackupRefusal): void;
  chatCarries(row: FailoverRow): boolean;
  /** false: the chat could not go back */
  chatBack(row: FailoverRow): boolean;
  markRefusing(rowId: string, reason: BackupRefusal, chatCarries: boolean): unknown;
  cancel(rowId: string): unknown;
}

/** Refuse a row, or finish a marked one (`reason` undefined: its line went out before the mark). The line comes before the mark: a crash
 * between them leaves at worst a stale or repeated line, whereas a mark first could finish with no line at all. A throw leaves the row
 * marked for the next boot. */
export function refuseFailover(row: FailoverRow, reason: BackupRefusal | undefined, steps: FailoverRefusalSteps): void {
  if (reason !== undefined && !row.refusing) {
    steps.line(reason);
    steps.markRefusing(row.rowId, reason, steps.chatCarries(row));
  }
  if (steps.chatCarries(row) && !steps.chatBack(row)) throw new Error("the chat could not go back; the row stays for the next boot");
  steps.cancel(row.rowId);
}

/** A failover that will not resend: the chat goes back first, then the row is cancelled. A cancelled row with its marker still on the chat would
 * leave the backup as an ordinary pick. A chat that could not go back throws, and the row keeps its authority, for the gate and the next boot. */
export function dropFailover(row: FailoverRow, steps: Pick<FailoverRefusalSteps, "chatCarries" | "chatBack" | "cancel">): void {
  if (steps.chatCarries(row) && !steps.chatBack(row)) throw new Error("the chat could not go back; the row stays for the next boot");
  steps.cancel(row.rowId);
}

/** Before a new failover on a chat: a committed refusal the chat still carries goes back first, or the new row would keep the refused
 * backup as what the chat "was", and it would come back as an ordinary pick. False: it could not go back, so start no failover. A chat that went
 * back and whose row could not then be cancelled is safe to read: the mark stays for the next boot, and this limit turn still fails over. */
export function settleCarriedRefusal(carried: FailoverRow | undefined, steps: FailoverRefusalSteps): boolean {
  if (!carried?.refusing || carried.state === "cancelled" || carried.state === "restored") return true;
  try { refuseFailover(carried, undefined, steps); return true; } catch { return !steps.chatCarries(carried); }
}

/** What boot recovery touches outside this file. */
export interface BootRecoveryDeps {
  taskOf(row: FailoverRow): FailoverTaskView | undefined;
  resendRecorded(row: FailoverRow): boolean;
  /** the gate, for a step that starts a turn on the backup */
  verdict(row: FailoverRow, now: number): { ok: true } | { ok: false; reason: BackupRefusal };
  /** `reason` undefined: finish a marked row */
  refuse(row: FailoverRow, reason: BackupRefusal | undefined): void;
  cancel(rowId: string): unknown;
  markApplied(rowId: string): unknown;
  /** the chat onto the backup; false: it could not be saved */
  apply(row: FailoverRow): boolean;
  resend(row: FailoverRow): void;
  failed(error: unknown): void;
}

/** Boot (SL-I section 4): finish what a crash interrupted, once. A committed refusal is finished before any gate is asked, and a row
 * refused in this pass takes no further step. */
export function runBootRecovery(rows: readonly FailoverRow[], deps: BootRecoveryDeps, now: number): void {
  const refused = new Set<string>();
  for (const action of bootRecovery(rows, deps.taskOf, deps.resendRecorded, now)) {
    if (refused.has(action.row.rowId)) continue;
    try {
      if (action.kind === "finish-refusal") { refused.add(action.row.rowId); deps.refuse(action.row, undefined); continue; }
      if (action.kind === "cancel") { deps.cancel(action.row.rowId); continue; }
      // #9: apply and resend start a turn on the backup; mark-applied of a pending row the chat carries is followed by its resend
      const verdict = deps.verdict(action.row, now);
      if (!verdict.ok) { refused.add(action.row.rowId); deps.refuse(action.row, verdict.reason); continue; }
      if (action.kind === "mark-applied") deps.markApplied(action.row.rowId);
      else if (action.kind === "apply") {
        if (!deps.apply(action.row)) { deps.cancel(action.row.rowId); continue; }
        deps.markApplied(action.row.rowId);
        deps.resend(action.row);
      } else deps.resend(action.row);
    } catch (error) { deps.failed(error); }
  }
}

/** The row's state as the chat (the commit point) says it is. */
export function effectiveState(row: FailoverRow, task: FailoverTaskView | undefined): FailoverState {
  if (row.state === "cancelled" || row.state === "restored") return row.state;
  const carries = task?.limitFailover === row.rowId;
  if (row.state === "pending") return carries ? "applied" : "pending";
  return carries ? "applied" : "cancelled";
}

function onWas(row: FailoverRow, task: FailoverTaskView): boolean {
  return row.was === "following" ? task.modelSelection === undefined : sameSelection(task.modelSelection, row.was);
}

/** Boot recovery (SL-I section 4). Every action is idempotent; the resend uses the row's stored send id. */
export function bootRecovery(rows: readonly FailoverRow[], taskOf: (row: FailoverRow) => FailoverTaskView | undefined, resendRecorded: (row: FailoverRow) => boolean, now: number): BootAction[] {
  const actions: BootAction[] = [];
  for (const row of rows) {
    if (row.refusing && row.state !== "cancelled" && row.state !== "restored") { actions.push({ kind: "finish-refusal", row }); continue; }
    const task = taskOf(row);
    const ahead = failoverResetAt(row) > now;
    const state = effectiveState(row, task);
    if (state === "cancelled" || state === "restored") { if (row.state !== state) actions.push({ kind: "cancel", row }); continue; }
    if (state === "pending") {
      // crash after the row, before the chat patch
      if (task && !task.limitFailover && onWas(row, task) && ahead) actions.push({ kind: "apply", row });
      else actions.push({ kind: "cancel", row });
      continue;
    }
    // applied (the chat carries it)
    if (row.state === "pending") actions.push({ kind: "mark-applied", row });
    // crash after the patch, before the resend: resend once, only while the reset is ahead
    if (!resendRecorded(row) && ahead) actions.push({ kind: "resend", row });
  }
  return actions;
}
