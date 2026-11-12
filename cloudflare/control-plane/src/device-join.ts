// SPDX-License-Identifier: AGPL-3.0-or-later
// Door device confirmation (door-confirm/DESIGN.md with the r8 corrections). Everything here is inert unless DOOR_JOIN_REQUIRED is "1".
//   first computer: an emailed proof is the owner's confirmation; a row (state ticketed -> used | ended) records the ticket and carries the
//     Remove link of the connection email.
//   later computer: a join (waiting -> ready -> used, or cancelled / lapsed). The hold clock lives on this table only and starts at the first
//     successful send. Yes shortens the hold to at most one hour. No / Remove stop it and revoke every key a ticket could have enrolled.
// Links are device_join verify_tokens: the email address only is compared (never updated_at), and No / Remove skip the identity reader.
import { z } from "zod";
import { reconciledContactEmail } from "./cloud-accounts";
import { HOME_DEVICES_REVOKE, listHomeDevices } from "./devices";
import { readerUser, type DoorDependencies } from "./door";
import { senderOrFail } from "./email";
import { boundCustomer, JOIN_ACTION_ROUTE, JOINS_ROUTE, type Identity } from "./customer-identity";
import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";
import { homeManagementCall } from "./pairing";
import { takeLimit } from "./self-service";
import { commitToken, DEVICE_JOIN_EMAIL_GEN, issueToken, lostCommitRefusal, peekToken, takeSlot, verifyToken, whenConsumed, type TokenDeps, type TokenPurpose } from "./public-tokens";
import { registerPublicRoute } from "./public-routes";
import type { Q } from "./billing-lease";
import { CLOCK_SKEW_SECONDS } from "./supabase-jwt";

declare global {
  interface Env { /** "1": the door confirms every new computer (first: emailed proof + Remove link; later: join). Unset: today's behaviour. */ DOOR_JOIN_REQUIRED?: string }
  namespace Cloudflare { interface Env { DOOR_JOIN_REQUIRED?: string } }
}
// ITEM 9 guard: decided in held-until-item9-highs.ts (off while HELD_UNTIL_ITEM9_HIGHS, whatever the env says).
import { joinRequired } from "./held-until-item9-highs";
export { joinRequired };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const JOIN_HOLD_MS = 72 * HOUR;
export const JOIN_YES_HOLD_MS = HOUR;
export const JOIN_READY_MS = 7 * DAY;
export const JOIN_CANCEL_LINK_MS = 14 * DAY;
export const JOIN_MAIL_PER_HOUR = 3;
export const JOIN_MAIL_PER_DAY = 10;
const TICKET_TTL_MS = 60_000;
const SKEW_MS = CLOCK_SKEW_SECONDS * 1000;
/** cron period plus the ticket's life and skew: a No keeps looking for its keys this long after it was pressed. */
const REVOKE_TAIL_MS = TICKET_TTL_MS + SKEW_MS + 6 * 60_000;
const RETRY_MS = 60_000;

export interface JoinRow {
  id: string; account_id: string; email: string; home_id: string; generation: number; kind: string; tier: "first" | "later"; state: string; created_at: number;
  hold_until: number | null; ready_at: number | null; used_at: number | null; ended_at: number | null; ended_by: string | null; yes_at: number | null; redeemed_bind: string | null;
  last_ticket_exp: number | null; place: string | null; needs_revoke: number; mail_sent_at: number | null; mail_count: number; attempts: number;
  next_attempt_at: number; ready_mail_sent_at: number | null; cancel_until: number; removed_count: number; also_removed_at: number | null; removed_mail_at: number | null;
}
export const JOIN_COLS = "id,account_id,email,home_id,generation,kind,tier,state,created_at,hold_until,ready_at,used_at,ended_at,ended_by,yes_at,redeemed_bind,last_ticket_exp,place,needs_revoke,mail_sent_at,mail_count,attempts,next_attempt_at,ready_mail_sent_at,cancel_until,removed_count,also_removed_at,removed_mail_at";

export const maskEmail = (e: string): string => { const [l, d] = e.split("@"); return `${l?.[0] ?? ""}***@${d ?? ""}`; };
const siteOrigin = (env: Env) => (env as unknown as { SITE_ORIGIN?: string }).SITE_ORIGIN ?? "https://murage.ai";

// --- tiers -------------------------------------------------------------------------------------------------------------------------

/** A used row in any generation makes the home "later" for good (a restore or Reset cannot turn a later computer back into a first one). */
export async function hasUsedRow(db: D1Database, homeId: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM cloud_device_joins WHERE home_id=? AND state='used' LIMIT 1").bind(homeId).first()) !== null;
}
export const liveLaterJoin = (db: D1Database, homeId: string) =>
  db.prepare(`SELECT ${JOIN_COLS} FROM cloud_device_joins WHERE home_id=? AND tier='later' AND state IN ('waiting','ready')`).bind(homeId).first<JoinRow>();
const joinById = (db: D1Database, id: string) => db.prepare(`SELECT ${JOIN_COLS} FROM cloud_device_joins WHERE id=?`).bind(id).first<JoinRow>();

