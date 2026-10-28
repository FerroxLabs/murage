// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one restore fence. INVARIANT: after a restore, nothing that was pending at backup time runs, and nothing
// creates new work, until an explicit owner action taken after that restore.
//
// Every persisted store that holds pending or resumable work is listed in RESTORE_FENCED_STORES with how a
// restore fences it and which startup/resume consumers must look. Restore preparation (fenceRestoredSql and
// fenceRestoredContinuations) marks the rows with the restore generation; every consumer asks `isRestoreHeld`
// before it acts. restore-fence.test.ts fails when a table with a state/status/stage column is neither listed
// here nor declared not-pending-work, so a store added later cannot skip the fence.
import type { DatabaseSync } from "node:sqlite";
import { fenceRestoredBotCalls } from "./bot-calls-schema.ts";

export const RESTORE_HOLDS_DDL = "CREATE TABLE IF NOT EXISTS restore_holds (kind TEXT NOT NULL, row_id TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY (kind, row_id))";

export type RestoreHoldKind = "project_close" | "goal_close" | "room_request" | "card_delivery" | "push_relay_removal" | "image_operation" | "output_receipt" | "shared_result";

/** Anything a restore can hold: a JSON record (`restoreHeld`) or a SQL row read as-is (`restore_held`). */
export interface RestoreHeldCandidate { restoreHeld?: unknown; restore_held?: unknown }

/** THE check. True when a restore holds this row and no owner action after that restore has released it. */
export function isRestoreHeld(row: RestoreHeldCandidate | null | undefined): boolean {
  if (!row) return false;
  return row.restoreHeld === true || row.restore_held === true || Number(row.restore_held) === 1;
}

const hasTable = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** The hold of one SQL row, shaped for `isRestoreHeld`; null when the row is not held. */
export function restoreHoldFor(db: DatabaseSync, kind: RestoreHoldKind, rowId: string): { restoreHeld: true; restoreGen: string } | null {
  if (!hasTable(db, "restore_holds")) return null;
  const row = db.prepare("SELECT generation FROM restore_holds WHERE kind=? AND row_id=?").get(kind, rowId) as { generation: string } | undefined;
  return row ? { restoreHeld: true, restoreGen: row.generation } : null;
}
export const sqlRowRestoreHeld = (db: DatabaseSync, kind: RestoreHoldKind, rowId: string): boolean => isRestoreHeld(restoreHoldFor(db, kind, rowId));

/** SQL for "this row is NOT held by a restore", to sit in a WHERE before any LIMIT so held rows never fill a recovery batch.
 * `idExpr` is the column that holds the row id. Empty when the holds table does not exist yet (nothing can be held). */
export function notRestoreHeldSql(db: DatabaseSync, kind: RestoreHoldKind, idExpr: string): string {
  if (!hasTable(db, "restore_holds")) return "";
  return ` AND NOT EXISTS (SELECT 1 FROM restore_holds rh WHERE rh.kind='${kind}' AND rh.row_id=${idExpr})`;
}

export function holdForRestore(db: DatabaseSync, kind: RestoreHoldKind, rowId: string, generation: string): void {
  db.exec(RESTORE_HOLDS_DDL);
  db.prepare("INSERT OR REPLACE INTO restore_holds (kind, row_id, generation) VALUES (?,?,?)").run(kind, rowId, generation);
}
/** The owner's explicit action releases a hold. Returns whether one was released. */
export function releaseRestoreHold(db: DatabaseSync, kind: RestoreHoldKind, rowId: string): boolean {
  if (!hasTable(db, "restore_holds")) return false;
  return Number(db.prepare("DELETE FROM restore_holds WHERE kind=? AND row_id=?").run(kind, rowId).changes) > 0;
}
export const releaseRestoreHolds = (db: DatabaseSync, kind: RestoreHoldKind, prefix: string): number => {
  if (!hasTable(db, "restore_holds")) return 0;
  return Number(db.prepare("DELETE FROM restore_holds WHERE kind=? AND row_id LIKE ? ESCAPE '\\'").run(kind, prefix.replace(/[\\%_]/g, "\\$&") + "%").changes);
};

// ── what a restore fences ───────────────────────────────────────────────────

