// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls (design BOT-CALLS-109 rev 4.2), phase 3: decide(intent, entry) of 4.2 over the matrix of 4.3, the calendar
// answer of 4.4 (free/busy only) and the Emergency switch of 4.6. No cell reads model text. The calendar is the only
// await; every other step is evaluated again inside the committing transaction (steps 2 to 5 and 7), so a Stop, a
// switch, a cap or a live call that lands while the calendar is asked wins.
import type { DatabaseSync } from "node:sqlite";
import { botCallsEnabled, callsOffActive } from "./bot-calls-schema.ts";
import {
  FRESH_MS, applyEscalation, applyInitial, callIsLive, getIntent, sweepSessions,
  type Applied, type CallEffects, type CallIntent, type Decision, type ReceiptStep,
} from "./bot-calls-machine.ts";

/** Caps by rang_at (4.2 step 5); fixed numbers, not settings. */
export const CALL_CAPS = { botHour: 2, botDay: 6, ownerHour: 3, ownerDay: 10, tierBRuleDay: 2 } as const;
export const CALL_COOLDOWN = { rangMs: 30 * 60_000, declinedMs: 2 * 3600_000 } as const;
/** The calendar's budget (4.4). */
export const CALENDAR_BUDGET_MS = 5_000;
const HOUR = 3600_000, DAY = 24 * HOUR;

export type CalendarAnswer = "free" | "busy" | "unsure" | "none";
export type DecideEntry = "initial" | "escalation";

/** What decide() asks the harness. Synchronous answers are read again inside the commit. */
export interface DecideWorld {
  /** The owner's one quiet-hours setting (shared/notification-preferences.ts quietHoursActive). */
  quietHours(now: number): boolean;
  /** A voice source for this bot's calls (Flux or a voice provider). */
  voiceReady(botId: string): boolean;
  /** At least one device that can ring: a desktop window, or a phone whose "Rings for calls" is on. */
  ringingDevice(): boolean;
  /** The fact is still true (the routine, watch or thread still exists and still belongs to the bot). */
  factValid(intent: CallIntent): boolean;
  /** Free/busy for [now, now + 5 min], already reduced by calendarAnswer; it must not throw (a throw reads unsure). */
  calendar(botId: string, signal: AbortSignal): Promise<CalendarAnswer>;
  /** When this process booted: an escalation deadline before it was missed while Murage was not running (5.8). */
  bootAt: number;
}

type RuleRow = { kind: string; tier: "A" | "B"; how: "ring" | "text_first"; wait_min: number | null; enabled: number; demoted: number; emergency: number; restore_held: number };
const count = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number }).n);
/** An index range with LIMIT cap + 1 (5.1). */
const atLeast = (db: DatabaseSync, where: string, args: Array<string | number>, cap: number) =>
  count(db, `SELECT COUNT(*) AS n FROM (SELECT 1 FROM bot_calls WHERE ${where} LIMIT ?)`, ...args, cap + 1) >= cap;

/** Quiet hours or "Calls off for today", whichever holds now (quiet hours named first); null when neither. The ONE
 * reading for decide() step 7 and the note push. */
export function quietNow(db: DatabaseSync, world: Pick<DecideWorld, "quietHours">, now: number): "quiet" | "off_today" | null {
  if (world.quietHours(now)) return "quiet";
  return callsOffActive(db, now) ? "off_today" : null;
}

type Pre = { final: Decision } | { ring: true; steps: ReceiptStep[]; emergency: boolean; timed: boolean };
const text = (steps: ReceiptStep[], outcome: "texted" | "late" | "dropped" = "texted"): { final: Decision } => ({ final: { to: "done", outcome, steps } });

/** Steps 1 to 7 of 4.2, synchronous, against the database as it is now. Run once before the calendar and again inside
 * the committing transaction. */