/** A door call that read history "had" writes one used row when none exists, so homes from before this shipped are covered. */
export async function noteHomeHadComputer(db: D1Database, accountId: string, email: string, homeId: string, generation: number, now: number): Promise<void> {
  await db.prepare(`INSERT INTO cloud_device_joins (id,account_id,email,home_id,generation,kind,tier,state,created_at,used_at)
    SELECT ?,?,?,?,?,'desktop','first','used',?,? WHERE NOT EXISTS (SELECT 1 FROM cloud_device_joins WHERE home_id=? AND state='used')`)
    .bind(crypto.randomUUID(), accountId, email, homeId, generation, now, now, homeId).run();
}

/** Moves a ticketed first row to used when the device list shows an active full-scope device with one of its ticket binds, to ended when no
 *  such device appeared after the last ticket's expiry plus skew. `devices`: the list the caller already read. */
export async function settleFirstRows(db: D1Database, homeId: string, devices: { scope: string; bind: string | null }[], now: number): Promise<void> {
  const rows = (await db.prepare(`SELECT id, created_at FROM cloud_device_joins WHERE home_id=? AND tier='first' AND state='ticketed'`).bind(homeId)
    .all<{ id: string; created_at: number }>()).results;
  for (const r of rows) {
    const binds = (await db.prepare("SELECT bind FROM cloud_door_desktop_tickets WHERE home_id=? AND issued_at>=?").bind(homeId, r.created_at).all<{ bind: string }>()).results.map((t) => t.bind);
    const hit = devices.find((d) => d.scope !== "browser" && d.bind !== null && binds.includes(d.bind));
    if (hit) await db.prepare("UPDATE cloud_device_joins SET state='used', used_at=?, redeemed_bind=? WHERE id=? AND state='ticketed'").bind(now, hit.bind, r.id).run();
    else await db.prepare(`UPDATE cloud_device_joins SET state='ended', ended_at=?, ended_by='lapse' WHERE id=? AND state='ticketed' AND last_ticket_exp+?<?`)
      .bind(now, r.id, SKEW_MS, now).run();
  }
}

// --- the hand-out batch ------------------------------------------------------------------------------------------------------------

export interface TicketRecord { homeId: string; accountId: string; email: string; generation: number; bind: string; nonce: string; issuedAt: number; expiresAt: number;
  tier: "first" | "later" | "hold"; joinId: string | null }
/** Statements for the hand-out batch of a ticket that can enroll a NEW key: the ticket row (kept past the latest cancellation link), and for a
 *  first ticket the ticketed row. A later ticket updates its join (redeemed_bind, last_ticket_exp, ticket nonce) only while it is still ready. */
export function ticketStatements(db: D1Database, t: TicketRecord): D1PreparedStatement[] {
  const retain = Math.max(t.expiresAt + SKEW_MS + 15 * DAY, 0);
  const out = [db.prepare(`INSERT OR REPLACE INTO cloud_door_desktop_tickets (home_id,bind,nonce,join_id,issued_at,expires_at,retain_until) VALUES (?,?,?,?,?,?,?)`)
    .bind(t.homeId, t.bind, t.nonce, t.joinId, t.issuedAt, t.expiresAt, retain)];
  if (t.tier === "first") {
    out.push(db.prepare(`INSERT INTO cloud_device_joins (id,account_id,email,home_id,generation,kind,tier,state,created_at,redeemed_bind,last_ticket_exp,ticket_nonce)
      SELECT ?,?,?,?,?,'desktop','first','ticketed',?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM cloud_device_joins WHERE home_id=? AND state='used')
      ON CONFLICT (home_id) WHERE tier='first' AND state='ticketed' DO UPDATE SET redeemed_bind=excluded.redeemed_bind, last_ticket_exp=excluded.last_ticket_exp,
        ticket_nonce=excluded.ticket_nonce`).bind(crypto.randomUUID(), t.accountId, t.email, t.homeId, t.generation, t.issuedAt, t.bind, t.expiresAt, t.nonce, t.homeId));
  } else if (t.tier === "later" && t.joinId) {
    out.push(db.prepare(`UPDATE cloud_device_joins SET redeemed_bind=?, last_ticket_exp=?, ticket_nonce=? WHERE id=? AND state IN ('ready','used') AND needs_revoke=0 AND ended_at IS NULL`).bind(t.bind, t.expiresAt, t.nonce, t.joinId));
  }
  return out;
}
/** A guard statement (cloud_write_guards ok=0 aborts the whole batch) that is 1 only while this later join is still ready: a No before the
 *  final hand-out step wins and no ticket leaves. */
export function joinStillReadyGuard(db: D1Database, joinId: string): D1PreparedStatement[] {
  const g = crypto.randomUUID();
  return [db.prepare("INSERT INTO cloud_write_guards VALUES (?,(SELECT COUNT(*) FROM cloud_device_joins WHERE id=? AND state IN ('ready','used') AND needs_revoke=0 AND ended_at IS NULL))").bind(g, joinId),
    db.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(g)];
}
/** The guard of every OTHER new-key hand-out (first computer, customer hold) and the watermark of a join ticket too: the batch aborts when a No or
 *  Remove moved the home's join_cancel_at after the door read it (`mark`), when a first ticket's home has had a used computer since, or when the
 *  hold this ticket reserved was cancelled or spent meanwhile. */