export type RestoreFenceMode = "held" | "terminalized" | "dropped" | "quarantined" | "disabled" | "paused" | "cleared" | "transcript-only" | "request-driven";
/** `proof` (dropped entries): SQL that must count ZERO runnable rows after a restore, so "dropped" is checked, not claimed.
 * `files` (json entries): the persisted store files the entry covers (the structural test reads them). */
export interface RestoreFencedStore { store: string; medium: "sqlite" | "json"; tables?: string[]; files?: string[]; mode: RestoreFenceMode; consumers: string[]; note: string; proof?: string[] }

/** Every persisted store that represents pending or resumable work, how a restore fences it, and the consumers that
 * must not act on it. `tables` names the SQL tables the entry covers (the structural test reads them). */
export const RESTORE_FENCED_STORES: readonly RestoreFencedStore[] = [
  { store: "room_requests", medium: "sqlite", tables: ["room_requests"], mode: "terminalized", consumers: ["roomDispatcher", "recoverOwnerSends", "holdFencedFanouts", "resumeProjectCloses", "resumeGoalCloseSummaries", "sweepOwedDeliveries"],
    note: "queued/running/waiting rows become expired and get a restore hold; owed owner words and unfinished fan-out are fenced by outcome note" },
  { store: "owner_sends", medium: "sqlite", tables: ["owner_sends"], mode: "held", consumers: ["drainQueuedSends", "drainQueuedChannelSends", "send retry", "Send again"],
    note: "every waiting or retryable send is a restore-held chip (restore_held + restore_gen); only a current-generation Send again runs it" },
  { store: "project close and goal sign-off", medium: "sqlite", tables: ["project_activity"], mode: "held", consumers: ["resumeProjectCloses", "resumeGoalCloseSummaries", "startProjectClose", "startGoalCloseSummary"],
    note: "a close or sign-off that had not finished is restore-held: an expired-by-restore summary is not completion; the owner pressing Close or Sign off again releases it" },
  { store: "project work items, goals, settings", medium: "sqlite", tables: ["project_work_items", "project_goals", "project_settings", "project_board_columns", "project_briefs", "project_budgets", "project_summaries", "project_member_state", "usage_ledger"], mode: "paused",
    consumers: ["project run loop", "card executor"], note: "cards move to Waiting, goals and every project are paused, work settings reset to Ask" },
  { store: "project card result deliveries", medium: "sqlite", tables: ["project_card_delivery_owed"], mode: "held", consumers: ["sweepOwedDeliveries"],
    note: "a completed card's result owed to its room is KEPT with a restore hold (never dropped): the sweep skips it, the restore notes name it, and the owner's Resume of the project releases the delivery" },
  { store: "phone push notifications", medium: "sqlite", tables: ["push_events"], mode: "dropped", consumers: ["push sender"], note: "held and pending notifications are dropped: they describe requests that no longer wait",
    proof: ["SELECT COUNT(*) AS n FROM push_events WHERE state IN ('held','pending')"] },
  { store: "phone push relay removals", medium: "sqlite", tables: ["push_relay_removals"], mode: "held", consumers: ["relayRemovalSweeper", "dueRelayRemovals"],
    note: "a removal owed to the relay is quarantined with a restore hold and not invoked; the owner's own device removal after the restore (enqueueRelayRemoval) releases it" },
  // 1.0.9 bot calls (design BOT-CALLS-109 5.9): nothing rings until the owner re-arms with the current restore generation
  { store: "bot calls", medium: "sqlite", tables: ["bot_calls", "bot_call_sessions"], mode: "terminalized", consumers: ["boot reconcile", "call deadline timer", "answer route"],
    note: "intents not done end done(restored) with the active slot freed; open call sessions end 'restore'",
    proof: ["SELECT COUNT(*) AS n FROM bot_calls WHERE state <> 'done'", "SELECT COUNT(*) AS n FROM bot_call_sessions WHERE ended_at IS NULL"] },
  { store: "call admissions owed", medium: "sqlite", tables: ["bot_call_owed"], mode: "dropped", consumers: ["drainOwed"], note: "owed call admissions are dropped: the facts they name happened before the backup",
    proof: ["SELECT COUNT(*) AS n FROM bot_call_owed"] },
  { store: "call rules", medium: "sqlite", tables: ["bot_call_rules"], mode: "paused", consumers: ["call admission", "decide()"],
    note: "every rule is restore-held with the restore generation (restore_held, restore_gen); a rule written later is born held; only Turn calls back on with the current generation clears them",
    proof: ["SELECT COUNT(*) AS n FROM bot_call_rules WHERE restore_held=0"] },
  { store: "phone push bindings, risk, decisions", medium: "sqlite", tables: ["push_bindings", "push_risk", "push_decisions"], mode: "request-driven", consumers: ["phone response route"], note: "read only when a phone answers a request; nothing reads them at boot" },
  { store: "messages and cards", medium: "sqlite", tables: ["messages", "open_card", "thread_state", "thread_snooze", "turns", "turn_first", "inbox_item_state"], mode: "terminalized", consumers: ["card answer routes"], note: "waiting cards expire and are dismissed, goal runs block, queued flags clear" },
  { store: "image operations and output receipts", medium: "sqlite", tables: ["image_operations", "output_publications"], mode: "held",
    consumers: ["imageOperations.resumePendingPublications", "outputPublisher.resumePending", "resumePendingAssistantImages", "resumeRegisteredShellCards"],
    note: "every unfinished operation and receipt is restore-held (kept, never dropped): no startup publisher touches it. An operation is released by the owner asking for the same image again (same request id, any turn); an orphan receipt only by the owner's explicit release of that output carrying the current restore generation. A message in the conversation releases nothing" },
  { store: "finished shared request results", medium: "sqlite", tables: ["room_requests", "room_request_owed"], mode: "held", consumers: ["deliverOwedSharedResults", "deliverSharedResult"],
    note: "a finished shared request's text copy, mirror and receipt that had not been delivered is KEPT with a restore hold: boot and the sweep publish nothing; the owner's per-item release (restoreGen) or Resume of its project lets it through" },
  { store: "image and artifact records", medium: "sqlite", tables: ["artifacts", "image_render_prompts", "image_prompt_blocks", "image_reference_packs", "image_model_probes"], mode: "request-driven", consumers: ["image tools", "Files"], note: "saved records read on request; nothing in them starts at boot" },
  { store: "memory jobs", medium: "sqlite", tables: ["memory_jobs"], mode: "paused", consumers: ["memory worker"], note: "pauseRestoredMemory pauses memory and invalidates leases" },
  { store: "bots.json and groups.json held continuations", medium: "json", files: ["bots.json", "groups.json"], mode: "held", consumers: ["drainHeldContinuations", "roomDispatcher.ready", "held-continuation retry"],
    note: "every held continuation is recovery-held with the restore generation; only the owner's retry after the restore releases it, never when its card was dismissed" },
  { store: "bots.json and groups.json busy flags, tasks", medium: "json", files: ["bots.json", "groups.json"], mode: "cleared", consumers: ["turn start"], note: "busy/working cleared, auto-approve and resume cursors reset" },
  { store: "routines.json and routine run journal", medium: "json", files: ["routines.json", "routine-runs.json"], mode: "paused", consumers: ["routine scheduler"], note: "routines disabled; non-terminal runs cancelled" },
  { store: "calendar-calls.json", medium: "json", files: ["calendar-calls.json"], mode: "paused", consumers: ["calendar scheduler"], note: "nextRunAt cleared" },
  { store: "webhooks.json", medium: "json", files: ["webhooks.json"], mode: "disabled", consumers: ["webhook receiver"], note: "disabled, verification pending, secrets replaced" },
  { store: "delegations.json (1.0.1 queue file), browser-cleanups.json, staged skill writes", medium: "json", files: ["delegations.json", "browser-cleanups.json"], mode: "quarantined", consumers: ["delegation recovery", "browser cleanup", "skill staging"], note: "moved to recovery-quarantine as evidence" },
  { store: "queued handoffs (pending_delegations)", medium: "sqlite", tables: ["pending_delegations"], mode: "quarantined", consumers: ["drainDelegations", "releaseParkedDelegations"], proof: ["SELECT COUNT(*) AS n FROM pending_delegations"],
    note: "the rows are written to recovery-quarantine/delegations.json as evidence and deleted inside the messages.db restore transaction; activation refuses a restored copy that still queues one" },
  { store: "queued-messages.json (legacy steer queue)", medium: "json", files: ["queued-messages.json"], mode: "transcript-only", consumers: ["importLegacyQueueFile"], note: "appends the owner's words as plain transcript lines; no send row, nothing runs" },
] as const;

