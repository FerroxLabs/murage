// SPDX-License-Identifier: AGPL-3.0-or-later
// Two-tier alert delivery (lanes/cloud-v2/ALERTS-TWO-TIER-DESIGN.md). Rows stay one per home in cloud_alerts, as the evidence; only the
// delivery is grouped. Page kinds are delivered as ONE message per group (cause), digest kinds are never posted one by one.
import { ALERT_TIER, PAGE_GROUPS, PAGE_KINDS, PROVIDER_ACTION_OPEN_MS, PROVIDER_ACTION_UNEXPECTED_ALERT, alertTier, type AlertTierEntry } from "./alert-tiers";

export const PAGE_EXAMPLES = 5;
/** A group that is still open after this long is paged again, and a group whose count doubled since its last page is paged again. */
export const PAGE_REMIND_MS = 4 * 3_600_000;
/** At most this many pages an hour across all groups (bypass groups excepted); past it, one "alert storm" page an hour. */
export const PAGE_HOURLY_CAP = 6;
const HOUR_MS = 3_600_000;
const STORM_KEY = "alert_storm_at";
/** The group's own claim, and its retry backoff after a failed send: 1 min, doubling, at most an hour (the same shape as a row's claim). */
const claimMs = (attempts: number) => Math.min(60_000 * 2 ** Math.min(attempts, 6), HOUR_MS);

export type PageSender = (payload: Record<string, unknown>, idempotencyKey: string) => Promise<boolean>;

interface Member { id: string; home_id: string; kind: string; raised_at: number; delivered_at: number | null }
interface Budget { group_key: string; reason: string; attempts: number; last_failed_at: number }
const REASONS = ["opened", "count_doubled", "still_open", "resolved"];
interface GroupRow { group_key: string; state: string; opened_at: number; last_paged_at: number | null; last_paged_count: number; pages: number;
  peak_count: number; attempts: number; claim_until: number | null }

/** One send, one key. The reason is in it (a follow-up page is never the first page's notification), and so is a digest of the member ids in
 *  the body: a retry of the SAME send (same reason, same members) repeats the key, while a different body gets a different key, so a deduping
 *  relay can neither swallow a follow-up nor replay a response for members that were not in what it was sent. */
function pageKey(group: string, openedAt: number, reason: string, seq: number, members: Member[]): string {
  let h = 0x811c9dc5;
  for (const c of members.map((m) => m.id).sort().join(",")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `group:${group}:${openedAt}:${reason}:${seq}:${h.toString(16)}`;
}

const kindsOf = (group: string): string[] => PAGE_KINDS.filter((k) => {
  const e = ALERT_TIER[k]; return e.tier === "page" && e.group === group;
});
const entryOf = (kind: string) => alertTier(kind) as Extract<AlertTierEntry, { tier: "page" }>;
const bypasses = (group: string) => PAGE_GROUPS[group]?.bypassCap === true;

/** The most distinct homes among rows raised within any one windowMs span (rows sorted by raised_at). The span is measured between the
 *  rows themselves, never against the clock: a delivery that starts late (a webhook secret just set) sees the same cohort as one on time. */
function densestWindow(rows: Member[], windowMs: number | undefined): number {
  const sorted = [...rows].sort((a, b) => a.raised_at - b.raised_at);
  if (windowMs === undefined) return new Set(sorted.map((r) => r.home_id)).size;
  const inside = new Map<string, number>();
  let best = 0, lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    inside.set(sorted[hi].home_id, (inside.get(sorted[hi].home_id) ?? 0) + 1);
    while (sorted[hi].raised_at - sorted[lo].raised_at > windowMs) {
      const n = inside.get(sorted[lo].home_id)! - 1;
      if (n === 0) inside.delete(sorted[lo].home_id); else inside.set(sorted[lo].home_id, n);
      lo++;
    }
    best = Math.max(best, inside.size);
  }
  return best;
}

/** Open (unresolved) alerts of the group that count toward opening it: each kind against its own threshold (default: one is enough). A
 *  threshold with a window is met when that many distinct homes were raised within any one windowMs span of each other. */