export function handoutGuard(db: D1Database, a: { homeId: string; mark: number; mode: "first" | "hold" | "join"; holdId: string | null }): D1PreparedStatement[] {
  const g = crypto.randomUUID();
  const ok = [`COALESCE((SELECT join_cancel_at FROM cloud_homes WHERE id=?),0)=?`, ...(a.mode === "first" ? [`NOT EXISTS (SELECT 1 FROM cloud_device_joins WHERE home_id=? AND state='used')`] : []),
    ...(a.mode === "hold" && a.holdId ? [`EXISTS (SELECT 1 FROM cloud_recovery_holds WHERE id=? AND canceled_at IS NULL AND spent_device_digest IS NULL)`] : [])].join(" AND ");
  const binds = [a.homeId, a.mark, ...(a.mode === "first" ? [a.homeId] : []), ...(a.mode === "hold" && a.holdId ? [a.holdId] : [])];
  return [db.prepare(`INSERT INTO cloud_write_guards VALUES (?,CASE WHEN ${ok} THEN 1 ELSE 0 END)`).bind(g, ...binds), db.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(g)];
}
/** A ticket for the join was handed out: ready becomes used (the same key may be handed the same result again by doorReplay, r8-2). */
export const markJoinUsed = (db: D1Database, joinId: string, now: number) =>
  db.prepare("UPDATE cloud_device_joins SET state='used', used_at=? WHERE id=? AND state='ready'").bind(now, joinId);

/** The join_cancel_at mark: a new join, first ticket or customer hold spend needs a second step newer than it (plus skew). */
export async function cancelMark(db: D1Database, homeId: string): Promise<number> {
  return (await db.prepare("SELECT join_cancel_at AS at FROM cloud_homes WHERE id=?").bind(homeId).first<{ at: number | null }>())?.at ?? 0;
}

// --- mail --------------------------------------------------------------------------------------------------------------------------

const htmlOf = (text: string) => `<!doctype html><html><body>${text.split("\n\n").map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("")}</body></html>`;
async function deliver(env: Env, deps: DoorDependencies, accountId: string, subject: string, text: string): Promise<void> {
  const to = await reconciledContactEmail(env.DB, accountId, Date.now(), readerUser(env, deps));
  if (!to) throw new Error("undeliverable");
  await (deps.emailSender?.(env) ?? senderOrFail(env)).send({ to, from: { email: env.EMAIL_FROM, name: "Murage" }, subject, text, html: htmlOf(text) });
}
const whereLine = (j: JoinRow, now: number) => `${j.place ? `Where: ${j.place}. ` : ""}When: ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC.`;

/** One more join email may go out (3 an hour, 10 a day per home, their own budget apart from the notice slots). */
export async function takeJoinMail(db: D1Database, homeId: string, now: number): Promise<boolean> {
  const r = await db.prepare(`INSERT INTO cloud_device_join_mail (home_id,at,n) SELECT ?,?,? WHERE
    (SELECT COUNT(*) FROM cloud_device_join_mail WHERE home_id=? AND at>?)<? AND (SELECT COUNT(*) FROM cloud_device_join_mail WHERE home_id=? AND at>?)<?`)
    .bind(homeId, now, Math.floor(Math.random() * 1e9), homeId, now - HOUR, JOIN_MAIL_PER_HOUR, homeId, now - DAY, JOIN_MAIL_PER_DAY).run();
  return r.meta.changes === 1;
}
async function link(env: Env, deps: TokenDeps, j: JoinRow, purpose: TokenPurpose, path: string, ttlMs: number, now: number): Promise<string> {
  // Each send attempt gets a subject id nobody has used (a fresh random one, never derived from a counter that advances only after delivery),
  // so a retry after a delivered mail never replaces a No link already out; all resolve to the same join (the part before the colon).
  const t = await issueToken(env, deps, { purpose, subjectKind: "device_join", subjectId: `${j.id}:${crypto.randomUUID()}`, accountId: j.account_id, accountEmail: j.email,
    supabaseUpdatedAt: DEVICE_JOIN_EMAIL_GEN, receivedAt: now }, { ttlMs });
  if (!t) throw new Error("token");
  return `${siteOrigin(env)}/device-check/${path}#${t.token}`;
}

/** The connection email of a first computer: where, when, and a one-press Remove. Never counted against the join budget. Never throws.
 *  `retry` (the sweep): takes over a claim row whose mail never went out, at most once per backoff step, only while the row can still be removed. */