/** Tables with a state/status/stage column that hold no pending or resumable work, with the reason. */
export const RESTORE_NOT_PENDING_WORK: Readonly<Record<string, string>> = Object.freeze({
  restore_holds: "the fence's own record",
  send_restore_generation: "the current restore token",
  owner_deleted_threads: "a deletion record",
  meta: "key/value settings",
  messages_fts: "search index, rebuilt",
  inbox_raw: "the Inbox projection (inbox.ts), derived from messages by triggers: a restore empties it and it is rebuilt on first open",
  inbox_items: "the Inbox projection (inbox.ts), derived from messages by triggers: a restore empties it and it is rebuilt on first open",
  thread_key: "the branch and line index's record of how far each thread's fill has got (branch-store.ts): derived from messages, so a restore leaves it to be filled again per thread",
  shared_ready_teams: "which teams of the shared queue may start now (shared-ready.ts): an index of queued room_requests, which a restore expires; a team with nothing queued is dropped from it the first time it is looked at",
  shared_drain_sweep: "when each bot's backstop sweep of waiting shared teams is next due: a schedule only, it holds no work",
  room_request_retry: "the next-look times of parked queued requests: a restore expires every queued request, and the database removes its retry row in the same statement",
  bot_call_watch_threads: "the channel threads of the enabled sender rules (bot-calls-schema.ts), derived from bot_call_rules and rewritten with them",
  bot_call_settings: "call settings (the bot switch, calls off for today, the last re-armed restore generation), no work",
  team_identities: "a rename journal; restore preparation (reconcileTeamJournalFiles) completes or rolls it back, so boot finds none, and it runs no bot work",
});

