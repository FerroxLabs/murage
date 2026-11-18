// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { PAGE_HOURLY_CAP, PAGE_REMIND_MS } from "../src/alert-pages";
import { raiseAlert, sweepMonitoring } from "../src/ops-monitor";

const NOW = Date.UTC(2026, 9, 12, 8, 0, 0); // a Monday, 08:00 UTC, past the summary hour
const TUESDAY = Date.UTC(2026, 9, 13, 8, 0, 0);
const e = () => ({ ...env, ALERT_WEBHOOK_URL: "https://hooks.example.test/x" }) as Env;
function hook() {
  const sent: Record<string, any>[] = [];
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => { sent.push(JSON.parse(init.body as string)); return new Response("ok"); });
  return { sent, fetcher: fetcher as unknown as typeof fetch, pages: () => sent.filter((m) => String(m.kind).startsWith("page.")) };
}
let seq = 0;
async function row(homeId: string, kind: string, raisedAt: number, resolvedAt: number | null = null) {
  await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,resolved_at) VALUES (?,?,?,'high','d',?,?)")
    .bind(`a-${++seq}`, homeId, kind, raisedAt, resolvedAt).run();
}
async function silent(n: number, at = NOW - 60_000) { for (let i = 0; i < n; i++) await row(`h-${i}`, "home.heartbeat_missed", at); }
async function sweep(t: number, fetcher: typeof fetch) {
  const spy = vi.spyOn(Date, "now").mockReturnValue(t);
  try { await sweepMonitoring(e(), t, fetcher); } finally { spy.mockRestore(); }
}
/** Seven page groups at once: one more than the hourly cap. */
async function sevenGroups() {
  for (const k of ["rollout.halted", "update.stuck", "image.sales_hold", "billing.webhook_stuck", "pool.empty", "alerts.backlog_huge"]) await row(`x-${k}`, k, NOW - 1000);
  await silent(3);
}