export async function sendConnectionMail(env: Env, deps: DoorDependencies, homeId: string, nonce: string, now = Date.now(), retry = false): Promise<boolean> {
  try {
    const j = await env.DB.prepare(`SELECT ${JOIN_COLS} FROM cloud_device_joins WHERE home_id=? AND tier='first' AND ticket_nonce=?`).bind(homeId, nonce).first<JoinRow>();
    if (!j) return false;
    if (retry) {
      if (j.state === "ended" || j.needs_revoke === 1) return false;
      const lease = await env.DB.prepare("UPDATE cloud_device_joins SET attempts=attempts+1, next_attempt_at=? WHERE id=? AND next_attempt_at<=? AND tier='first' AND ticket_nonce=?")
        .bind(now + RETRY_MS * 2 ** Math.min(j.attempts, 6), j.id, now, nonce).run();
      if (lease.meta.changes !== 1) return false;
      const open = await env.DB.prepare("SELECT 1 AS x FROM door_computer_notices WHERE home_id=? AND ticket_nonce=? AND sent_at IS NULL").bind(homeId, nonce).first();
      if (!open) return false;
    } else {
      const claimed = await env.DB.prepare("INSERT OR IGNORE INTO door_computer_notices (home_id,ticket_nonce,created_at) VALUES (?,?,?)").bind(homeId, nonce, now).run();
      if (claimed.meta.changes !== 1) return false;
    }
    const remove = await link(env, deps, j, "repudiate", "remove", JOIN_CANCEL_LINK_MS, now);
    const text = `A computer was connected to your Murage home.\n\n${whereLine(j, now)}\n\nIf this was you, there is nothing to do.\n\nNot you? Remove it: ${remove}\nSee my devices: ${siteOrigin(env)}/home/cloud`;
    await deliver(env, deps, j.account_id, "A computer was connected to your Murage home", text);
    await env.DB.prepare("UPDATE door_computer_notices SET sent_at=? WHERE home_id=? AND ticket_nonce=?").bind(now, homeId, nonce).run();
    await env.DB.prepare("UPDATE cloud_device_joins SET mail_count=mail_count+1, cancel_until=MAX(cancel_until,?) WHERE id=?").bind(now + JOIN_CANCEL_LINK_MS, j.id).run();
    return true;
  } catch { console.error(JSON.stringify({ message: "first computer mail failed", homeId })); return false; }
}

/** The later-join email (Yes and No). The hold clock starts at the first successful send (mail_sent_at). Returns false when it did not go out. */
export async function sendJoinMail(env: Env, deps: DoorDependencies, id: string, now = Date.now()): Promise<boolean> {
  const j = await joinById(env.DB, id);
  if (!j || j.tier !== "later" || j.state !== "waiting") return false;
  const claim = crypto.randomUUID();
  const took = await env.DB.prepare("UPDATE cloud_device_joins SET claim_id=?, next_attempt_at=? WHERE id=? AND state='waiting' AND next_attempt_at<=?").bind(claim, now + 10 * 60_000, id, now).run();
  if (took.meta.changes !== 1) return false;
  try {
    if (!await takeJoinMail(env.DB, j.home_id, now)) { await env.DB.prepare("UPDATE cloud_device_joins SET next_attempt_at=? WHERE id=? AND claim_id=?").bind(now + HOUR, id, claim).run(); return false; }
    const holdEnd = j.mail_sent_at === null ? now + JOIN_HOLD_MS : (j.hold_until ?? now + JOIN_HOLD_MS);
    const yes = await link(env, deps, j, "confirm", "yes", Math.max(holdEnd - now, 1), now);
    const no = await link(env, deps, j, "repudiate", "no", JOIN_CANCEL_LINK_MS, now);
    const text = `A computer just asked to join your Murage Cloud.\n\n${whereLine(j, now)}\n\nWas this you?\nYes, this was me: ${yes}\nNo, stop it: ${no}\n\n`
      + "Yes starts a 1-hour wait, then you can connect.\nIf you do nothing, it can join after 72 hours, unless you press No.\nIf you did not ask for this, press No. Nobody can join while you decide.";
    await deliver(env, deps, j.account_id, "A new computer is joining your Murage Cloud", text);
    await env.DB.prepare(`UPDATE cloud_device_joins SET mail_sent_at=COALESCE(mail_sent_at,?), hold_until=CASE WHEN mail_sent_at IS NULL THEN ? ELSE hold_until END,
      mail_count=mail_count+1, attempts=0, next_attempt_at=?, cancel_until=MAX(cancel_until,?) WHERE id=? AND state='waiting'`).bind(now, now + JOIN_HOLD_MS, now, now + JOIN_CANCEL_LINK_MS, id).run();
    return true;
  } catch {
    console.error(JSON.stringify({ message: "device join mail failed", homeId: j.home_id }));
    await env.DB.prepare("UPDATE cloud_device_joins SET attempts=attempts+1, next_attempt_at=? WHERE id=? AND claim_id=?").bind(now + RETRY_MS * 2 ** Math.min(j.attempts, 6), id, claim).run().catch(() => {});
    return false;
  }
}

// --- joins -------------------------------------------------------------------------------------------------------------------------

/** The one live later join of the home, created if there is none. Holds no key. The caller has already decided this is a later computer and
 *  has checked join_cancel_at against the second step. Returns the join and whether this call created it (so the caller sends its mail). */
export async function ensureLaterJoin(env: Env, a: { accountId: string; email: string; homeId: string; generation: number; kind: "desktop" | "phone"; place: string | null }, now: number)
  : Promise<{ join: JoinRow; created: boolean }> {
  const live = await liveLaterJoin(env.DB, a.homeId);
  if (live && live.generation === a.generation) return { join: live, created: false };
  const id = crypto.randomUUID();
  if (live) await env.DB.prepare("UPDATE cloud_device_joins SET state='lapsed', ended_at=?, ended_by='lapse' WHERE id=? AND state IN ('waiting','ready')").bind(now, live.id).run();
  const r = await env.DB.prepare(`INSERT INTO cloud_device_joins (id,account_id,email,home_id,generation,kind,tier,state,created_at,place,next_attempt_at)
    VALUES (?,?,?,?,?,?,'later','waiting',?,?,0)`).bind(id, a.accountId, a.email, a.homeId, a.generation, a.kind, now, a.place).run().catch(() => null);
  if (!r) return { join: (await liveLaterJoin(env.DB, a.homeId))!, created: false };
  return { join: (await joinById(env.DB, id))!, created: true };
}
/** What the Connect page shows: the live join of the home, unless this bind is already a known key (the caller checks that). */
export function joinView(j: JoinRow) {
  return { joinId: j.id, state: j.state, holdUntil: j.hold_until, mailedTo: maskEmail(j.email) };
}