// ── preparation (inside the messages.db restore transaction) ────────────────

interface CloseDetail { closeSeq?: unknown; goalSummary?: unknown; step?: unknown }

/** Marks every pending SQL row with the restore generation. Runs before the project tables are rewritten so it can
 * still see which requests were pending. Returns one note per fenced kind of work. */
export function fenceRestoredSql(db: DatabaseSync, generation: string): Array<{ component: string; action: string }> {
  db.exec(RESTORE_HOLDS_DDL);
  const notes: Array<{ component: string; action: string }> = [];
  // holds of an earlier restore take the new generation: they stay held until the owner acts after THIS restore
  db.prepare("UPDATE restore_holds SET generation=?").run(generation);
  const count = (kind: RestoreHoldKind, n: number, what: string) => { if (n > 0) notes.push({ component: "messages.db", action: `${n} ${what} kept on hold: ${kind === "project_close" || kind === "goal_close" ? "press Close or Sign off again to finish it" : "nothing ran after the restore"}` }); };
  if (hasTable(db, "project_activity")) {
    const latestClose = new Map<string, CloseDetail>(), latestGoal = new Map<string, CloseDetail>();
    for (const row of db.prepare("SELECT group_id AS g, detail FROM project_activity WHERE kind='close' ORDER BY rowid").all() as Array<{ g: string; detail: string }>) {
      let detail: CloseDetail;
      try { detail = JSON.parse(row.detail) as CloseDetail; } catch { continue; }
      if (typeof detail.goalSummary === "string") latestGoal.set(`${row.g}:${detail.goalSummary}`, detail);
      else if (Number.isInteger(detail.closeSeq) && Number.isInteger(detail.step)) latestClose.set(row.g, detail);
    }
    let closes = 0, goals = 0;
    for (const [group, detail] of latestClose) if (Number(detail.step) < 3) { holdForRestore(db, "project_close", `${group}:${detail.closeSeq}`, generation); closes++; }
    for (const [key, detail] of latestGoal) if (Number(detail.step) < 3) { holdForRestore(db, "goal_close", key, generation); goals++; }
    count("project_close", closes, "project close(s) that had not finished were");
    count("goal_close", goals, "goal sign-off(s) that had not finished were");
  }
  if (hasTable(db, "room_requests")) {
    let held = 0;
    // iterated, never loaded whole: the history can hold a very large number of open requests
    for (const row of db.prepare("SELECT id FROM room_requests WHERE state IN ('queued','running','waiting_owner','waiting_bot')").iterate() as Iterable<{ id: string }>) { holdForRestore(db, "room_request", row.id, generation); held++; }
    count("room_request", held, "waiting room request(s) were");
  }
  if (hasTable(db, "project_card_delivery_owed")) {
    // A finished card's result that had not reached its room is KEPT, never dropped: the card is still done and its
    // result and corrections are the owner's. It is held (the sweep skips it) until the owner resumes the project.
    let kept = 0;
    for (const row of db.prepare("SELECT request_id AS id FROM project_card_delivery_owed").all() as Array<{ id: string }>) { holdForRestore(db, "card_delivery", row.id, generation); kept++; }
    if (kept > 0) notes.push({ component: "messages.db", action: `${kept} finished card result(s) were waiting to be posted to their project room: kept on hold, Resume the project to post them` });
  }
  if (hasTable(db, "room_requests")) {
    let kept = 0;
    // Only results the database recorded as shared work when it was created are held (a provenance row), never an ordinary channel turn (Astra r18).
    // The query starts at the provenance table (primary-key lookups into room_requests) and so does not depend on the owed set being seeded in an older archive.
    const heldSql = hasTable(db, "shared_request_provenance")
      ? "SELECT r.id AS id FROM shared_request_provenance p JOIN room_requests r ON r.id=p.request_id WHERE r.state IN ('done','failed') AND r.verb IN ('ask','message') AND r.target_thread_id IS NOT NULL AND r.refusal IS NOT 'delivered'"
      : undefined;
    for (const row of heldSql ? db.prepare(heldSql).all() as Array<{ id: string }> : []) { holdForRestore(db, "shared_result", row.id, generation); kept++; }
    if (kept > 0) notes.push({ component: "messages.db", action: `${kept} finished shared result(s) not yet posted were kept on hold: nothing was posted after the restore, release each one to post it` });
  }
  if (hasTable(db, "push_events")) {
    const dropped = Number(db.prepare("UPDATE push_events SET state='dropped' WHERE state IN ('held','pending')").run().changes);
    if (dropped > 0) notes.push({ component: "messages.db", action: `${dropped} phone notification(s) that were waiting to be sent were dropped` });
  }
  {
    const calls = fenceRestoredBotCalls(db, generation);
    if (calls.calls + calls.sessions > 0) notes.push({ component: "messages.db", action: `${calls.calls} bot call(s) and ${calls.sessions} call session(s) were ended by the restore` });
    if (calls.owed > 0) notes.push({ component: "messages.db", action: `${calls.owed} call admission(s) that were waiting were dropped` });
    if (calls.rules > 0) notes.push({ component: "messages.db", action: `${calls.rules} call rule(s) are paused after the restore: turn calls back on to use them` });
  }
  if (hasTable(db, "push_relay_removals")) {
    let kept = 0;
    for (const row of db.prepare("SELECT binding_id AS id FROM push_relay_removals").all() as Array<{ id: string }>) { holdForRestore(db, "push_relay_removal", row.id, generation); kept++; }
    if (kept > 0) notes.push({ component: "messages.db", action: `${kept} phone device removal(s) owed to the relay were kept on hold: remove the device again to finish them` });
  }
  if (hasTable(db, "image_operations")) {
    let kept = 0;
    for (const row of db.prepare("SELECT id FROM image_operations WHERE state IN ('publish-pending','running','uncertain') AND result IS NOT NULL").all() as Array<{ id: string }>) { holdForRestore(db, "image_operation", row.id, generation); kept++; }
    if (kept > 0) notes.push({ component: "messages.db", action: `${kept} image(s) received but not yet saved were kept on hold: ask for the image again to finish it` });
  }
  if (hasTable(db, "output_publications")) {
    let kept = 0;
    for (const row of db.prepare("SELECT id FROM output_publications WHERE NOT (stage='registered' AND (message_id IS NOT NULL OR producer<>'shell-output'))").all() as Array<{ id: string }>) { holdForRestore(db, "output_receipt", row.id, generation); kept++; }
    if (kept > 0) notes.push({ component: "messages.db", action: `${kept} saved output(s) not yet announced were kept on hold: release each one to announce it` });
  }
  return notes;
}

