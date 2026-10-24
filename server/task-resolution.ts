// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a task id stands for, answered in one place. The status route (check_delegation / wait_delegation), the replay of a hand-off that ran
// past its wait, and the pass at start that ends tickets nothing can answer all ask `resolveTask`, so "can this task still be answered?" has one
// definition: a finished receipt, a hand-off waiting in line, a delegated turn running (watched here, or started by its row), or a shared request still open (or finished and not yet
// delivered). A task that belongs to another conversation is `foreign`: it exists, but this caller may not read it.
import type { DelegationReceipt } from "./delegations.ts";
import type { RoomRequest } from "./room-requests.ts";
import { isTerminalRoomRequestState } from "./room-requests.ts";

/** The value a shared request's row carries once its result reached the asker (the room_requests DDL is frozen, so the unused refusal field holds it). */
export const SHARED_RESULT_DELIVERED = "delivered";

export interface RunningDelegation { sourceThreadId?: string; requestId?: string; toBotId: string; taskId?: string; startedAtMs?: number; notOwnerAudience?: boolean }
export interface PendingDelegation { sourceThreadId: string; toBotId: string; attempts: number }
export type ResolvedTask =
  | { kind: "receipt"; receipt: DelegationReceipt }
  | { kind: "queued"; pending: PendingDelegation }
  | { kind: "running"; threadId: string; watch: RunningDelegation }
  | { kind: "shared"; request: RoomRequest; phase: "queued" | "running" | "finishing" }
  | { kind: "foreign" };

export interface TaskResolutionDeps {
  receipt: (taskId: string) => DelegationReceipt | null;
  pending: (taskId: string) => PendingDelegation | null;
  watches: () => Iterable<[string, RunningDelegation]>;
  request: (taskId: string) => RoomRequest | null;
  requestSourceThread: (requestId: string) => string | null | undefined;
  /** A started hand-off by its stored row (F3 02-4): a timed-out ask's ticket is answered from any process that opened the store, before or after the boot
   * settling, not only by this process's watch. The server always supplies it. */
  started?: (taskId: string) => { threadId: string; watch: RunningDelegation } | null;
  /** The value a shared request's row carries once its result reached the asker. */
  delivered: string;
}
/** Who is asking. Absent at start-up, when nothing is yet foreign: only whether the task can be answered at all matters. */
export interface TaskCaller { threadId: string; botId: string }

export function resolveTask(taskId: string, caller: TaskCaller | undefined, deps: TaskResolutionDeps): ResolvedTask | null {
  const mine = (sourceThreadId: string | undefined): boolean => !caller || sourceThreadId === caller.threadId;
  const receipt = deps.receipt(taskId);
  if (receipt) return mine(receipt.sourceThreadId) ? { kind: "receipt", receipt } : { kind: "foreign" };
  const pending = deps.pending(taskId);
  if (pending) return mine(pending.sourceThreadId) ? { kind: "queued", pending } : { kind: "foreign" };
  for (const [threadId, watch] of deps.watches()) {
    if (watch.taskId === taskId) return mine(watch.sourceThreadId) ? { kind: "running", threadId, watch } : { kind: "foreign" };
  }
  const started = deps.started?.(taskId);
  if (started) return mine(started.watch.sourceThreadId) ? { kind: "running", threadId: started.threadId, watch: started.watch } : { kind: "foreign" };
  const request = deps.request(taskId);
  if (!request) return null;
  const finishing = isTerminalRoomRequestState(request.state);
  // finished and delivered: the receipt is the answer, and none exists any more
  if (finishing && request.refusal === deps.delivered) return null;
  if (caller && !(deps.requestSourceThread(request.id) === caller.threadId && request.fromBotId === caller.botId)) return { kind: "foreign" };
  return { kind: "shared", request, phase: finishing ? "finishing" : request.state === "queued" ? "queued" : "running" };
}

/** What the status route answers for a resolved task: 200 (a receipt, or queued / running), 403 (another conversation's), 404 (nothing by that id). */
export function taskStatusCode(resolved: { kind: ResolvedTask["kind"] } | null): 200 | 403 | 404 {
  return resolved === null ? 404 : resolved.kind === "foreign" ? 403 : 200;
}

/** Can the server still answer for this task? The same question the status route answers: it is resolvable exactly when that route says 200. */
export function taskResolvable(taskId: string, deps: TaskResolutionDeps, caller?: TaskCaller): boolean {
  return taskStatusCode(resolveTask(taskId, caller, deps)) === 200;
}
