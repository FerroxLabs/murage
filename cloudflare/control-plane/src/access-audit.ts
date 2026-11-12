// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud token custody G2. Ferrox holds the key to every home's disk (AWS KMS wraps it; cloud-machines.ts unwrap), and the provider
// account can open rescue mode or a console on a home's server. Neither can be made impossible, so both are made VISIBLE: every use is
// written to cloud_access_events before it proceeds (fail closed: no audit row, no key), and the owner gets an email in plain words.
import { FIRST_SETUP_WINDOW_MS, accessEventStatement, recordAccessEvent, type AccessKind } from "./access-events";
import { senderOrFail } from "./email";
import { reconciledContactEmail } from "./cloud-accounts";
import { readerUser, type DoorDependencies } from "./door";
import { persistAlert, subjectAlertStatements } from "./ops-monitor";
import { PROVIDER_ACTION_UNEXPECTED_ALERT } from "./alert-tiers";
import type { HostingAdapter } from "./b5-provisioner";
import { hetznerAdapter } from "./b5-provisioner";
import { provisionerConfig } from "./b5-config";

/**
 * Only a disk-key unlock that follows that home's OWN boot or start is routine, and routine unlocks go out as one digest a day per home.
 * The boot signal the control plane records: an owner-initiated power action (a cloud_home_jobs row of kind 'power' whose provider answer is known, so not one still 'uncertain'; written before the
 * provider call; reboot or start; one started by the watchdog or an operator never counts) and a server create (a cloud_resource_dispatch_calls row of role 'server', for the first boot). An
 * unlock counts as routine when one of those for the SAME home started within BOOT_MATCH_WINDOW_MS before it (BOOT_CLOCK_SKEW_MS of
 * slack after it, for clock difference). Every other event, and any unlock with no such boot, is sent at the next sweep.
 */
export const BOOT_MATCH_WINDOW_MS = 10 * 60_000;
export const BOOT_CLOCK_SKEW_MS = 60_000;
const ROUTINE_PACE_MS = 24 * 3_600_000;
/** An unlock that never reported its outcome (the Worker died between the audit write and the answer) is closed as interrupted. */
const OUTCOME_GRACE_MS = 5 * 60_000;
const CLAIM_MS = 10 * 60_000;
export const ACCESS_EVENT_RETENTION_MS = 400 * 86_400_000;
const NOTICE_BATCH = 20;

// ---- the owner's words -------------------------------------------------------------------------------------------------------------

const ACTOR_WORDS: Record<string, string> = {
  home: "your home's own server",
  operator: "Murage support",
  system: "Murage support",
  owner: "you",
  provider_account: "your hosting provider's account",
};
/** The one line a routine unlock gets. Word for word; do not edit without the owner copy ruling. */
export const ROUTINE_LINE = "Your home unlocked its disk when it started. This happens every time it starts.";
export const ACTION_LINE = "If you didn't expect this, reply to this email and we'll look into it.";
const INTRO = "We keep the key that unlocks your home's disk, so we tell you when it is used and when someone works on the server itself.";
const EVENT_WORDS: Record<AccessKind, string> = {
  disk_key_unlock: "Your home's disk was unlocked, and we did not see your home start just before.",
  backup_key_use: "The key for your home's backups was used.",
  key_reseal: "Your home's keys were re-encrypted with our key service.",
  provider_rescue: "Rescue mode, or a different start-up disk, was switched on for your home's server. Whoever does that can read the server's disk.",
  provider_console: "A console was opened on your home's server. A console is a screen and keyboard on the server itself.",
  provider_password_reset: "The administrator password of your home's server was reset.",
  provider_snapshot: "A snapshot of your home's server was taken at the hosting company. A snapshot is a full copy of the server's disk.",
  provider_backup: "Automatic server backups were switched on for your home's server at the hosting company. A backup is a full copy of the server's disk.",
  provider_rebuild: "Your home's server was rebuilt from a different image at the hosting company.",
  pairing_key_use: "The key that lets your home recognise a new device was used when a device was connected to your home.",
  export_key_use: "The key for your data export was used when you asked to download it.",
  provision_token_use: "The one-time token that sets up your new home's server was read while the server was being prepared.",
  plan_change_power: "Your home's server was switched off, resized or restarted at the hosting company.",
  provider_power: "Your home's server was started, restarted or switched off at the hosting company.",
  provider_untracked: "Your home runs on a hosting provider that keeps no record of actions taken on the server from the provider's side, such as opening a console or rescue mode. We cannot tell you if that happens there.",
};
/** The line for an action our own jobs took and recorded under the provider's id. Each says what we did, in plain words, and nothing about keys. */
const ROUTINE_WORDS: Partial<Record<AccessKind, string>> = {
  provider_snapshot: "We made a routine backup copy of your home.",
  provider_backup: "We switched on routine backup copies of your home's server.",
  provider_rebuild: "We rebuilt your home's server as part of routine work.",
  plan_change_power: "We restarted your home as part of a plan change.",
  provider_power: "We started or restarted your home's server as part of routine work.",
};
/** The line for a reboot or start the owner did themselves. */
const OWNER_POWER_WORDS = "You restarted your home.";
const OUTCOME_WORDS: Record<string, string> = { ok: "", failed: " It did not complete.", interrupted: " We could not confirm that it completed.", seen: "" };
/** The owner's local time is not recorded anywhere, so every time is UTC and says so. */
const when = (at: number) => new Date(at).toUTCString().replace("GMT", "UTC");
export const NOTICE_TEMPLATES = { OWNER_POWER_WORDS, ACTOR_WORDS, EVENT_WORDS, ROUTINE_WORDS, OUTCOME_WORDS, ROUTINE_LINE, ACTION_LINE, INTRO };