// --- cancel ------------------------------------------------------------------------------------------------------------------------

/** The statements of a No or Remove (each conditioned on the token's consume when `when` is given). The join stops (a first row that was
 *  ticketed becomes used: the home has now had a computer), the home's join_cancel_at is stamped, pair holds that started after the join was
 *  created are cancelled (an older customer hold keeps running), and needs_revoke stays set (and ended_at is set, so a replayed No or owner retry after the sweep cleared needs_revoke matches nothing and moves no watermark) so the sweep removes every key a ticket issued
 *  between the join's created_at and now could have enrolled (r8-3: never one issued before). */
export function cancelStatements(j: JoinRow, by: "link" | "my_cloud", now: number, when?: readonly [string, ...unknown[]]): Q[] {
  const w = when ? ` AND ${when[0]}` : "";
  const wb = when ? when.slice(1) : [];
  const set = j.tier === "first"
    ? `state='used', used_at=COALESCE(used_at,?), ended_at=?, ended_by=?, needs_revoke=1 WHERE id=? AND state IN ('ticketed','used') AND needs_revoke=0 AND ended_at IS NULL`
    : `state=CASE WHEN state IN ('waiting','ready') THEN 'cancelled' ELSE state END, ended_at=?, ended_by=?, needs_revoke=1 WHERE id=? AND (state IN ('waiting','ready') OR (state='used' AND needs_revoke=0 AND ended_at IS NULL))`;
  const binds = j.tier === "first" ? [now, now, by, j.id] : [now, by, j.id];
  return [
    [`UPDATE cloud_device_joins SET ${set}${w}`, [...binds, ...wb]],
    [`UPDATE cloud_homes SET join_cancel_at=? WHERE id=? AND changes()=1${w}`, [now, j.home_id, ...wb]],
    [`UPDATE cloud_recovery_holds SET canceled_at=?, canceled_by='device_join' WHERE home_id=? AND action='pair' AND canceled_at IS NULL
      AND spent_device_digest IS NULL AND started_at>=? AND changes()=1${w}`, [now, j.home_id, j.created_at, ...wb]],
  ];
}
/** Cancel from My Cloud (sign-in only, the account's own join). */
export async function cancelJoin(env: Env, accountId: string, homeId: string, joinId: string, now: number): Promise<boolean> {
  const j = await joinById(env.DB, joinId);
  if (!j || j.home_id !== homeId || j.account_id !== accountId) return false;
  const res = await env.DB.batch(cancelStatements(j, "my_cloud", now).map(([sql, b]) => env.DB.prepare(sql).bind(...(b ?? []))));
  return res[0].meta.changes === 1;
}

/** The keys a No reaches: every ticket row issued between the join's created_at and its end (both live sets of the design are inside this one),
 *  never one issued before the join (r8-3), plus the key that already joined. */
export async function revokeBinds(db: D1Database, j: JoinRow, end: number): Promise<Set<string>> {
  const binds = new Set((await db.prepare("SELECT bind FROM cloud_door_desktop_tickets WHERE home_id=? AND issued_at>=? AND issued_at<=?").bind(j.home_id, j.created_at, end + TICKET_TTL_MS).all<{ bind: string }>()).results.map((r) => r.bind));
  if (j.redeemed_bind && (j.state === "used" || j.tier === "first")) binds.add(j.redeemed_bind);
  return binds;
}
/** Revokes every key a cancelled join could have let in. Never throws; true when the pass completed. What it removed is recorded on the row
 *  (removed_count, also_removed_at: the newest computer that is not the join's own key, added while the request stood) for the removed email. */