type JsonRecord = Record<string, unknown>;
const jsonObject = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
export const RESTORE_HELD_CONTINUATION_NOTE = "This was waiting when the backup was made. Authorize it again to continue.";

/** Every held continuation of a bot or group record (the record itself, a bot's tasks, a group's tasks) becomes
 * recovery-held with the restore generation. The record is changed in place. Returns how many were held. */
export function fenceRestoredContinuations(record: JsonRecord, generation: string): number {
  let held = 0;
  for (const holder of [record, ...(Array.isArray(record.tasks) ? record.tasks : [])]) {
    if (!jsonObject(holder) || !Array.isArray(holder.heldContinuations)) continue;
    holder.heldContinuations = holder.heldContinuations.map(item => {
      if (!jsonObject(item)) return item;
      held++;
      return { ...item, state: "recovery", error: RESTORE_HELD_CONTINUATION_NOTE, retryAt: undefined, restoreHeld: true, restoreGen: generation };
    });
  }
  return held;
}

/** A held continuation may be offered to the engine only when no restore holds it, it is not waiting on authority
 * or recovery, and its retry time has come. Pure, so the drain and its test share it. */
export interface DrainableContinuation { botId?: string; state?: string; error?: string; retryAt?: number; restoreHeld?: boolean }
export function runnableContinuation<T extends DrainableContinuation>(items: readonly T[] | undefined, botId: string, now: number): T | undefined {
  return items?.find(item => item.botId === botId && !isRestoreHeld(item) && item.state !== "recovery" && item.state !== "authority" && (!item.error || item.state === "retry") && (item.retryAt ?? 0) <= now);
}