/** Key uses that are routine by their nature: they follow something the owner or the system just did, so they go out in the daily digest. */
const ROUTINE_KINDS: ReadonlySet<AccessKind> = new Set<AccessKind>(["pairing_key_use", "export_key_use", "provision_token_use"]);

/** A snapshot, backup or rebuild is routine only when one of our own jobs recorded the provider's id for it (recordOwnProviderAction gives
 *  that entry the job's actor). The sweep writes every other action as the provider account's, so it alerts at once. The watchdog's and an
 *  operator's actions never count. */
const OWN_PROVIDER_KINDS: ReadonlySet<AccessKind> = new Set<AccessKind>(["provider_snapshot", "provider_backup", "provider_rebuild", "plan_change_power", "provider_power"]);
const OWN_ACTORS: ReadonlySet<string> = new Set(["system", "owner"]);

/** The keys our own provisioner reads to set a new home up. Only with actor system, so an operator's backup password is never one of them. */
const SETUP_KINDS: ReadonlySet<AccessKind> = new Set<AccessKind>(["provision_token_use", "backup_key_use"]);

export interface NoticeEvent { kind: AccessKind; actor: string; at: number; outcome: string; routine?: boolean;
  /** Part of the home's own first setup, before it was first ready: the unlock of its first start, our setup token and backup key reads, and
   *  the owner's first device. The audit row stays; the owner is not emailed (the welcome email covers it). */
  firstStart?: boolean }

export function accessNoticeText(events: NoticeEvent[]): { subject: string; text: string } {
  const routine = events.filter((e) => e.routine);
  const rest = events.filter((e) => !e.routine);
  const routineOther = routine.filter((e) => e.kind !== "disk_key_unlock");
  const unlocked = routine.length > routineOther.length;
  // Our own actions say what we did, once per kind; a real key use keeps its own line and the keys subject.
  const ownRoutine = routineOther.filter((e) => OWN_PROVIDER_KINDS.has(e.kind));
  const keyRoutine = routineOther.filter((e) => !OWN_PROVIDER_KINDS.has(e.kind));
  const ownerPower = (e: NoticeEvent) => e.kind === "provider_power" && e.actor === "owner";
  const ownLines = [...new Map(ownRoutine.map((e) => [`${e.kind}:${ownerPower(e)}`, e])).values()].map((e) => `- ${when(e.at)}: ${ownerPower(e) ? OWNER_POWER_WORDS : (ROUTINE_WORDS[e.kind] ?? EVENT_WORDS[e.kind])}${OUTCOME_WORDS[e.outcome] ?? ""}`);
  const keyLines = keyRoutine.map((e) => `- ${when(e.at)}: ${EVENT_WORDS[e.kind]}${OUTCOME_WORDS[e.outcome] ?? ""}`);
  if (!rest.length && !routineOther.length) return { subject: "Murage Cloud: your home started", text: `${ROUTINE_LINE}\n` };
  if (!rest.length) {
    const subject = keyRoutine.length ? "Murage Cloud: your home's keys were used" : "Murage Cloud: routine work on your home";
    const lines = [...keyLines, ...ownLines];
    return { subject, text: `${subject}\n\n${keyRoutine.length ? `${INTRO}\n\n` : ""}${lines.join("\n")}\n\n${unlocked ? `${ROUTINE_LINE}\n\n` : ""}${ACTION_LINE}` };
  }
  const has = (f: (k: AccessKind) => boolean) => rest.some((e) => f(e.kind));
  const subject = has((k) => ["provider_rescue", "provider_console", "provider_password_reset", "provider_snapshot", "provider_backup", "provider_rebuild", "plan_change_power", "provider_power"].includes(k)) ? "Murage Cloud: someone worked on your home's server"
    : has((k) => k !== "provider_untracked") ? "Murage Cloud: your home's disk key was used"
    : "Murage Cloud: a note about where your home runs";
  const lines = rest.map((e) => `- ${when(e.at)}: ${EVENT_WORDS[e.kind]}${OUTCOME_WORDS[e.outcome] ?? ""}`
    + (e.kind === "provider_untracked" ? "" : ` Done by ${ACTOR_WORDS[e.actor] ?? "Murage support"}, as far as we know.`));
  const routineLines = [...keyLines, ...ownLines];
  const text = `${subject}\n\n${INTRO}\n\n${lines.join("\n")}\n\n${routineLines.length ? `${routineLines.join("\n")}\n\n` : ""}${unlocked ? `${ROUTINE_LINE}\n\n` : ""}${ACTION_LINE}`;
  return { subject, text };
}