async function runRevoke(env: Env, deps: DoorDependencies, j: JoinRow, now: number): Promise<boolean> {
  try {
    const account = { id: j.account_id, email: j.email };
    const end = j.ended_at ?? now;
    const binds = await revokeBinds(env.DB, j, end);
    const list = await listHomeDevices(env, j.home_id, account, { homeFetch: deps.homeFetch, keyWrapper: deps.keyWrapper });
    let removed = 0;
    let also: number | null = null;
    const record = () => removed === 0 ? Promise.resolve() : env.DB.prepare("UPDATE cloud_device_joins SET removed_count=removed_count+?, also_removed_at=MAX(COALESCE(also_removed_at,0),?) WHERE id=?")
      .bind(removed, also ?? 0, j.id).run().then(() => undefined);
    for (const d of list.devices) {
      if (d.scope === "browser" || d.bind === null || !binds.has(d.bind)) continue;
      const res = await homeManagementCall(env, j.home_id, account, HOME_DEVICES_REVOKE, { deviceId: d.id }, { homeFetch: deps.homeFetch, keyWrapper: deps.keyWrapper });
      if (res.status !== 200) { await record(); return false; }
      removed++;
      if (d.bind !== j.redeemed_bind) also = Math.max(also ?? 0, d.addedAt);
    }
    await record();
    return true;
  } catch { return false; }
}
/** "That computer is off your Cloud", once per join, after a revoke removed something (retried by the sweep while the send keeps failing). */
export async function sendRemovedMail(env: Env, deps: DoorDependencies, id: string, now = Date.now()): Promise<boolean> {
  const j = await joinById(env.DB, id);
  if (!j || j.removed_count < 1 || j.removed_mail_at !== null) return false;
  const took = await env.DB.prepare("UPDATE cloud_device_joins SET removed_mail_at=? WHERE id=? AND removed_mail_at IS NULL").bind(now, id).run();
  if (took.meta.changes !== 1) return false;
  try {
    const also = j.also_removed_at ? `\n\nWe also removed a computer that joined after that request, on ${new Date(j.also_removed_at).toISOString().slice(0, 10)}. If it was yours, press Connect on it to add it again.` : "";
    await deliver(env, deps, j.account_id, "That computer is off your Cloud",
      `Stopped and removed. That computer is off your Cloud. Please change your password.${also}\n\nSee my devices: ${siteOrigin(env)}/home/cloud`);
    return true;
  } catch {
    console.error(JSON.stringify({ message: "device removed mail failed", homeId: j.home_id }));
    await env.DB.prepare("UPDATE cloud_device_joins SET removed_mail_at=NULL WHERE id=?").bind(id).run().catch(() => {});
    return false;
  }
}
export const revokeJoinNow = (env: Env, deps: DoorDependencies, j: JoinRow, now = Date.now()) => runRevoke(env, deps, j, now);

// --- owner routes (sign-in only) ---------------------------------------------------------------------------------------------------

/** What My Cloud's holds list shows for the home: the live later join (waiting or ready) and a stopped one whose keys are still being removed. */
export async function joinHoldsView(db: D1Database, homeId: string, now: number) {
  const cols = JOIN_COLS.split(",").map((c) => `j.${c}`).join(",");
  const rows = (await db.prepare(`SELECT ${cols} FROM cloud_homes h JOIN cloud_device_joins j ON j.home_id=h.id WHERE h.id=? AND j.tier='later'
    AND ((j.state IN ('waiting','ready') AND j.generation=h.generation) OR j.needs_revoke=1) ORDER BY j.created_at`).bind(homeId).all<JoinRow>()).results;
  return rows.map((j) => ({ holdId: j.id, action: "pair", startedAt: j.mail_sent_at ?? j.created_at, completesAt: j.hold_until ?? (j.mail_sent_at ?? now) + JOIN_HOLD_MS,
    source: "device_join", state: j.needs_revoke === 1 && !["waiting", "ready"].includes(j.state) ? "stopping" as const : j.state === "ready" ? "ready" as const : "waiting" as const,
    mailedTo: maskEmail(j.email), ...(j.state === "ready" && j.ready_at !== null ? { readyUntil: j.ready_at + JOIN_READY_MS } : {}) }));
}

/** GET /v1/homes/:id/joins?bind=, POST .../joins/:joinId/resend and .../cancel. Owner only, sign-in only (never step-up gated). Inert (404)
 *  unless DOOR_JOIN_REQUIRED is "1". */
export async function deviceJoinOwnerRoute(request: Request, env: Env, identity: Identity, deps: DoorDependencies = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const list = JOINS_ROUTE.exec(path);
  const act = list ? null : JOIN_ACTION_ROUTE.exec(path);
  if (!list && !act) return null;
  if (request.method !== (list ? "GET" : "POST")) throw new HTTPError(405, "method_not_allowed");
  if (!boundCustomer(request)) throw new HTTPError(404, "not_found");
  if (!joinRequired(env)) throw new HTTPError(404, "not_found");
  const session = await identity.customer(request);
  if (!session) throw new HTTPError(401, "unauthorized");
  const homeId = (list ?? act)![1];
  const now = identity.now();
  const limit = await takeLimit(env, session.user.id, list ? "joins_get" : act![3] === "resend" ? "joins_resend" : "devices_revoke", now);
  if (!limit.ok) { const r = errorResponse(429, "rate_limited"); r.headers.set("retry-after", String(limit.retryAfterSeconds)); return r; }
  const home = await env.DB.prepare("SELECT owner_id, generation FROM cloud_homes WHERE id=? AND desired_state NOT IN ('deleting','deleted')").bind(homeId).first<{ owner_id: string; generation: number }>();
  if (!home || home.owner_id !== session.user.id) throw new HTTPError(404, "not_found");
  const account = { id: session.user.id, email: session.user.email };
  if (list) {
    const bind = new URL(request.url).searchParams.get("bind");
    if (bind !== null && !/^[0-9a-f]{64}$/.test(bind)) throw new HTTPError(400, "invalid_request");
    const j = await liveLaterJoin(env.DB, homeId);
    let res: Response;
    if (!j || j.generation !== home.generation) res = json({});
    else {
      let known = false;
      if (bind !== null) {
        try { known = (await listHomeDevices(env, homeId, account, { homeFetch: deps.homeFetch, keyWrapper: deps.keyWrapper })).devices.some((d) => d.scope === "owner-desktop" && d.bind === bind); }
        catch { /* home down: show the join; the door decides on the press */ }
      }
      res = json(known ? {} : joinView(j));
    }
    res.headers.set("cache-control", "no-store");
    return res;
  }
  const j = await joinById(env.DB, act![2]);
  if (!j || j.home_id !== homeId || j.account_id !== session.user.id || j.tier !== "later") throw new HTTPError(404, "not_found");
  if (act![3] === "resend") {
    if (j.state !== "waiting") throw new HTTPError(409, "join_not_waiting");
    await env.DB.prepare("UPDATE cloud_device_joins SET next_attempt_at=0 WHERE id=? AND state='waiting'").bind(j.id).run();
    const sent = await sendJoinMail(env, deps, j.id, now);
    const res = json({ sent, ...joinView((await joinById(env.DB, j.id)) ?? j) });
    res.headers.set("cache-control", "no-store");
    return res;
  }
  const won = await cancelJoin(env, session.user.id, homeId, j.id, now);
  if (!won) throw new HTTPError(409, "join_not_waiting");
  const after = (await joinById(env.DB, j.id))!;
  const revoked = await runRevoke(env, deps, after, now);
  await sendRemovedMail(env, deps, after.id, now);
  return json({ state: revoked ? "removed" : "stopping" });
}

