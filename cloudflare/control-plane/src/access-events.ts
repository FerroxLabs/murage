// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud token custody G2, the leaf: the audit-entry writer and the audited key use. It imports neither the door nor self-service, so any
// module that touches a key can write its entry without a cycle.
import { HTTPError } from "./http";
import { stepUpOpOf } from "./step-up-op";

/** How long after a home first went ready the owner's first device, browser and door hand-out still count as setting up: the welcome email covers
 *  them. Each notice's audit row stays. */
export const FIRST_SETUP_WINDOW_MS = 24 * 3_600_000;

export type AccessKind = "disk_key_unlock" | "backup_key_use" | "key_reseal" | "provider_rescue" | "provider_console" | "provider_password_reset"
  | "provider_untracked" | "provider_snapshot" | "provider_backup" | "provider_rebuild" | "pairing_key_use" | "export_key_use" | "provision_token_use"
  | "plan_change_power" | "provider_power";
/** Who did it, as a machine-readable word; ACTOR_WORDS says it to the owner. */
export type AccessActor = "home" | "operator" | "system" | "provider_account" | "owner";

export interface AccessEventInput {
  id?: string;
  homeId: string;
  /** Omitted: the home's current generation, else 0. */
  generation?: number;
  kind: AccessKind;
  actor: AccessActor;
  reason: string;
  sourceIp?: string | null;
  at?: number;
  /** Default 'requested' (the action is about to run; finishAccessEvent closes it). A detected action is already 'seen'. */
  outcome?: string;
}

/** Inside a claimed step-up operation the binding journals every write as the operation's own commitment. An audit row is not that
 *  effect, so it is written on the raw binding the operation was claimed on. */
const auditDb = (db: D1Database): D1Database => stepUpOpOf({ DB: db })?.db ?? db;

/**
 * Writes the audit entry. THROWS 503 audit_unavailable when it cannot: every caller writes this BEFORE it touches a key, so a failed
 * write means the key is not unwrapped (fail closed). Returns the entry's id.
 */
export async function recordAccessEvent(journaled: D1Database, e: AccessEventInput): Promise<string> {
  const db = auditDb(journaled);
  const id = e.id ?? crypto.randomUUID();
  try {
    await accessEventStatement(db, { ...e, id }).run();
  } catch {
    console.error(JSON.stringify({ message: "access audit write failed", kind: e.kind, homeId: e.homeId }));
    throw new HTTPError(503, "audit_unavailable");
  }
  return id;
}

/** The audit INSERT as a statement, for a caller's own atomic batch (the entry commits with the alert it reports, or not at all). */
export function accessEventStatement(db: D1Database, e: AccessEventInput & { id: string }): D1PreparedStatement {
  const at = e.at ?? Date.now();
  return db.prepare(`INSERT INTO cloud_access_events (id,home_id,generation,at,kind,actor,reason,source_ip,outcome,notice_next_at)
      VALUES (?,?,COALESCE(?,(SELECT generation FROM cloud_homes WHERE id=?),0),?,?,?,?,?,?,?)`)
    .bind(e.id, e.homeId, e.generation ?? null, e.homeId, at, e.kind, e.actor, e.reason.slice(0, 200), e.sourceIp ?? null, e.outcome ?? "requested", at);
}

/**
 * Runs a key use under its audit entry: the entry is written first (a failed write throws 503 audit_unavailable and `use` never runs, so
 * the key service is never called), then `use` runs, and the entry is closed as ok or failed.
 */
export async function auditedKeyUse<T>(db: D1Database, e: AccessEventInput, use: () => Promise<T>): Promise<T> {
  const id = await recordAccessEvent(db, e);
  try {
    const out = await use();
    await finishAccessEvent(db, id, "ok");
    return out;
  } catch (error) {
    await finishAccessEvent(db, id, "failed");
    throw error;
  }
}

/** Records how the audited action ended. Best effort: the entry already exists, and an unfinished one is closed as interrupted. */
export async function finishAccessEvent(journaled: D1Database, id: string, outcome: string): Promise<void> {
  const db = auditDb(journaled);
  try {
    await db.prepare("UPDATE cloud_access_events SET outcome=? WHERE id=? AND outcome='requested'").bind(outcome, id).run();
  } catch { /* the sweep closes it as interrupted */ }
}


/**
 * Records a provider action that one of OUR jobs just started, under the id the provider gave it (the entry id is `provider:<home>:<action id>`,
 * the same id the provider sweep writes). The sweep then finds the entry and does not write a second one. The actor is the job's own
 * (system or owner), which is what makes the action routine; an action with no entry of ours is written by the sweep as the provider
 * account's and goes out at once. If the sweep has not yet sent a notice for that entry, it is re-attributed to the job. Best effort: a
 * failed write leaves the action to the sweep, which tells the owner.
 */
export async function recordOwnProviderAction(journaled: D1Database, e: { homeId: string; generation: number; actionId: string | null;
  kind: AccessKind; actor: "system" | "owner"; reason: string; at?: number }): Promise<void> {
  if (!e.actionId) return;
  const at = e.at ?? Date.now();
  try {
    await auditDb(journaled).prepare(`INSERT INTO cloud_access_events (id,home_id,generation,at,kind,actor,reason,source_ip,outcome,notice_next_at)
      VALUES (?,?,?,?,?,?,?,NULL,'ok',?)
      ON CONFLICT(id) DO UPDATE SET actor=excluded.actor, outcome='ok' WHERE cloud_access_events.notice_state='pending' AND cloud_access_events.kind=excluded.kind`)
      .bind(`provider:${e.homeId}:${e.actionId}`, e.homeId, e.generation, at, e.kind, e.actor, e.reason.slice(0, 200), at).run();
  } catch {
    console.error(JSON.stringify({ message: "own provider action not recorded", kind: e.kind, homeId: e.homeId }));
  }
}