/** Which of a home's unlocks followed its own boot or start (see BOOT_MATCH_WINDOW_MS). One read per home. */
async function markRoutine(db: D1Database, homeId: string, events: NoticeEvent[]): Promise<void> {
  for (const e of events) if (ROUTINE_KINDS.has(e.kind) || (OWN_PROVIDER_KINDS.has(e.kind) && OWN_ACTORS.has(e.actor))) e.routine = true;
  const unlocks = events.filter((e) => e.kind === "disk_key_unlock");
  const setup = events.filter((e) => SETUP_KINDS.has(e.kind) && e.actor === "system");
  const devices = events.filter((e) => e.kind === "pairing_key_use" && e.actor === "owner");
  const near = [...unlocks, ...setup];
  if (!near.length && !devices.length) return;
  const home = await db.prepare("SELECT ready_at FROM cloud_homes WHERE id=?").bind(homeId).first<{ ready_at: number | null }>();
  const readyAt = home?.ready_at ?? null;
  if (devices.length && readyAt !== null) {
    const earlier = await db.prepare("SELECT 1 AS seen FROM cloud_access_events WHERE home_id=? AND kind='pairing_key_use' AND notice_state<>'pending' LIMIT 1").bind(homeId).first();
    const first = devices.reduce((a, b) => (b.at < a.at ? b : a));
    if (!earlier && first.at <= readyAt + FIRST_SETUP_WINDOW_MS) first.firstStart = true;
  }
  if (!near.length) return;
  const lo = Math.min(...near.map((e) => e.at)) - BOOT_MATCH_WINDOW_MS;
  const hi = Math.max(...near.map((e) => e.at)) + BOOT_CLOCK_SKEW_MS;
  const boots = (await db.prepare(`SELECT j.created_at AS t, 0 AS first FROM cloud_home_jobs j WHERE j.home_id=?1 AND j.kind='power' AND j.state<>'failed' AND (COALESCE(j.outcome,'')<>'uncertain' OR j.action_id IS NOT NULL) AND j.created_at BETWEEN ?2 AND ?3
      AND NOT EXISTS (SELECT 1 FROM selfservice_audit a WHERE a.home_id=j.home_id AND a.actor IN ('watchdog','operator') AND a.action IN ('reboot','start')
        AND json_extract(a.detail,'$.reservation')=j.id)
    UNION ALL SELECT dispatched_at AS t, 1 AS first FROM cloud_resource_dispatch_calls WHERE home_id=?1 AND role='server' AND COALESCE(outcome,'') NOT IN ('failed','not_sent')
      AND dispatched_at BETWEEN ?2 AND ?3
    UNION ALL SELECT claimed_at AS t, 1 AS first FROM warm_pool WHERE home_id=?1 AND claimed_at BETWEEN ?2 AND ?3`).bind(homeId, lo, hi).all<{ t: number; first: number }>()).results;
  // A warm-pool claim powers on a server that already exists, so it leaves no power job and no server create: the claim stands in for the first boot.
  // A server created or claimed after the home was first ready is a replacement, not setup, so the owner still hears about it.
  for (const e of near) {
    const matched = boots.filter((b) => b.t >= e.at - BOOT_MATCH_WINDOW_MS && b.t <= e.at + BOOT_CLOCK_SKEW_MS);
    if (e.kind === "disk_key_unlock") e.routine = matched.length > 0;
    e.firstStart = matched.length > 0 && matched.every((b) => b.first === 1) && (readyAt === null || e.at <= readyAt);
  }
}