// --- public routes -----------------------------------------------------------------------------------------------------------------

const PUBLIC = /^\/v1\/public\/device-join\/(lookup|confirm|cancel)$/;
const bodySchema = z.strictObject({ selector: z.string().min(1).max(64), secret: z.string().min(1).max(128) });
const refusal = (code: string): Response => errorResponse(code === "identity_unavailable" ? 503 : code === "link_invalid" ? 404 : 410, code);

export async function deviceJoinPublicRoute(request: Request, env: Env, deps: TokenDeps): Promise<Response | null> {
  const m = PUBLIC.exec(new URL(request.url).pathname);
  if (!m) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  const parsed = bodySchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const { selector, secret } = parsed.data;
  const now = (deps.now ?? Date.now)();
  if (!await takeSlot(env, `dj:${selector}`, 30, 60_000, now)) throw new HTTPError(429, "rate_limited");
  const op = m[1];
  if (op === "lookup") {
    const p = await peekToken(env, deps, selector, secret);
    if (p.state === "refused" || p.row.subjectKind !== "device_join") return refusal("link_invalid");
    const j = await joinById(env.DB, p.row.subjectId.split(":")[0]);
    if (!j) return refusal("link_invalid");
    return json({ state: p.state, purpose: p.row.purpose, tier: j.tier, joinState: j.state, place: j.place, holdUntil: j.hold_until });
  }
  const purpose: TokenPurpose = op === "confirm" ? "confirm" : "repudiate";
  const v = await verifyToken(env, deps, selector, secret, purpose, undefined, { skipIdentity: purpose === "repudiate" });
  if (!v.ok) return refusal(v.code);
  if (v.row.subjectKind !== "device_join") return refusal("link_invalid");
  const j = await joinById(env.DB, v.row.subjectId.split(":")[0]);
  if (!j) return refusal("link_invalid");
  if (purpose === "confirm") {
    // Yes answers only for a later join that is still waiting.
    if (j.tier !== "later") return refusal("link_invalid");
    const guard = ["EXISTS (SELECT 1 FROM cloud_device_joins WHERE id=? AND state='waiting' AND tier='later' AND mail_sent_at IS NOT NULL)", j.id] as [string, ...unknown[]];
    const { won } = await commitToken(env, v, { now: deps.now, guard, extra: (x) => {
      const [w, ...wb] = whenConsumed(x);
      return [[`UPDATE cloud_device_joins SET yes_at=?, hold_until=MIN(COALESCE(hold_until,?),?) WHERE id=? AND state='waiting' AND ${w}`, [now, now + JOIN_YES_HOLD_MS, now + JOIN_YES_HOLD_MS, j.id, ...wb]]];
    } });
    if (!won) return refusal((await lostCommitRefusal(env, v, { now: deps.now })).code);
    return json({ state: "confirmed", holdUntil: Math.min(j.hold_until ?? now + JOIN_YES_HOLD_MS, now + JOIN_YES_HOLD_MS) });
  }
  const w = whenConsumed(v);
  const { won } = await commitToken(env, v, { now: deps.now, extra: () => cancelStatements(j, "link", now, w) });
  if (!won) return refusal((await lostCommitRefusal(env, v, { now: deps.now })).code);
  const after = (await joinById(env.DB, j.id))!;
  // Astra door r10: a No on a join already cancelled moved nothing, so it revokes nothing: its key may have come back through a newer join. A cancel
  // whose revoke is still owed stays with the sweep (needs_revoke).
  if ((after.ended_by === "link" || after.ended_by === "my_cloud") && after.ended_at !== now) return json({ state: "removed", tier: j.tier });
  const revoked = await runRevoke(env, {}, after, now);
  await sendRemovedMail(env, {}, after.id, now);
  return json({ state: revoked ? "removed" : "stopping", tier: j.tier });
}
registerPublicRoute((request, env, deps) => deviceJoinPublicRoute(request, env, deps));

// --- cron --------------------------------------------------------------------------------------------------------------------------

/** Cron, beside sweepDoorNotices: mail retries, Ready (+ its mail), lapse, first rows to used or ended, needs_revoke, ticket tidy. Inert
 *  unless the switch is on. Returns how many things it moved. */