export function qualifying(members: Member[], fleet: number, now: number = Date.now()): Member[] {
  const byKind = new Map<string, Member[]>();
  for (const m of members) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
  const out: Member[] = [];
  for (const [kind, all] of byKind) {
    let rows = all;
    const t = entryOf(kind).threshold;
    if (!t) { out.push(...rows); continue; }
    // minAgeMs: only rows open at least that long count; younger ones wait (and the digest carries them).
    if (t.minAgeMs !== undefined) rows = rows.filter((r) => now - r.raised_at >= t.minAgeMs!);
    if (rows.length === 0) continue;
    const homes = densestWindow(rows, t.windowMs);
    const byShare = t.fleetShare !== undefined && fleet > 0 && homes >= 2 && homes / fleet >= t.fleetShare;
    if (homes >= t.minHomes || byShare) out.push(...rows);
  }
  return out;
}

/** CH1 M3 (Astra r1): the members old enough to be paged for. minAgeMs applies for the WHOLE group lifecycle, not only when the group opens:
 *  a younger row of a kind with a minimum age is not counted, named, notified or marked delivered until it is itself that old. */
export function ageQualified(members: Member[], now: number): Member[] {
  return members.filter((m) => { const t = entryOf(m.kind).threshold; return !t || t.minAgeMs === undefined || now - m.raised_at >= t.minAgeMs; });
}

function pageText(group: string, count: number, homes: string[], mention: boolean): string {
  const g = PAGE_GROUPS[group];
  const shown = homes.slice(0, PAGE_EXAMPLES);
  const more = homes.length - shown.length;
  const first = kindsOf(group)[0];
  const action = first ? entryOf(first).action : "";
  return `${mention ? "<!here> " : ""}${g.title}: ${count} open${shown.length ? ` (${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""})` : ""}. `
    + `${action ? `Do this: ${action} ` : ""}The rest is in the daily digest.`;
}

/** Delivers the page tier: one page per group when it opens, again when its count doubles or after 4 h still open, at most PAGE_HOURLY_CAP
 *  an hour (then one storm page), a resolve message when it closes. Page-kind rows that were handled are marked delivered. Idempotent per
 *  sweep: group state lives in cloud_alert_groups, and a group's claim stops two sweeps sending the same page. */