export interface AccessNoticeDependencies extends DoorDependencies { }

const backoff = (attempts: number) => Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** Math.min(attempts, 8));

/** Cron: sends the owner their owed access notices, one email per home per run. Never throws. Returns how many emails went out. */
export async function sweepAccessNotices(env: Env, nowMs = Date.now(), dependencies: AccessNoticeDependencies = {}): Promise<number> {
  const db = env.DB;
  try {
    await db.prepare("UPDATE cloud_access_events SET outcome='interrupted' WHERE outcome='requested' AND at<?").bind(nowMs - OUTCOME_GRACE_MS).run();
    await db.prepare(`UPDATE cloud_access_events SET notice_state='no_owner'
      WHERE notice_state='pending' AND NOT EXISTS (SELECT 1 FROM cloud_homes h WHERE h.id=cloud_access_events.home_id)`).run();
    await db.prepare("DELETE FROM cloud_access_events WHERE at<? AND kind<>'provider_untracked'").bind(nowMs - ACCESS_EVENT_RETENTION_MS).run();
  } catch { return 0; }
  const due = await db.prepare(`SELECT e.home_id AS home_id, h.owner_id AS owner_id FROM cloud_access_events e JOIN cloud_homes h ON h.id=e.home_id
    WHERE e.notice_state='pending' AND e.notice_next_at<=? AND e.outcome<>'requested' GROUP BY e.home_id ORDER BY MIN(e.notice_next_at) LIMIT ?`)
    .bind(nowMs, NOTICE_BATCH).all<{ home_id: string; owner_id: string }>();
  let sent = 0;
  const live = readerUser(env, dependencies);
  for (const row of due.results) {
    const claim = crypto.randomUUID();
    let events: (NoticeEvent & { attempts: number })[];
    try {
      events = (await db.prepare(`UPDATE cloud_access_events SET notice_claim=?, notice_next_at=?
        WHERE home_id=? AND notice_state='pending' AND notice_next_at<=? AND outcome<>'requested'
        RETURNING kind, actor, at, outcome, notice_attempts AS attempts`).bind(claim, nowMs + CLAIM_MS, row.home_id, nowMs)
        .all<NoticeEvent & { attempts: number }>()).results;
    } catch { continue; }
    if (!events.length) continue;
    events.sort((a, b) => a.at - b.at);
    try {
      try { await markRoutine(db, row.home_id, events); } catch { /* unknown: told at once, never held back */ }
      // A home's own first setup is not emailed: the welcome email covers it. The audit row stays, only its notice is closed.
      const first = events.filter((e) => e.firstStart);
      if (first.length) {
        await db.batch(first.map((e) => db.prepare(`UPDATE cloud_access_events SET notice_state='first_start' WHERE notice_claim=? AND notice_state='pending' AND kind=? AND at=?`)
          .bind(claim, e.kind, e.at)));
        events = events.filter((e) => !e.firstStart);
        if (!events.length) continue;
      }
      if (events.every((e) => e.routine)) {
        const last = await db.prepare("SELECT MAX(notice_sent_at) AS t FROM cloud_access_events WHERE home_id=? AND notice_state='sent'")
          .bind(row.home_id).first<{ t: number | null }>();
        if (last?.t && last.t > nowMs - ROUTINE_PACE_MS) {
          await db.prepare("UPDATE cloud_access_events SET notice_next_at=? WHERE notice_claim=? AND notice_state='pending'")
            .bind(last.t + ROUTINE_PACE_MS, claim).run();
          continue;
        }
      }
      const to = await reconciledContactEmail(db, row.owner_id, Date.now(), live);
      if (!to) throw new Error("notice_undeliverable");
      const { subject, text } = accessNoticeText(events);
      await (dependencies.emailSender?.(env) ?? senderOrFail(env)).send({ to, from: { email: env.EMAIL_FROM, name: "Murage" }, subject, text,
        html: `<!doctype html><html><body>${text.split("\n\n").map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("")}</body></html>` });
    } catch {
      console.error(JSON.stringify({ message: "access notice failed", homeId: row.home_id }));
      try {
        await db.prepare("UPDATE cloud_access_events SET notice_attempts=notice_attempts+1, notice_next_at=? WHERE notice_claim=? AND notice_state='pending'")
          .bind(Date.now() + backoff(Math.max(...events.map((e) => e.attempts))), claim).run();
      } catch { /* the claim runs out; the next sweep tries again */ }
      continue;
    }
    try {
      await db.prepare("UPDATE cloud_access_events SET notice_state='sent', notice_sent_at=? WHERE notice_claim=? AND notice_state='pending'")
        .bind(Date.now(), claim).run();
    } catch { /* sent but not recorded: at least once */ }
    sent++;
  }
  return sent;
}