/** The owner's retry of a held continuation, decided without effects. A restore-held item runs only when its
 * restore generation is the current one and its card was not dismissed; a dismissed card means never. */
export type ContinuationRelease = { ok: true; restoreHeld: boolean } | { ok: false; reason: "stale_generation" | "card_dismissed" };
export function releaseHeldContinuation<T extends object>(item: T & { restoreHeld?: boolean; restoreGen?: string }, currentGeneration: string | null, cardDismissed: boolean, presentedGeneration?: string): ContinuationRelease {
  if (!isRestoreHeld(item)) return { ok: true, restoreHeld: false };
  if (cardDismissed) return { ok: false, reason: "card_dismissed" };
  // Same rule as the owner's Send again: the press must carry the token of the NEWEST restore (the held item shows it),
  // and it must be the item's own. A press or an automatic retry from before a later restore carries none or an old one.
  if (!presentedGeneration || !item.restoreGen || item.restoreGen !== currentGeneration || presentedGeneration !== item.restoreGen) return { ok: false, reason: "stale_generation" };
  return { ok: true, restoreHeld: true };
}

// ── owner actions that release what a restore held ──────────────────────────

/** The owner resumed this project: the finished-card results the restore held for its room are released.
 * Returns how many. The caller then runs the delivery sweep. */
export function releaseHeldCardDeliveries(db: DatabaseSync, groupId: string): number {
  if (!hasTable(db, "restore_holds") || !hasTable(db, "room_requests")) return 0;
  const rows = db.prepare("SELECT h.row_id AS id FROM restore_holds h JOIN room_requests r ON r.id=h.row_id WHERE h.kind='card_delivery' AND r.group_id=?").all(groupId) as Array<{ id: string }>;
  let released = 0;
  for (const row of rows) if (releaseRestoreHold(db, "card_delivery", row.id)) released++;
  return released;
}

/** Results a restore is keeping for this project's room, for the owner to see (Resume posts them). */
export function heldCardDeliveries(db: DatabaseSync, groupId: string): Array<{ requestId: string }> {
  if (!hasTable(db, "restore_holds") || !hasTable(db, "room_requests") || !hasTable(db, "project_card_delivery_owed")) return [];
  return (db.prepare("SELECT h.row_id AS requestId FROM restore_holds h JOIN room_requests r ON r.id=h.row_id JOIN project_card_delivery_owed o ON o.request_id=h.row_id WHERE h.kind='card_delivery' AND r.group_id=? ORDER BY h.row_id").all(groupId) as Array<{ requestId: string }>);
}