describe("page tier delivery", () => {
  it("twelve silent homes are ONE page with a count, five examples, a mention and a Do this line", async () => {
    await silent(12);
    const { pages, sent, fetcher } = hook();
    await sweep(NOW, fetcher);
    expect(pages()).toHaveLength(1);
    const p = pages()[0];
    expect(p).toMatchObject({ kind: "page.homes.unhealthy", group: "homes.unhealthy", count: 12, mention: "here" });
    expect(p.homes).toHaveLength(5);
    expect(p.text).toContain("<!here>");
    expect(p.text).toContain("12 open");
    expect(p.text).toContain("and 7 more");
    expect(p.text).toContain("Do this:");
    expect(p.text).not.toContain("<!channel>");
    expect(sent.filter((m) => m.kind === "home.heartbeat_missed")).toHaveLength(0);
  });
  it("one or two silent homes never page, and digest rows are never posted one by one and are marked handled", async () => {
    await silent(2);
    await row("h-d", "home.disk_high", NOW - 1000); await row("h-r", "refund.stuck", NOW - 1000);
    const { sent, fetcher } = hook();
    await sweep(NOW, fetcher);
    expect(sent.filter((m) => m.kind !== "daily.summary")).toHaveLength(0);
    const undelivered = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE delivered_at IS NULL AND kind IN ('home.disk_high','refund.stuck')").first<{ n: number }>();
    expect(undelivered?.n).toBe(0);
  });
  it("opens at 3 homes within a 10 minute span of each other, but not on 3 homes spread over an hour", async () => {
    for (const m of [60, 30, 1]) await row(`h-${m}`, "home.heartbeat_missed", NOW - m * 60_000);
    const a = hook();
    await sweep(NOW, a.fetcher);
    expect(a.pages()).toHaveLength(0);                          // an hour apart: no 10 minute span holds 3
    await row("h-8", "home.heartbeat_missed", NOW - 30_000); await row("h-7", "home.heartbeat_missed", NOW);
    await sweep(NOW + 1000, a.fetcher);
    expect(a.pages()).toHaveLength(1);                          // h-1, h-8, h-7 are within 1 minute of each other
  });
  it("a cohort that went silent together still pages when delivery starts late (the span counts, never the age)", async () => {
    for (let i = 0; i < 12; i++) await row(`h-${i}`, "home.heartbeat_missed", NOW - 11 * 60_000 + i * 5_000);
    const { pages, fetcher } = hook();
    await sweep(NOW, fetcher);                                  // 11 minutes after the first one went silent
    expect(pages()).toHaveLength(1);
    expect(pages()[0]).toMatchObject({ group: "homes.unhealthy", count: 12 });
    await env.DB.prepare("DELETE FROM cloud_alerts").run(); await env.DB.prepare("DELETE FROM cloud_alert_groups").run();
    for (let i = 0; i < 12; i++) await row(`g-${i}`, "home.heartbeat_missed", NOW - 3 * 3_600_000 + i * 5_000);
    const later = hook();
    await sweep(NOW + 3_600_000, later.fetcher);                // three hours after the cohort, webhook only now set
    expect(later.pages()).toHaveLength(1);
  });
  it("P3 thresholds: provision.failed needs 2 homes in 30 minutes, a pool kind needs one, ui_render_missing needs 2 homes", async () => {
    await row("h-1", "provision.failed", NOW - 60_000); await row("h-2", "home.ui_render_missing", NOW - 60_000);
    const a = hook();
    await sweep(NOW, a.fetcher);
    expect(a.pages()).toHaveLength(0);
    await row("h-3", "provision.failed", NOW - 120_000);
    await sweep(NOW + 1000, a.fetcher);
    expect(a.pages().map((m) => m.group)).toEqual(["homes.not_created"]);
    await env.DB.prepare("DELETE FROM cloud_alerts").run(); await env.DB.prepare("DELETE FROM cloud_alert_groups").run();
    await row("pool", "pool.create_failing", NOW - 1000);
    const b = hook();
    await sweep(NOW, b.fetcher);
    expect(b.pages().map((m) => m.group)).toEqual(["homes.not_created"]);
  });
  it("pages once when it opens, again when the count doubles, and after 4 hours still open, not otherwise", async () => {
    await silent(4);
    const { pages, fetcher } = hook();
    await sweep(NOW, fetcher);
    await sweep(NOW + 60_000, fetcher);
    expect(pages()).toHaveLength(1);
    await row("h-x", "home.heartbeat_missed", NOW + 90_000);    // 5 of 4: not doubled
    await sweep(NOW + 120_000, fetcher);
    expect(pages()).toHaveLength(1);
    for (let i = 20; i < 23; i++) await row(`h-${i}`, "home.heartbeat_missed", NOW + 150_000); // 8 of 4: doubled
    await sweep(NOW + 180_000, fetcher);
    expect(pages()).toHaveLength(2);
    expect(pages()[1].reason).toBe("count_doubled");
    await sweep(NOW + 180_000 + PAGE_REMIND_MS - 1000, fetcher);
    expect(pages()).toHaveLength(2);
    await sweep(NOW + 180_000 + PAGE_REMIND_MS, fetcher);
    expect(pages()).toHaveLength(3);
    expect(pages()[2].reason).toBe("still_open");
  });
  it("posts one resolve message with no mention when the group closes", async () => {
    await silent(4);
    const { sent, pages, fetcher } = hook();
    await sweep(NOW, fetcher);
    await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE kind='home.heartbeat_missed'").bind(NOW + 12 * 60_000).run();
    await sweep(NOW + 12 * 60_000, fetcher);
    await sweep(NOW + 13 * 60_000, fetcher);
    const resolved = sent.filter((m) => m.kind === "page.homes.unhealthy.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].text).toContain("resolved after 12 min");
    expect(resolved[0].text).not.toContain("<!");
    expect(resolved[0].mention).toBeUndefined();
    expect(pages().filter((m) => !String(m.kind).endsWith(".resolved"))).toHaveLength(1);
  });
  it("keeps a page owed when the webhook fails, and sends it once the webhook is back", async () => {
    await silent(4);
    const down = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await sweep(NOW, down);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE delivered_at IS NULL").first<{ n: number }>())?.n).toBe(4);
    const up = hook();
    await sweep(NOW + 2 * 3_600_000, up.fetcher);               // past the group's retry backoff
    expect(up.pages()).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE delivered_at IS NULL").first<{ n: number }>())?.n).toBe(0);
  });
  it("caps pages at 6 an hour and then sends ONE alert storm page", async () => {
    await sevenGroups();
    const { sent, pages, fetcher } = hook();
    await sweep(NOW, fetcher);
    await sweep(NOW + 60_000, fetcher);
    expect(pages().filter((m) => m.kind !== "page.alert_storm")).toHaveLength(PAGE_HOURLY_CAP);
    const storm = sent.filter((m) => m.kind === "page.alert_storm");
    expect(storm).toHaveLength(1);
    expect(storm[0].text).toMatch(/Alert storm: 7 groups open, see the digest/);
  });
  it("a compromise page (P8) still goes out in a storm, and is not counted against the cap", async () => {
    await sevenGroups();
    const { sent, pages, fetcher } = hook();
    await sweep(NOW, fetcher);
    expect(sent.some((m) => m.kind === "page.alert_storm")).toBe(true);
    await row("pool", "pool.secret_misuse", NOW + 30_000);
    await sweep(NOW + 60_000, fetcher);
    const p8 = pages().filter((m) => m.group === "account.compromise");
    expect(p8).toHaveLength(1);
    expect(p8[0].text).toContain("<!here>");
    for (const h of ["h-9", "h-10", "h-11", "h-12"]) await row(h, "access.provider_action_unexpected", NOW + 90_000);
    await sweep(NOW + 120_000, fetcher);                        // 5 rows against 1 paged: doubled, and it bypasses the cap again
    expect(pages().filter((m) => m.group === "account.compromise")).toHaveLength(2);
  });
  it("each page reason has its own attempt budget: after 20 failures of one reason and a recovery, the next reason pages", async () => {
    await silent(4);
    const { pages, fetcher } = hook();
    await sweep(NOW, fetcher);                                  // the group opens
    for (let i = 0; i < 4; i++) await row(`h-d${i}`, "home.heartbeat_missed", NOW + 30_000);   // 8 of 4: count_doubled is due
    const down = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    let t = NOW + 60_000;
    for (let i = 0; i < 20; i++, t += 3_700_000) await sweep(t, down);   // 20 failed count_doubled sends, past each backoff
    expect(down).toHaveBeenCalledTimes(20);
    await sweep(t, down); t += 3_700_000;                       // doubled is spent: still_open (4 h passed) is tried on its own budget and fails
    expect(down).toHaveBeenCalledTimes(21);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE delivered_at IS NULL").first<{ n: number }>())?.n).toBe(4);
    await sweep(t, fetcher);                                    // the webhook is back
    expect(pages()).toHaveLength(2);
    expect(pages()[1]).toMatchObject({ reason: "still_open", count: 8 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE delivered_at IS NULL").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alert_group_budget").first<{ n: number }>())?.n).toBe(0);   // a sent page resets every budget
  });
  it("a P8 that joins a group whose earlier sends failed is not swallowed: it stays owed, and pages once the webhook is back", async () => {
    await row("pool", "pool.secret_misuse", NOW - 1000);
    const { pages, fetcher } = hook();
    await sweep(NOW, fetcher);
    expect(pages()).toHaveLength(1);
    await row("h-9", "access.provider_action_unexpected", NOW + 30_000);   // 2 of 1: count_doubled is due
    const down = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    let t = NOW + 60_000;
    for (let i = 0; i < 21; i++, t += 3_700_000) await sweep(t, down);
    await row("h-10", "access.provider_action_unexpected", t);              // joins the group whose sends have been failing
    await sweep(t + 3_700_000, down);
    const owed = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE delivered_at IS NULL AND kind='access.provider_action_unexpected'").first<{ n: number }>();
    expect(owed?.n).toBe(2);                                    // neither was marked handled
    await sweep(t + 2 * 3_700_000, fetcher);
    const last = pages()[pages().length - 1];
    expect(pages().length).toBeGreaterThan(1);
    expect(last).toMatchObject({ group: "account.compromise", count: 3 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE delivered_at IS NULL").first<{ n: number }>())?.n).toBe(0);
  });
  it("a P8 alert ages out silently after 24 h: no resolved all-clear, only a 'not confirmed' digest line", async () => {
    await row("h-1", "access.provider_action_unexpected", NOW);
    const { sent, pages, fetcher } = hook();
    await sweep(NOW + 1000, fetcher);
    expect(pages().map((m) => m.group)).toEqual(["account.compromise"]);
    await sweep(TUESDAY + 3_600_000, fetcher);                  // 25 h later
    const alert = await env.DB.prepare("SELECT resolved_at FROM cloud_alerts WHERE home_id='h-1'").first<{ resolved_at: number | null }>();
    expect(alert!.resolved_at).not.toBeNull();
    const posted = sent.filter((m) => m.kind !== "daily.summary");
    expect(posted.some((m) => /resolved/i.test(String(m.text)) || String(m.kind).endsWith(".resolved"))).toBe(false);
    expect((await env.DB.prepare("SELECT state FROM cloud_alert_groups WHERE group_key='account.compromise'").first<{ state: string }>())?.state).toBe("closed");
    const digest = sent.filter((m) => m.kind === "daily.summary").pop()!.text as string;
    expect(digest).toContain("Watch ended, NOT confirmed resolved: 1 provider action");
  });
  it("each send has its own idempotency key: the reason is in it, a retry of the same send repeats it, and members not in the body are not marked handled", async () => {
    await silent(4);
    const keys: string[] = [];
    const store = new Map<string, number>();   // a deduping relay: the first status for a key is replayed for it
    let failNext = false;
    const relay = (async (_u: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["idempotency-key"];
      if (String(JSON.parse(init.body as string).kind).startsWith("page.")) keys.push(key);
      const status = store.get(key) ?? (failNext ? 500 : 200);
      if (String(JSON.parse(init.body as string).kind).startsWith("page.") && !store.has(key)) store.set(key, status);
      return new Response("x", { status });
    }) as unknown as typeof fetch;
    await sweep(NOW, relay);                                    // opened: 200
    for (let i = 0; i < 4; i++) await row(`h-d${i}`, "home.heartbeat_missed", NOW + 30_000);   // 8 of 4: count_doubled due
    failNext = true;
    await sweep(NOW + 60_000, relay);                           // count_doubled fails (relay stores a 500 under its key)
    await sweep(NOW + 60_000 + 3_700_000, relay);               // the retry of the SAME send repeats the key
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[1]);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[1]).toContain(":count_doubled:");
    // a member that joins afterwards makes a different body: a different key, so the stored 500 is not replayed for it
    await row("h-late", "home.heartbeat_missed", NOW + 60_000 + 3_700_000 + 1000);
    failNext = false;
    await sweep(NOW + 60_000 + 7_400_000, relay);
    expect(keys[3]).not.toBe(keys[1]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE delivered_at IS NULL").first<{ n: number }>())?.n).toBe(0);
    // a later still_open page of the same group never shares the key of an earlier reason
    await sweep(NOW + 60_000 + 7_400_000 + PAGE_REMIND_MS, relay);
    expect(keys[4]).toContain(":still_open:");
    expect(new Set(keys).size).toBe(keys.length - 1);           // only the retry repeated a key
  });
  it("a P8 whose webhook is down for 3 days past its age-out still gets its digest line, once, when the webhook recovers", async () => {
    await row("h-1", "access.provider_action_unexpected", NOW);
    const down = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const DAY = 86_400_000;
    for (let d = 0; d < 3; d++) await sweep(TUESDAY + d * DAY + 3_600_000, down);   // aged out on day 1, every post fails
    expect((await env.DB.prepare("SELECT resolved_at FROM cloud_alerts WHERE home_id='h-1'").first<{ resolved_at: number | null }>())!.resolved_at).not.toBeNull();
    const { sent, fetcher } = hook();
    await sweep(TUESDAY + 3 * DAY + 3_600_000, fetcher);        // recovered, 3 days after the age-out
    const first = sent.filter((m) => m.kind === "daily.summary").pop()!.text as string;
    expect(first).toContain("Watch ended, NOT confirmed resolved: 1 provider action");
    await sweep(TUESDAY + 4 * DAY + 3_600_000, fetcher);
    const second = sent.filter((m) => m.kind === "daily.summary").pop()!.text as string;
    expect(second).not.toContain("Watch ended");
    expect(sent.filter((m) => m.kind === "daily.summary" && String(m.text).includes("Watch ended"))).toHaveLength(1);
  });
  it("raiseAlert: a digest kind is recorded and never posted; a page kind pages its group", async () => {
    const { sent, pages, fetcher } = hook();
    expect(await raiseAlert(e(), { homeId: "h-a", kind: "home.disk_high", severity: "high", detail: "x" }, NOW, fetcher)).toBe(true);
    expect(sent).toHaveLength(0);
    expect((await env.DB.prepare("SELECT delivered_at FROM cloud_alerts WHERE home_id='h-a'").first<{ delivered_at: number | null }>())?.delivered_at).toBe(NOW);
    await raiseAlert(e(), { homeId: "h-b", kind: "home.watchdog_exhausted", severity: "high", detail: "x" }, NOW, fetcher);
    expect(pages()).toHaveLength(1);
    expect(pages()[0].group).toBe("homes.repair_gave_up");
  });
});

describe("the daily digest", () => {
  it("opens with 'Nothing needs you today.' when no page group is open", async () => {
    await row("h-d", "home.disk_high", TUESDAY - 3_600_000);
    const { sent, fetcher } = hook();
    await sweep(TUESDAY, fetcher);
    const text = sent.find((m) => m.kind === "daily.summary")!.text as string;
    expect(text.split("\n")[0]).toBe("Nothing needs you today.");
    expect(text).toContain("home.disk_high: 1 (h-d)");
    expect(text).not.toContain("Weekly review");
  });
  it("a lone provision.failed below its threshold is in the digest 24 h on, and the line is not 'Nothing needs you today.'", async () => {
    await row("h-p", "provision.failed", TUESDAY - 25 * 3_600_000);
    const { sent, fetcher } = hook();
    await sweep(TUESDAY, fetcher);
    const text = sent.find((m) => m.kind === "daily.summary")!.text as string;
    expect(text).not.toContain("Nothing needs you today.");
    expect(text.split("\n")[0]).toContain("1 open alert below the paging threshold");
    expect(text).toContain("provision.failed: 1 (h-p)");
  });
  it("below-threshold page-kind rows lead the Open items, so the 40-line cap folds away other kinds, and the headline counts them beside open groups", async () => {
    await silent(5, TUESDAY - 60_000);
    await row("h-p", "provision.failed", TUESDAY - 25 * 3_600_000);
    for (let i = 0; i < 45; i++) await row("h-x", `zz.digest_kind_${String(i).padStart(2, "0")}`, TUESDAY - 3_600_000);
    const { sent, fetcher } = hook();
    await sweep(TUESDAY, fetcher);
    const text = sent.find((m) => m.kind === "daily.summary")!.text as string;
    const lines = text.split("\n");
    expect(lines[0]).toBe("1 thing needs you (and 1 open alert below the paging threshold):");
    expect(lines.slice(1).join("\n")).not.toContain("below the paging threshold still need");
    expect(lines[lines.indexOf("Open items:") + 1]).toBe("- provision.failed: 1 (h-p)");
  });
  it("opens with 'N things need you:' and the open page groups", async () => {
    await silent(5, TUESDAY - 60_000); await row("pool", "pool.empty", TUESDAY - 1000);
    const { sent, fetcher } = hook();
    await sweep(TUESDAY, fetcher);
    const lines = (sent.find((m) => m.kind === "daily.summary")!.text as string).split("\n");
    expect(lines[0]).toBe("2 things need you:");
    expect(lines[1]).toContain("New customers not getting homes: 1 open");
    expect(lines[2]).toContain("Many homes unhealthy: 5 open");
    expect(lines[2]).toContain("Do this:");
  });
  it("on Mondays adds the weekly review: fired, time open, and whether support acted while it was open", async () => {
    await row("h-1", "home.watchdog_exhausted", NOW - 3 * 3_600_000, NOW - 1 * 3_600_000);
    await row("h-2", "home.watchdog_exhausted", NOW - 5 * 3_600_000, NOW - 4 * 3_600_000);
    await row("h-3", "image.sales_hold", NOW - 2 * 3_600_000, NOW - 3_600_000);
    await env.DB.prepare("INSERT INTO selfservice_audit (id,home_id,actor,action,outcome,detail,at) VALUES ('s1','h-1','operator','resume','ok','{}',?)").bind(NOW - 2 * 3_600_000).run();
    const { sent, fetcher } = hook();
    await sweep(NOW, fetcher);
    const text = sent.find((m) => m.kind === "daily.summary")!.text as string;
    expect(text).toContain("Weekly review");
    expect(text).toContain("home.watchdog_exhausted: fired 2, open 3 h, action recorded on 1");
    expect(text).toContain("image.sales_hold: fired 1, open 1 h, no action recorded: retune or demote");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
  it("CH1: flux.spending_off_unconfirmed and flux.undelivered_key_unrevoked page at once (one open row is enough)", async () => {
    await row("h-1", "flux.spending_off_unconfirmed", NOW - 1000);
    await row("h-2", "flux.undelivered_key_unrevoked", NOW - 1000);
    const { pages, fetcher } = hook();
    await sweep(NOW, fetcher);
    expect(pages().map((p) => p.group).sort()).toEqual(["flux.key_unrevoked", "flux.spending_off"]);
    expect(pages()[0]).toMatchObject({ mention: "here" });
    expect(pages()[0].text).toContain("Do this:");
  });
  it("CH1: flux.stop_pending stays out of the page tier for its first hour (the digest carries it), then pages; younger rows never page", async () => {
    await row("h-1", "flux.stop_pending", NOW - 59 * 60_000);
    const a = hook();
    await sweep(NOW, a.fetcher);
    expect(a.pages()).toHaveLength(0);
    const undelivered = await env.DB.prepare("SELECT delivered_at FROM cloud_alerts WHERE kind='flux.stop_pending'").first<{ delivered_at: number | null }>();
    expect(undelivered?.delivered_at).toBeNull();                 // waits, not swallowed as a digest row
    await sweep(NOW + 2 * 60_000, a.fetcher);                      // now 61 minutes old
    expect(a.pages()).toHaveLength(1);
    expect(a.pages()[0]).toMatchObject({ kind: "page.flux.stop_stuck", group: "flux.stop_stuck", count: 1 });
  });
  it("CH1: an old flux.stop_pending pages at exactly 60 minutes, and a fresh one beside it does not stop that", async () => {
    await row("h-old", "flux.stop_pending", NOW - 60 * 60_000);
    await row("h-new", "flux.stop_pending", NOW - 1000);
    const { pages, fetcher } = hook();
    await sweep(NOW, fetcher);
    expect(pages()).toHaveLength(1);
    expect(pages()[0].group).toBe("flux.stop_stuck");
  });
  it("CH1 M3: a fresh flux.stop_pending joining an OPEN group is not counted, named, paged or marked delivered until it is itself 60 minutes old", async () => {
    await row("h-old", "flux.stop_pending", NOW - 60 * 60_000);
    const a = hook();
    await sweep(NOW, a.fetcher);
    expect(a.pages()).toHaveLength(1);
    expect(a.pages()[0]).toMatchObject({ group: "flux.stop_stuck", count: 1, homes: ["h-old"] });
    await row("h-new", "flux.stop_pending", NOW + 1000);
    await sweep(NOW + 2000, a.fetcher);                             // count would "double" to 2 if the fresh row were counted
    expect(a.pages()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT delivered_at FROM cloud_alerts WHERE home_id='h-new'").first()).toEqual({ delivered_at: null });
    await sweep(NOW + 59 * 60_000, a.fetcher);                      // fresh row is 58 min 59 s old
    expect(a.pages()).toHaveLength(1);
    await sweep(NOW + 61 * 60_000 + 1000, a.fetcher);               // now it is old enough: counted, named, paged
    expect(a.pages()).toHaveLength(2);
    expect(a.pages()[1]).toMatchObject({ group: "flux.stop_stuck", count: 2, reason: "count_doubled" });
    expect(a.pages()[1].homes).toEqual(expect.arrayContaining(["h-old", "h-new"]));
  });
});

/** CH1 P4 (Astra r2): explicit barriers, no timing. Wraps a D1 so a chosen statement can wait before it runs (`before`) or after it has returned (`after`). */
function gated<T extends object>(target: T, match: (sql: string) => boolean, hooks: { before?: () => Promise<void>; after?: () => Promise<void> }): T {
  const wrapStmt = (st: D1PreparedStatement): D1PreparedStatement => new Proxy(st, { get(s, k) {
    const x = (s as unknown as Record<string | symbol, unknown>)[k];
    if (k === "bind") return (...a: unknown[]) => wrapStmt(s.bind(...a));
    if (k === "run" || k === "all" || k === "first") return async (...a: unknown[]) => {
      await hooks.before?.();
      const r = await (x as (...z: unknown[]) => Promise<unknown>).apply(s, a);
      await hooks.after?.();
      return r;
    };
    return typeof x === "function" ? x.bind(s) : x;
  } });
  return new Proxy(target, { get(t, p) {
    const v = (t as Record<string | symbol, unknown>)[p];
    if (p !== "prepare") return typeof v === "function" ? v.bind(t) : v;
    return (sql: string) => { const st = (t as unknown as D1Database).prepare(sql); return match(sql) ? wrapStmt(st) : st; };
  } });
}
/** A promise with its resolver. */
function latch() { let open!: () => void; const done = new Promise<void>((r) => { open = r; }); return { open, done }; }

describe("CH1 N3 (Astra r1): two overlapping sweeps page a group once", () => {
  const GROUPS_READ = (sql: string) => sql.trim() === "SELECT * FROM cloud_alert_groups";
  const pageMsgs = (sent: Record<string, any>[]) => sent.filter((m) => String(m.kind).startsWith("page."));
  it("both sweeps read the group closed (barrier), A claims and is mid-send, THEN B opens: exactly one page, one claim, no reset", async () => {
    await silent(12);
    // Barrier 1: neither sweep proceeds past its initial group read until BOTH have done it (both saw "closed").
    const aRead = latch(), bRead = latch();
    const afterRead = (mine: ReturnType<typeof latch>, other: ReturnType<typeof latch>) => async () => { mine.open(); await other.done; };
    // Barrier 2: B's INSERT (open the group) waits until A is INSIDE its send (claim held); A's send waits until B's INSERT has finished.
    const aInSend = latch(), bInserted = latch();
    const OPEN = (sql: string) => sql.includes("INSERT INTO cloud_alert_groups");
    const aDb = gated(env.DB, GROUPS_READ, { after: afterRead(aRead, bRead) });
    const bDb = gated(gated(env.DB, GROUPS_READ, { after: afterRead(bRead, aRead) }), OPEN, { before: () => aInSend.done, after: async () => bInserted.open() });
    const { sent, fetcher } = hook();
    const aSend = (async (url: string, init: RequestInit) => {
      aInSend.open();
      await bInserted.done;                              // B's open attempt has completed while A holds the claim
      return (fetcher as unknown as (u: string, i: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    const spy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try { await Promise.all([sweepMonitoring({ ...e(), DB: aDb } as Env, NOW, aSend), sweepMonitoring({ ...e(), DB: bDb } as Env, NOW, fetcher)]); } finally { spy.mockRestore(); }
    expect(pageMsgs(sent)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT state,pages,opened_at FROM cloud_alert_groups WHERE group_key='homes.unhealthy'").first()).toEqual({ state: "open", pages: 1, opened_at: NOW });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alert_pages WHERE group_key='homes.unhealthy'").first()).toEqual({ n: 1 });
  });
  it("both sweeps decide to page from the same read (barrier); B's claim is held until A has paged and released: B rechecks under its claim and sends nothing", async () => {
    await silent(12);
    // The group is already open and never paged, so both sweeps see "opened" due from their (identical) initial read.
    await env.DB.prepare("INSERT INTO cloud_alert_groups (group_key,state,opened_at,last_paged_at,last_paged_count,pages,peak_count,attempts,claim_until,closed_at) VALUES ('homes.unhealthy','open',?,NULL,0,0,0,0,NULL,NULL)")
      .bind(NOW - 1000).run();
    const aRead = latch(), bRead = latch(), aFinished = latch();
    const afterRead = (mine: ReturnType<typeof latch>, other: ReturnType<typeof latch>) => async () => { mine.open(); await other.done; };
    const CLAIM = (sql: string) => sql.startsWith("UPDATE cloud_alert_groups SET claim_until=? WHERE group_key=? AND (claim_until IS NULL");
    const aDb = gated(env.DB, GROUPS_READ, { after: afterRead(aRead, bRead) });
    const bDb = gated(gated(env.DB, GROUPS_READ, { after: afterRead(bRead, aRead) }), CLAIM, { before: () => aFinished.done });
    const { sent, fetcher } = hook();
    const spy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await Promise.all([
        sweepMonitoring({ ...e(), DB: aDb } as Env, NOW, fetcher).finally(() => aFinished.open()),
        sweepMonitoring({ ...e(), DB: bDb } as Env, NOW, fetcher),
      ]);
    } finally { spy.mockRestore(); }
    expect(pageMsgs(sent)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT pages FROM cloud_alert_groups WHERE group_key='homes.unhealthy'").first()).toEqual({ pages: 1 });
  });
});