export async function sweepDeviceJoins(env: Env, now = Date.now(), deps: DoorDependencies = {}): Promise<number> {
  if (!joinRequired(env)) return 0;
  let moved = 0;
  const db = env.DB;
  for (const r of (await db.prepare("SELECT id FROM cloud_device_joins WHERE tier='later' AND state='waiting' AND mail_sent_at IS NULL AND next_attempt_at<=? LIMIT 25").bind(now).all<{ id: string }>()).results)
    if (await sendJoinMail(env, deps, r.id, now)) moved++;
  // Lapse: another generation, or Ready unused for 7 days.
  moved += (await db.prepare(`UPDATE cloud_device_joins SET state='lapsed', ended_at=?, ended_by='lapse' WHERE tier='later' AND state IN ('waiting','ready')
    AND (generation<>(SELECT generation FROM cloud_homes WHERE id=cloud_device_joins.home_id) OR (state='ready' AND ready_at+?<=?))`).bind(now, JOIN_READY_MS, now).run()).meta.changes;
  // Ready: the hold ran out, only after a mail went out.
  const due = (await db.prepare("SELECT id FROM cloud_device_joins WHERE tier='later' AND state='waiting' AND mail_sent_at IS NOT NULL AND hold_until<=? LIMIT 25").bind(now).all<{ id: string }>()).results;
  for (const r of due) {
    const u = await db.prepare("UPDATE cloud_device_joins SET state='ready', ready_at=? WHERE id=? AND state='waiting'").bind(now, r.id).run();
    moved += u.meta.changes;
  }
  for (const r of (await db.prepare("SELECT id FROM cloud_device_joins WHERE tier='later' AND state='ready' AND ready_mail_sent_at IS NULL LIMIT 25").all<{ id: string }>()).results) {
    const j = (await joinById(db, r.id))!;
    try {
      const no = await link(env, deps, j, "repudiate", "no", JOIN_CANCEL_LINK_MS, now);
      await deliver(env, deps, j.account_id, "You can connect your computer now",
        `The wait is over. Open Murage on your computer and press Connect. This works for 7 days.\n\nNot you? Stop it: ${no}`);
      await db.prepare("UPDATE cloud_device_joins SET ready_mail_sent_at=?, mail_count=mail_count+1, cancel_until=MAX(cancel_until,?) WHERE id=?").bind(now, now + JOIN_CANCEL_LINK_MS, j.id).run();
      moved++;
    } catch { /* retried next pass */ }
  }
  // The first computer's connection mail that failed to go out is tried again (a day at most, backed off per row).
  for (const r of (await db.prepare(`SELECT n.home_id AS home_id, n.ticket_nonce AS nonce FROM door_computer_notices n
    JOIN cloud_device_joins j ON j.home_id=n.home_id AND j.tier='first' AND j.ticket_nonce=n.ticket_nonce AND j.state IN ('ticketed','used') AND j.needs_revoke=0
    WHERE n.sent_at IS NULL AND n.created_at>? AND j.next_attempt_at<=? LIMIT 25`).bind(now - DAY, now).all<{ home_id: string; nonce: string }>()).results)
    if (await sendConnectionMail(env, deps, r.home_id, r.nonce, now, true)) moved++;
  // First rows: used or ended from the device list (one call per home with a ticketed row).
  for (const r of (await db.prepare("SELECT DISTINCT home_id, account_id, email FROM cloud_device_joins WHERE tier='first' AND state='ticketed' LIMIT 25").all<{ home_id: string; account_id: string; email: string }>()).results) {
    try {
      const list = await listHomeDevices(env, r.home_id, { id: r.account_id, email: r.email }, { homeFetch: deps.homeFetch, keyWrapper: deps.keyWrapper });
      await settleFirstRows(db, r.home_id, list.devices, now);
      moved++;
    } catch { /* home down: next pass */ }
  }
  // needs_revoke stays set until the last ticket's life, skew and a cron period have passed, even when the first look found nothing.
  for (const r of (await db.prepare("SELECT id FROM cloud_device_joins WHERE needs_revoke=1 LIMIT 25").all<{ id: string }>()).results) {
    const j = (await joinById(db, r.id))!;
    if (await runRevoke(env, deps, j, now) && now > (j.ended_at ?? now) + REVOKE_TAIL_MS) {
      await db.prepare("UPDATE cloud_device_joins SET needs_revoke=0 WHERE id=?").bind(j.id).run();
      moved++;
    }
  }
  // The removed email, once per join, for every revoke that took something off (retried while the send fails).
  for (const r of (await db.prepare("SELECT id FROM cloud_device_joins WHERE removed_count>0 AND removed_mail_at IS NULL LIMIT 25").all<{ id: string }>()).results)
    if (await sendRemovedMail(env, deps, r.id, now)) moved++;
  // Tidy: ticket rows only past retain_until AND past the latest cancellation link of their home's joins (r8-1).
  await db.prepare(`DELETE FROM cloud_door_desktop_tickets WHERE retain_until<? AND NOT EXISTS (SELECT 1 FROM cloud_device_joins j WHERE j.home_id=cloud_door_desktop_tickets.home_id AND j.cancel_until>?)`)
    .bind(now, now).run().catch(() => {});
  await db.prepare("DELETE FROM cloud_device_join_mail WHERE at<?").bind(now - 2 * DAY).run().catch(() => {});
  return moved;
}