// ---- provider rescue / console / password actions ----------------------------------------------------------------------------------

/** provider action commands that put someone in front of a home's disk, and what they are called to the owner. */
export const PROVIDER_ACCESS_COMMANDS: Record<string, { kind: AccessKind; reason: string }> = {
  enable_rescue: { kind: "provider_rescue", reason: "rescue mode switched on at the hosting company" },
  attach_iso: { kind: "provider_rescue", reason: "a different start-up disk attached at the hosting company" },
  request_console: { kind: "provider_console", reason: "console opened at the hosting company" },
  reset_password: { kind: "provider_password_reset", reason: "root password reset at the hosting company" },
  create_image: { kind: "provider_snapshot", reason: "snapshot of the server taken at the hosting company" },
  enable_backup: { kind: "provider_backup", reason: "automatic server backups switched on at the hosting company" },
  rebuild_server: { kind: "provider_rebuild", reason: "server rebuilt from a different image at the hosting company" },
};
/** Homes read per run, the time a run may spend, and how many are read side by side. The oldest-read homes go first, so a run that stops
 *  at its budget is continued by the next one. */
const PROVIDER_SWEEP_MAX = 450;
const PROVIDER_SWEEP_BUDGET_MS = 150_000;
const PROVIDER_SWEEP_PARALLEL = 5;
const REREAD_MS = 20 * 60_000;
/** An action that started up to this long before the last full read is still looked at again (provider and Worker clocks differ). */
const READ_OVERLAP_MS = 3_600_000;

export interface ProviderSweepDependencies { adapters?: { hetzner?: HostingAdapter | null; vultr?: HostingAdapter | null }; fetch?: typeof fetch }

/**
 * Cron: reads the provider's own action list for each live home's server and writes an audit entry for every rescue, console or password
 * action found (dedupe: the entry id is the provider's action id, so a re-read never doubles it). Rescue and console happen at the
 * provider, outside this Worker, so they cannot be blocked from here: the guarantee is that none is missed. An entry that fails to
 * write is retried by the next sweep (the action stays in the provider's list), and the home is not marked as read until its entries are
 * written. provider only: Vultr keeps no per-server action history, so a Vultr home is raised as an ops alert instead (access.unmonitored).
 */