export function evaluate(db: DatabaseSync, intent: CallIntent, entry: DecideEntry, world: DecideWorld, now: number): Pre {
  const steps: ReceiptStep[] = [];
  // 1. fresh
  if (entry === "initial" && now - intent.factAt > FRESH_MS) return text([{ check: "fresh", result: "late" }], "late");
  if (entry === "escalation" && intent.deadlineAt !== null && (intent.deadlineAt < world.bootAt || now - intent.deadlineAt > FRESH_MS))
    return text([{ check: "fresh", result: "late" }], "late");
  steps.push({ check: "fresh", result: "ok" });
  // 2. gates
  const rule = db.prepare("SELECT kind, tier, how, wait_min, enabled, demoted, emergency, restore_held FROM bot_call_rules WHERE id=?").get(intent.ruleId) as RuleRow | undefined;
  if (!rule || Number(rule.enabled) !== 1) return text([...steps, { check: "rule", result: "off" }]);
  if (Number(rule.restore_held) !== 0) return text([...steps, { check: "rule", result: "restore_held" }]);
  if (rule.tier === "B" && Number(rule.demoted) === 1) return text([...steps, { check: "rule", result: "message_only" }]);
  if (!botCallsEnabled(db, intent.botId)) return text([...steps, { check: "bot", result: "off" }]);
  if (!world.voiceReady(intent.botId)) return text([...steps, { check: "voice", result: "none" }]);
  if (!world.ringingDevice()) return text([...steps, { check: "device", result: "none" }]);
  if (!world.factValid(intent)) return text([...steps, { check: "fact", result: "invalid" }], "dropped");
  steps.push({ check: "gates", result: "ok" });
  // 3. live: a ring holds the slot, or any session is live (the sweep runs first, 5.7)
  if (callIsLive(db, now)) return text([...steps, { check: "live", result: "on_call" }]);
  // 4. cooldown (other intents of this rule)
  if (count(db, "SELECT COUNT(*) AS n FROM (SELECT 1 FROM bot_calls WHERE rule_id=? AND id<>? AND rang_at > ? LIMIT 1)", intent.ruleId, intent.id, now - CALL_COOLDOWN.rangMs) > 0
    || count(db, `SELECT COUNT(*) AS n FROM (SELECT 1 FROM bot_calls WHERE rule_id=? AND id<>? AND created_at > ? AND outcome IN ('declined','text_instead') AND ended_at > ? LIMIT 1)`,
      intent.ruleId, intent.id, now - CALL_COOLDOWN.declinedMs - 2 * HOUR, now - CALL_COOLDOWN.declinedMs) > 0)
    return text([...steps, { check: "cooldown", result: "cooling" }]);
  // 5. caps by rang_at; timed calls are exempt from the bot and owner caps but still counted
  const timed = rule.kind === "timed";
  if (!timed) {
    if (atLeast(db, "bot_id=? AND rang_at > ?", [intent.botId, now - HOUR], CALL_CAPS.botHour)) return text([...steps, { check: "cap", result: "bot_hour", detail: String(CALL_CAPS.botHour) }]);
    if (atLeast(db, "bot_id=? AND rang_at > ?", [intent.botId, now - DAY], CALL_CAPS.botDay)) return text([...steps, { check: "cap", result: "bot_day", detail: String(CALL_CAPS.botDay) }]);
    if (atLeast(db, "rang_at > ?", [now - HOUR], CALL_CAPS.ownerHour)) return text([...steps, { check: "cap", result: "owner_hour", detail: String(CALL_CAPS.ownerHour) }]);
    if (atLeast(db, "rang_at > ?", [now - DAY], CALL_CAPS.ownerDay)) return text([...steps, { check: "cap", result: "owner_day", detail: String(CALL_CAPS.ownerDay) }]);
  }
  if (rule.tier === "B" && atLeast(db, "rule_id=? AND rang_at > ?", [intent.ruleId, now - DAY], CALL_CAPS.tierBRuleDay)) return text([...steps, { check: "cap", result: "tier_b_day", detail: String(CALL_CAPS.tierBRuleDay) }]);
  steps.push({ check: "caps", result: "ok" });
  // 6. how (initial only): message first goes to waiting; escalation never returns there
  if (entry === "initial" && (rule.how === "text_first" || rule.tier === "B")) {
    const wait = Number(rule.wait_min ?? 10);
    return { final: { to: "waiting", deadlineAt: intent.createdAt + wait * 60_000, steps: [...steps, { check: "how", result: "text_first", detail: String(wait) }] } };
  }
  // 7. quiet hours, or "Calls off for today" (calls-109.yaml v2, off-today): an Emergency rule (Tier A kinds only, by the
  // table's CHECK) continues under either; a timed rule continues under quiet hours only, because the owner turned calls off
  // more recently than they booked it (MurageMain 10-27). The rest is card only.
  const emergency = rule.tier === "A" && Number(rule.emergency) === 1;
  const quiet = quietNow(db, world, now);
  if (quiet) {
    const off = quiet === "off_today" || callsOffActive(db, now);
    if (!emergency && !(timed && !off)) return text([...steps, { check: timed ? "off_today" : quiet, result: timed ? "off_today" : quiet }]);
    steps.push({ check: quiet, result: emergency ? "emergency" : "timed" });
  }
  return { ring: true, steps, emergency, timed };
}

