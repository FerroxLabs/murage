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

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { ModelSelection } from "./contracts.ts";
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
}

export function newResendSendId(): string {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

export class LimitFailoverStore {
  private readonly dataDir: () => string;
  private readonly now: () => number;
  constructor(dataDir: () => string, now: () => number = Date.now) { this.dataDir = dataDir; this.now = now; }
  private get file(): string { return join(this.dataDir(), LIMIT_FAILOVERS_FILE); }

  list(): FailoverRow[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(raw) ? raw.filter((row): row is FailoverRow => Boolean(row) && typeof row === "object" && typeof (row as FailoverRow).rowId === "string") : [];
    } catch { return []; }
  }
  private write(rows: FailoverRow[]): void {
    const now = this.now();
    writeFileAtomic(this.file, JSON.stringify(rows.filter(row => (row.updatedAt ?? row.at) > now - FAILOVER_KEEP_MS)), { mode: 0o600 });
  }
  get(rowId: string): FailoverRow | undefined { return this.list().find(row => row.rowId === rowId); }
  bySendId(sendId: string): FailoverRow | undefined { return this.list().find(row => row.resendSendId === sendId); }

  /** step (1): the row, pending, before the chat is touched */
  create(row: Omit<FailoverRow, "state" | "hop" | "rowId" | "resendSendId"> & { rowId?: string }): FailoverRow {
    const created: FailoverRow = { ...row, rowId: row.rowId ?? newResendSendId(), state: "pending", hop: 1, resendSendId: newResendSendId(), updatedAt: this.now() };
    this.write([...this.list(), created]);
    return created;
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
}

/** What a chat looks like to recovery. */
export interface FailoverTaskView { modelSelection?: ModelSelection; limitFailover?: string }

export type BootAction =
  | { kind: "apply"; row: FailoverRow }
  | { kind: "mark-applied"; row: FailoverRow }
  | { kind: "resend"; row: FailoverRow }
  | { kind: "cancel"; row: FailoverRow };

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