export async function sweepProviderAccess(env: Env, nowMs = Date.now(), dependencies: ProviderSweepDependencies = {}): Promise<number> {
  let hetzner = dependencies.adapters?.hetzner ?? null;
  if (!dependencies.adapters && env.HCLOUD_TOKEN) {
    hetzner = hetznerAdapter(env.HCLOUD_TOKEN, provisionerConfig(env), dependencies.fetch);
  }
  const homes = await env.DB.prepare(`SELECT m.home_id AS home_id, m.server_id AS server_id, m.created_at AS since, COALESCE(c.checked_at,0) AS checked,
      (SELECT p.provider FROM provision_choices p WHERE p.home_id=m.home_id ORDER BY p.resource_generation DESC LIMIT 1) AS provider
    FROM cloud_machines m JOIN cloud_homes h ON h.id=m.home_id AND h.desired_state IN ('provisioning','checking','ready','payment_problem','suspended')
    LEFT JOIN cloud_access_cursor c ON c.home_id=m.home_id
    WHERE m.state='active' AND m.server_id IS NOT NULL AND COALESCE(c.checked_at,0)<?
    ORDER BY COALESCE(c.checked_at,0) LIMIT ?`).bind(nowMs - REREAD_MS, PROVIDER_SWEEP_MAX)
    .all<{ home_id: string; server_id: string; since: number; checked: number; provider: string | null }>();
  let recorded = 0;
  const started = Date.now();
  const readHome = async (home: (typeof homes.results)[number]) => {
    try {
      if (home.provider === "vultr") {
        await persistAlert(env, { homeId: home.home_id, kind: "access.unmonitored", severity: "high",
          detail: "this home is on Vultr, which keeps no per-server action history: rescue, console, snapshot, backup and rebuild use cannot be detected" }, nowMs);
        // The owner is told once. The event id is the dedupe flag (one per home, kept past the usual retention: see sweepAccessNotices).
        const flag = `untracked:${home.home_id}`;
        if (!await env.DB.prepare("SELECT 1 FROM cloud_access_events WHERE id=?").bind(flag).first()) {
          await recordAccessEvent(env.DB, { id: flag, homeId: home.home_id, kind: "provider_untracked", actor: "provider_account",
            reason: "home on a provider with no action history", at: nowMs, outcome: "seen" });
        }
      } else if (hetzner) {
        const native = home.server_id.replace(/^hs-/, "");
        if (!hetzner.listProviderActions) throw new Error("provider_actions_unreadable");
        const actions = await hetzner.listProviderActions(native, Math.max(home.since, home.checked - READ_OVERLAP_MS));
        for (const a of actions) {
          const hit = PROVIDER_ACCESS_COMMANDS[a.command];
          if (!hit) continue;
          // A start time that cannot be read is raised, and the action is still written (stamped with this read) rather than skipped.
          const timeKnown = Number.isFinite(a.startedAt);
          if (!timeKnown) {
            await persistAlert(env, { homeId: home.home_id, kind: "access.action_time_unreadable", severity: "high",
              detail: `the hosting provider gave an action (${a.command}) a start time that could not be read; it was recorded with the time of this read` }, nowMs);
          } else if (a.startedAt < home.since) continue;
          const id = `provider:${home.home_id}:${a.id}`;
          const done = await env.DB.prepare("SELECT 1 FROM cloud_access_events WHERE id=?").bind(id).first();
          if (done) continue;
          // The entry and its page commit in ONE batch: an entry written alone would make the next sweep skip it and lose the page.
          const entry = accessEventStatement(env.DB, { id, homeId: home.home_id, kind: hit.kind, actor: "provider_account", reason: hit.reason,
            at: timeKnown ? a.startedAt : nowMs, outcome: "seen" });
          // Rescue, console and password reset are never taken by this Worker: one seen at the provider is a possible account compromise
          // (a page, group account.compromise). Snapshot, backup and rebuild are our own routine actions and stay silent.
          const page = hit.kind === "provider_rescue" || hit.kind === "provider_console" || hit.kind === "provider_password_reset";
          // Each action has its OWN open alert (subject = the provider action id): a second action while the first page is open must not
          // be swallowed by the open-alert key, or its entry would commit and the next sweep would skip it unpaged.
          await env.DB.batch(page ? [entry, ...subjectAlertStatements(env.DB, { homeId: home.home_id, kind: PROVIDER_ACTION_UNEXPECTED_ALERT, severity: "high",
            detail: `${hit.reason} (${a.command}); this Worker did not do it`, subject: String(a.id), earlier: { noun: "provider action", verb: "was also seen" } },
            "1=1", [], nowMs)] : [entry]);
          recorded++;
        }
      } else return;
      await env.DB.prepare("INSERT INTO cloud_access_cursor (home_id,checked_at) VALUES (?,?) ON CONFLICT(home_id) DO UPDATE SET checked_at=excluded.checked_at")
        .bind(home.home_id, nowMs).run();
    } catch (error) {
      // Not marked as read: the next sweep reads this home again.
      console.error(JSON.stringify({ message: "provider access read failed", homeId: home.home_id }));
      if (error instanceof Error && error.message === "provider_actions_page_cap") {
        try {
          await persistAlert(env, { homeId: home.home_id, kind: "access.history_too_long", severity: "high",
            detail: "the hosting provider's action history for this home has more pages than one read walks; the home is not marked as read" }, nowMs);
        } catch { /* the next read raises it again */ }
      }
    }
  };
  for (let i = 0; i < homes.results.length; i += PROVIDER_SWEEP_PARALLEL) {
    if (Date.now() - started > PROVIDER_SWEEP_BUDGET_MS) {
      console.error(JSON.stringify({ message: "provider access sweep stopped at its time budget", left: homes.results.length - i }));
      break;
    }
    await Promise.all(homes.results.slice(i, i + PROVIDER_SWEEP_PARALLEL).map(readHome));
  }
  return recorded;
}