/** The owner asked for this image operation again (same request id): the operation and the receipts it published
 * are released, so the live path finishes them from the retained bytes with no new provider call. */
export function releaseHeldImageOperation(db: DatabaseSync, operationId: string): boolean {
  if (!hasTable(db, "restore_holds")) return false;
  const released = releaseRestoreHold(db, "image_operation", operationId);
  if (released && hasTable(db, "output_publications")) {
    for (const row of db.prepare("SELECT id FROM output_publications WHERE producer='image-operation' AND run_id=?").all(operationId) as Array<{ id: string }>) releaseRestoreHold(db, "output_receipt", row.id);
  }
  return released;
}

/** The owner's explicit release of ONE held item (an unannounced output or a finished shared result). It must carry the
 * restore generation of the newest restore, which is also the generation the hold was made under. Nothing else
 * (a message, a sweep, a restart) releases it. */
export type HoldRelease = { ok: true } | { ok: false; reason: "stale_generation" | "not_held" };
export function releaseHeldItem(db: DatabaseSync, kind: "output_receipt" | "shared_result", rowId: string, presentedGeneration: string | undefined, currentGeneration: string | null): HoldRelease {
  const hold = restoreHoldFor(db, kind, rowId);
  if (!hold) return { ok: false, reason: "not_held" };
  if (!presentedGeneration || !currentGeneration || presentedGeneration !== currentGeneration || hold.restoreGen !== currentGeneration) return { ok: false, reason: "stale_generation" };
  return releaseRestoreHold(db, kind, rowId) ? { ok: true } : { ok: false, reason: "not_held" };
}

/** Same checks as `releaseHeldItem`, but the hold stays: the caller finishes the item first and releases only on success. */
export function checkHeldRelease(db: DatabaseSync, kind: "output_receipt" | "shared_result", rowId: string, presentedGeneration: string | undefined, currentGeneration: string | null): HoldRelease {
  const hold = restoreHoldFor(db, kind, rowId);
  if (!hold) return { ok: false, reason: "not_held" };
  if (!presentedGeneration || !currentGeneration || presentedGeneration !== currentGeneration || hold.restoreGen !== currentGeneration) return { ok: false, reason: "stale_generation" };
  return { ok: true };
}

/** Publishes a held shared result and drops its hold only once that succeeded. `publish` returns true when the result is truly delivered;
 * false or a throw leaves the hold in place (the item stays listed with its Release button) and answers false. */
export function releaseSharedResultAfterDelivery(db: DatabaseSync, rowId: string, publish: () => boolean): boolean {
  try { if (!publish()) return false; } catch { return false; }
  releaseRestoreHold(db, "shared_result", rowId);
  return true;
}

/** Finished shared results a restore is keeping, for the owner to see and release. */
export function heldItems(db: DatabaseSync, kind: "output_receipt" | "shared_result"): Array<{ id: string; generation: string }> {
  if (!hasTable(db, "restore_holds")) return [];
  return db.prepare("SELECT row_id AS id, generation FROM restore_holds WHERE kind=? ORDER BY row_id").all(kind) as Array<{ id: string; generation: string }>;
}

/** The owner resumed this project: each finished shared result the restore held for its room is published and ONLY THEN released,
 * the same rule as releasing one item. `publish` returns true when the result is truly delivered (or there is nothing to publish);
 * false or a throw leaves that hold in place, so a result is never freed without its publication. Returns the holds released. */
export function releaseHeldSharedResults(db: DatabaseSync, groupId: string, publish: (requestId: string) => boolean): number {
  if (!hasTable(db, "restore_holds") || !hasTable(db, "room_requests")) return 0;
  let released = 0;
  for (const row of db.prepare("SELECT h.row_id AS id FROM restore_holds h JOIN room_requests r ON r.id=h.row_id WHERE h.kind='shared_result' AND r.group_id=?").all(groupId) as Array<{ id: string }>) if (releaseSharedResultAfterDelivery(db, row.id, () => publish(row.id))) released++;
  return released;
}