export async function sweepPages(env: Env, now: number, send: PageSender, maxAttempts: number, budgetMs: number): Promise<{ paged: string[]; storm: boolean; resolved: string[] }> {
  const result = { paged: [] as string[], storm: false, resolved: [] as string[] };
  // A stalled webhook costs the sweep at most budgetMs plus one send's own timeout: no send starts after the budget is spent (compromise pages
  // go first, and are never held back by it); what is left waits, unchanged, for the next sweep.
  const started = Date.now();
  const outOfTime = (group: string) => !bypasses(group) && Date.now() - started > budgetMs;
  const kinds = PAGE_KINDS.map((k) => `'${k}'`).join(",");
  const open = (await env.DB.prepare(`SELECT id,home_id,kind,raised_at,delivered_at FROM cloud_alerts WHERE resolved_at IS NULL AND kind IN (${kinds}) ORDER BY raised_at,id`)
    .all<Member>()).results;
  const fleetRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_homes WHERE desired_state='ready' AND observed_state='ready'").first<{ n: number }>();
  const fleet = fleetRow?.n ?? 0;
  const budgets = new Map((await env.DB.prepare("SELECT group_key,reason,attempts,last_failed_at FROM cloud_alert_group_budget").all<Budget>()).results
    .map((b) => [`${b.group_key}|${b.reason}`, b]));
  /** Failed sends of one reason so far. A spent budget lapses PAGE_REMIND_MS after its last failure, so a bad URL that is fixed later is
   *  not dead for good; any successful page of the group resets every reason. */
  const attemptsOf = (group: string, reason: string) => {
    const b = budgets.get(`${group}|${reason}`);
    if (!b) return 0;
    return b.attempts >= maxAttempts && now - b.last_failed_at >= PAGE_REMIND_MS ? 0 : b.attempts;
  };
  const states = new Map((await env.DB.prepare("SELECT * FROM cloud_alert_groups").all<GroupRow>()).results.map((g) => [g.group_key, g]));
  const sentLastHour = (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alert_pages WHERE at>? AND bypass=0").bind(now - HOUR_MS).first<{ n: number }>())?.n ?? 0;
  let capUsed = sentLastHour;
  const deferred: string[] = [];
  let openGroups = 0;
  // Bypass groups first, so a storm of ordinary pages can never use up the sweep's time before a compromise page.
  const groups = Object.keys(PAGE_GROUPS).sort((a, b) => Number(bypasses(b)) - Number(bypasses(a)));
  for (const group of groups) {
    const kindSet = new Set(kindsOf(group));
    const members = open.filter((m) => kindSet.has(m.kind));
    const state = states.get(group);
    const isOpen = state?.state === "open";
    // A closed group: its last member resolved. Say so once (only if it ever paged), with no mention.
    if (members.length === 0) {
      if (!isOpen) continue;
      if (state!.last_paged_at === null) { await closeGroup(env, group, now); continue; }
      if (!PAGE_GROUPS[group].silentClose && outOfTime(group)) continue;
      if (PAGE_GROUPS[group].silentClose || attemptsOf(group, "resolved") >= maxAttempts) { await closeGroup(env, group, now); continue; }
      if (!await claim(env, group, attemptsOf(group, "resolved"))) continue;
      const mins = Math.max(1, Math.round((now - state!.opened_at) / 60_000));
      const ok = await send({ kind: `page.${group}.resolved`, severity: "info", group, count: 0,
        text: `${PAGE_GROUPS[group].title}: resolved after ${mins} min.`, at: now }, `group:${group}:${state!.opened_at}:resolved`);
      if (ok) { await closeGroup(env, group, now); result.resolved.push(group); }
      else await failed(env, group, "resolved", attemptsOf(group, "resolved"), now);
      continue;
    }
    const meets = qualifying(members, fleet, now).length > 0;
    if (!isOpen && !meets) continue;               // under its threshold and not open: the rows wait, undelivered
    let current: GroupRow = state!;
    if (!isOpen) {
      // CH1 N3 (Astra r1): opening is atomic. The upsert only takes effect while the group is NOT already open, so a second overlapping sweep that
      // read the group closed (or missing) before the first opened it changes no row and leaves the first sweep's claim, opened_at and paging state
      // untouched. That sweep skips the group: the one that opened it owns the page.
      const opened = await env.DB.prepare(`INSERT INTO cloud_alert_groups (group_key,state,opened_at,last_paged_at,last_paged_count,pages,peak_count,attempts,claim_until,closed_at)
        VALUES (?,'open',?,NULL,0,0,0,0,NULL,NULL) ON CONFLICT(group_key) DO UPDATE SET state='open',opened_at=excluded.opened_at,last_paged_at=NULL,
        last_paged_count=0,pages=0,peak_count=0,attempts=0,claim_until=NULL,closed_at=NULL WHERE cloud_alert_groups.state<>'open'`).bind(group, now).run();
      if ((opened.meta.changes ?? 0) !== 1) continue;
      await env.DB.prepare("DELETE FROM cloud_alert_group_budget WHERE group_key=?").bind(group).run();
      for (const r of REASONS) budgets.delete(`${group}|${r}`);
      current = { group_key: group, state: "open", opened_at: now, last_paged_at: null, last_paged_count: 0, pages: 0, peak_count: 0, attempts: 0, claim_until: null };
    }
    openGroups++;
    // Only the age-qualified members are counted, named, sent and marked delivered (a fresh row of an open group waits until it is old enough).
    const paged = ageQualified(members, now);
    const count = paged.length;
    if (count > current.peak_count) await env.DB.prepare("UPDATE cloud_alert_groups SET peak_count=? WHERE group_key=?").bind(count, group).run();
    // Every reason that is due now, in priority order. Each has its own attempt budget: the first one with budget left is sent, so a
    // reason that keeps failing never blocks the others.
    const due = current.last_paged_at === null ? ["opened"]
      : [...(count >= 2 * current.last_paged_count ? ["count_doubled"] : []), ...(now - current.last_paged_at >= PAGE_REMIND_MS ? ["still_open"] : [])];
    const reason = count === 0 ? undefined : due.find((r) => attemptsOf(group, r) < maxAttempts);
    if (reason) {
      if (outOfTime(group)) continue;
      if (!bypasses(group) && capUsed >= PAGE_HOURLY_CAP) { deferred.push(group); continue; }
      const spent = attemptsOf(group, reason);
      if (!await claim(env, group, spent)) continue;
      // CH1 N3: with the claim held, the group is read again. A sweep that decided from an older read (another sweep paged and released its claim
      // in between) sends nothing: the page it was about to send has already gone out.
      const fresh = await env.DB.prepare("SELECT state,pages,last_paged_at,opened_at FROM cloud_alert_groups WHERE group_key=?")
        .bind(group).first<{ state: string; pages: number; last_paged_at: number | null; opened_at: number }>();
      if (!fresh || fresh.state !== "open" || fresh.pages !== current.pages || fresh.last_paged_at !== current.last_paged_at || fresh.opened_at !== current.opened_at) {
        await env.DB.prepare("UPDATE cloud_alert_groups SET claim_until=NULL WHERE group_key=? AND claim_until IS NOT NULL").bind(group).run();
        continue;
      }
      const homes = [...new Set(paged.map((m) => m.home_id))];
      const ok = await send({ kind: `page.${group}`, severity: "critical", group, count, homes: homes.slice(0, PAGE_EXAMPLES), mention: "here", reason,
        text: pageText(group, count, homes, true), at: now }, pageKey(group, current.opened_at, reason, current.pages + 1, paged));
      if (ok) {
        await env.DB.batch([
          env.DB.prepare("UPDATE cloud_alert_groups SET last_paged_at=?,last_paged_count=?,pages=pages+1,attempts=0,claim_until=NULL WHERE group_key=?").bind(now, count, group),
          env.DB.prepare("INSERT INTO cloud_alert_pages (at,group_key,reason,bypass) VALUES (?,?,?,?)").bind(now, group, reason, bypasses(group) ? 1 : 0),
          env.DB.prepare("DELETE FROM cloud_alert_group_budget WHERE group_key=?").bind(group),
        ]);
        for (const r of REASONS) budgets.delete(`${group}|${r}`);
        if (!bypasses(group)) capUsed++;
        result.paged.push(group);
        await markHandled(env, paged, now);
      } else {
        await failed(env, group, reason, spent, now);
        for (let i = 0; i < paged.length; i += 50) {
          const part = paged.slice(i, i + 50);
          await env.DB.prepare(`UPDATE cloud_alerts SET delivery_attempts=delivery_attempts+1 WHERE delivered_at IS NULL AND resolved_at IS NULL
            AND id IN (${part.map(() => "?").join(",")})`).bind(...part.map((m) => m.id)).run();
        }
      }
    } else if ((due.length === 0 || count === 0) && current.last_paged_at !== null) {
      // An open group that paged and has nothing due: rows added since are covered by it, so they are handled (the digest lists them).
      // A group with a page DUE whose budget is spent, claimed or held back is never here: its rows stay undelivered (and keep counting
      // toward the backlog alert), so a late member is never swallowed by a page that did not go out.
      await markHandled(env, paged, now);
    }
  }
  // Pages held back by the hourly cap: ONE storm page an hour, never one per group. Bypass groups were not held back.
  if (deferred.length > 0) {
    const last = await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key=?").bind(STORM_KEY).first<{ value: string }>();
    if (!last || now - Number(last.value) >= HOUR_MS) {
      const ok = await send({ kind: "page.alert_storm", severity: "critical", count: openGroups, mention: "here",
        text: `<!here> Alert storm: ${openGroups} groups open, see the digest.`, at: now }, `storm:${Math.floor(now / HOUR_MS)}`);
      if (ok) {
        await env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(STORM_KEY, String(now)).run();
        result.storm = true;
      }
    }
  }
  return result;
}

async function claim(env: Env, group: string, attempts: number): Promise<boolean> {
  const t = Date.now();
  const r = await env.DB.prepare("UPDATE cloud_alert_groups SET claim_until=? WHERE group_key=? AND (claim_until IS NULL OR claim_until<=?)")
    .bind(t + claimMs(attempts), group, t).run();
  return r.meta.changes === 1;
}
/** One failed send of one reason: its own attempt count goes up (absolute, so a lapsed budget restarts from 0), and the group's claim backs off. */
async function failed(env: Env, group: string, reason: string, attempts: number, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_alert_group_budget (group_key,reason,attempts,last_failed_at) VALUES (?,?,?,?)
      ON CONFLICT(group_key,reason) DO UPDATE SET attempts=excluded.attempts,last_failed_at=excluded.last_failed_at`).bind(group, reason, attempts + 1, now),
    env.DB.prepare("UPDATE cloud_alert_groups SET claim_until=? WHERE group_key=?").bind(Date.now() + claimMs(attempts + 1), group),
  ]);
}
async function closeGroup(env: Env, group: string, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE cloud_alert_groups SET state='closed',closed_at=?,claim_until=NULL,attempts=0 WHERE group_key=?").bind(now, group),
    env.DB.prepare("DELETE FROM cloud_alert_group_budget WHERE group_key=?").bind(group),
  ]);
}
async function markHandled(env: Env, members: Member[], now: number): Promise<void> {
  const ids = members.filter((m) => m.delivered_at === null).map((m) => m.id);
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    await env.DB.prepare(`UPDATE cloud_alerts SET delivered_at=?,delivery_claim_until=NULL WHERE delivered_at IS NULL AND id IN (${part.map(() => "?").join(",")})`)
      .bind(now, ...part).run();
  }
}

/** Digest-tier rows are never posted one by one: they are marked handled so the delivery backlog never counts them. */
export async function handleDigestRows(env: Env, now: number): Promise<void> {
  const kinds = PAGE_KINDS.map((k) => `'${k}'`).join(",");
  await env.DB.prepare(`UPDATE cloud_alerts SET delivered_at=?,delivery_claim_until=NULL WHERE delivered_at IS NULL AND kind NOT IN (${kinds})`).bind(now).run();
}

// ---- the daily digest --------------------------------------------------------------------------------------------------------------

const nameOf = (group: string) => PAGE_GROUPS[group]?.title ?? group;
const hours = (ms: number) => `${Math.round(ms / 360_000) / 10} h`;

/** Unresolved page-kind rows whose group is not open (the kind is under its threshold): they never page, so the digest must carry them. */
async function belowThresholdRows(env: Env): Promise<{ kind: string; home_id: string }[]> {
  const kinds = PAGE_KINDS.map((k) => `'${k}'`).join(",");
  const open = new Set((await env.DB.prepare("SELECT group_key FROM cloud_alert_groups WHERE state='open'").all<{ group_key: string }>()).results.map((g) => g.group_key));
  const rows = (await env.DB.prepare(`SELECT kind,home_id FROM cloud_alerts WHERE resolved_at IS NULL AND kind IN (${kinds}) ORDER BY kind,raised_at`)
    .all<{ kind: string; home_id: string }>()).results;
  return rows.filter((r) => !open.has(entryOf(r.kind).group));
}

/** The digest's first line, and the open page groups under it. */
export async function needsYouLines(env: Env): Promise<string[]> {
  const groups = (await env.DB.prepare("SELECT group_key,opened_at FROM cloud_alert_groups WHERE state='open' ORDER BY opened_at,group_key").all<{ group_key: string; opened_at: number }>()).results;
  if (groups.length === 0) {
    const below = (await belowThresholdRows(env)).length;
    return [below > 0 ? `Nothing is paging, but ${below} open alert${below === 1 ? "" : "s"} below the paging threshold still need a look (see Open items).` : "Nothing needs you today."];
  }
  const below = (await belowThresholdRows(env)).length;
  const alsoBelow = below > 0 ? ` (and ${below} open alert${below === 1 ? "" : "s"} below the paging threshold)` : "";
  const lines = [`${groups.length} thing${groups.length === 1 ? "" : "s"} need${groups.length === 1 ? "s" : ""} you${alsoBelow}:`];
  for (const g of groups) {
    const kinds = kindsOf(g.group_key).map((k) => `'${k}'`).join(",");
    const rows = kinds ? (await env.DB.prepare(`SELECT home_id FROM cloud_alerts WHERE resolved_at IS NULL AND kind IN (${kinds})`).all<{ home_id: string }>()).results : [];
    const homes = [...new Set(rows.map((r) => r.home_id))];
    const first = kindsOf(g.group_key)[0];
    lines.push(`- ${nameOf(g.group_key)}: ${rows.length} open (${homes.slice(0, PAGE_EXAMPLES).join(", ")}${homes.length > PAGE_EXAMPLES ? ` and ${homes.length - PAGE_EXAMPLES} more` : ""})`
      + `${first ? `. Do this: ${entryOf(first).action}` : ""}`);
  }
  return lines;
}

/** Open digest items, grouped by kind with up to PAGE_EXAMPLES homes each. */
export async function openDigestLines(env: Env): Promise<string[]> {
  const kinds = PAGE_KINDS.map((k) => `'${k}'`).join(",");
  // Below-threshold page kinds come FIRST: they never page, and the daily digest keeps only its first lines, so they must not be the ones folded away.
  const rows = [...await belowThresholdRows(env), ...(await env.DB.prepare(`SELECT kind,home_id FROM cloud_alerts WHERE resolved_at IS NULL AND kind NOT IN (${kinds}) ORDER BY kind,raised_at`)
    .all<{ kind: string; home_id: string }>()).results];
  const byKind = new Map<string, string[]>();
  for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.home_id]);
  return [...byKind].map(([kind, homes]) => `${kind}: ${homes.length} (${homes.slice(0, PAGE_EXAMPLES).join(", ")}${homes.length > PAGE_EXAMPLES ? ` and ${homes.length - PAGE_EXAMPLES} more` : ""})`);
}

/** The Monday review: for each page kind, times fired in the last 7 days, time open, and whether Murage support acted on that home while
 *  it was open. The only record of operator actions is selfservice_audit (actor 'operator'); a Slack reply or an operator call on a route
 *  that writes no audit row is not recorded, so "no action recorded" is a prompt to look, not proof of nothing. */
export async function weeklyReviewLines(env: Env, now: number): Promise<string[]> {
  const lines = ["Weekly review of pages, last 7 days (an action is a support action on that home while the alert was open; Slack replies are not recorded):"];
  let any = false;
  for (const kind of PAGE_KINDS) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS fired, COALESCE(SUM(COALESCE(a.resolved_at,?1)-a.raised_at),0) AS open_ms,
        COALESCE(SUM(EXISTS(SELECT 1 FROM selfservice_audit s WHERE s.home_id=a.home_id AND s.actor='operator' AND s.at>=a.raised_at AND s.at<=COALESCE(a.resolved_at,?1))),0) AS acted
      FROM cloud_alerts a WHERE a.kind=?2 AND a.raised_at>?3`).bind(now, kind, now - 7 * 86_400_000).first<{ fired: number; open_ms: number; acted: number }>();
    if (!r || r.fired === 0) continue;
    any = true;
    lines.push(`- ${kind}: fired ${r.fired}, open ${hours(r.open_ms)}, ${r.acted > 0 ? `action recorded on ${r.acted}` : "no action recorded: retune or demote"}`);
  }
  if (!any) lines.push("- no page fired this week");
  return lines;
}

/** P8 rows that aged out without anyone confirming them (the watch ended; it is never posted as "resolved"). The notice is owed until a digest
 *  that carried it was posted with a 2xx (ageout_notice, cleared by clearAgedOut), however long the webhook was down. */
export async function agedOutLines(env: Env): Promise<{ lines: string[]; ids: string[] }> {
  const ids = (await env.DB.prepare("SELECT id FROM cloud_alerts WHERE kind=? AND ageout_notice=1 ORDER BY id").bind(PROVIDER_ACTION_UNEXPECTED_ALERT).all<{ id: string }>()).results.map((r) => r.id);
  const n = ids.length;
  return { ids, lines: n > 0 ? [`Watch ended, NOT confirmed resolved: ${n} provider action${n === 1 ? "" : "s"} this Worker did not take aged out after ${PROVIDER_ACTION_OPEN_MS / 3_600_000} h with nobody confirming. Check the provider's audit log.`] : [] };
}
/** Called only after the digest that carried these rows' line was acknowledged. */
export async function clearAgedOut(env: Env, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    await env.DB.prepare(`UPDATE cloud_alerts SET ageout_notice=NULL WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).run();
  }
}