/** Step 8 and 9 on top of evaluate(). `unsure` texts for every rule; `busy` rings only for an Emergency rule. */
function withCalendar(pre: Pre, calendar: CalendarAnswer): Decision {
  if ("final" in pre) return pre.final;
  const steps = [...pre.steps];
  if (calendar === "unsure") return { to: "done", outcome: "texted", steps: [...steps, { check: "calendar", result: "unsure" }] };
  if (calendar === "busy") {
    if (!pre.emergency) return { to: "done", outcome: "texted", steps: [...steps, { check: "calendar", result: "busy" }] };
    steps.push({ check: "calendar", result: "busy", detail: "emergency" });
  } else steps.push({ check: "calendar", result: calendar });
  return { to: "ringing", steps };
}

async function askCalendar(world: DecideWorld, botId: string): Promise<CalendarAnswer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      world.calendar(botId, controller.signal).catch((): CalendarAnswer => "unsure"),
      new Promise<CalendarAnswer>(resolve => { timer = setTimeout(() => { controller.abort(); resolve("unsure"); }, CALENDAR_BUDGET_MS); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** decide(intent, entry): T2 (initial, from pending) or T4 (escalation, from waiting), under the gen read now. A Stop or
 * a boot that changes state or gen while the calendar is asked makes the commit a no-op (F21). */
export async function decide(db: DatabaseSync, id: string, entry: DecideEntry, world: DecideWorld, fx: CallEffects, clock: () => number = Date.now): Promise<Applied> {
  const intent = getIntent(db, id);
  if (!intent || intent.state !== (entry === "initial" ? "pending" : "waiting")) return { applied: false };
  const gen = intent.gen;
  sweepSessions(db, fx, clock());
  const pre = evaluate(db, intent, entry, world, clock());
  const calendar: CalendarAnswer = "final" in pre ? "none" : await askCalendar(world, intent.botId);
  const at = clock();
  if (!("final" in pre)) sweepSessions(db, fx, at);
  const commit = (before: CallIntent) => withCalendar(evaluate(db, before, entry, world, at), calendar);
  return entry === "initial" ? applyInitial(db, id, gen, commit, fx, at) : applyEscalation(db, id, gen, commit, fx, at);
}

// ── calendar (4.4) ──────────────────────────────────────────────────────────

/** The only calendar call bot calls make. Any other googlecalendar slug fails the build test (F28). */
export const CALENDAR_SLUG = "GOOGLECALENDAR_FREE_BUSY_QUERY";

/** The live inventory as this decision fetched it. A remembered snapshot, a revalidating one, or a failed fetch is not live. */
export interface CalendarInventory { ok: boolean; live: boolean; hasGooglecalendar: boolean }
/** Reduces one decision's own reads to the answer of 4.4. `none` only with `managed` and this decision's own live
 * inventory showing no googlecalendar connection; everything that is not a clean answer is `unsure`. */
export function calendarAnswer(o: {
  mode: "managed" | "unavailable"; inventory: CalendarInventory | null; status?: number; body?: unknown; window: { start: number; end: number };
}): CalendarAnswer {
  if (o.mode !== "managed" || !o.inventory || !o.inventory.ok || !o.inventory.live) return "unsure";
  if (!o.inventory.hasGooglecalendar) return "none";
  if (o.status !== 200 || !o.body || typeof o.body !== "object") return "unsure";
  const body = o.body as { errors?: unknown; calendars?: unknown; truncated?: unknown };
  if (body.truncated === true || (Array.isArray(body.errors) && body.errors.length > 0)) return "unsure";
  const calendars = body.calendars && typeof body.calendars === "object" ? body.calendars as Record<string, unknown> : null;
  const primary = calendars?.primary as { busy?: unknown; errors?: unknown } | undefined;
  if (!primary || typeof primary !== "object" || (Array.isArray(primary.errors) && primary.errors.length > 0) || !Array.isArray(primary.busy)) return "unsure";
  let busy = false;
  for (const interval of primary.busy as unknown[]) {
    const raw = interval as { start?: unknown; end?: unknown } | null;
    if (!raw || typeof raw !== "object" || typeof raw.start !== "string" || typeof raw.end !== "string") return "unsure";
    const start = Date.parse(raw.start), end = Date.parse(raw.end);
    // an interval that does not parse or runs backwards is not a clean answer (free/busy review r1, Astra High 4)
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end)) return "unsure";
    if (start < o.window.end && end > o.window.start) busy = true;
  }
  return busy ? "busy" : "free";
}
/** The request body: primary calendar, [now, now + 5 min], UTC. */
export function freeBusyRequest(now: number): { timeMin: string; timeMax: string; timeZone: "UTC"; items: [{ id: "primary" }] } {
  return { timeMin: new Date(now).toISOString(), timeMax: new Date(now + 5 * 60_000).toISOString(), timeZone: "UTC", items: [{ id: "primary" }] };
}
