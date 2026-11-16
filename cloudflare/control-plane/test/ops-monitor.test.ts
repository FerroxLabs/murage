// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ALERT_BACKLOG_ALERT, ALERT_SEND_LIMIT, ALERT_STAGE_MS, deliver, raiseAlert, recordHealth, sweepMonitoring } from "../src/ops-monitor";
import { ALERT_BACKLOG_HUGE_ALERT, ALERT_BACKLOG_HUGE_AT } from "../src/alert-tiers";

const NOW = Date.UTC(2026, 9, 10, 8, 0, 0); // 08:00 UTC, past the summary hour
const e = (extra: Record<string, unknown> = {}) => ({ ...env, ALERT_WEBHOOK_URL: "https://hooks.example.test/x", ...extra }) as Env;

async function home(id: string, heartbeatAt: number | null) {
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at,heartbeat_at)
    VALUES (?,?,?,'ready','ready','sha256:x','k',?,?,?)`).bind(id, `inst-${id}`, "owner", NOW - 10 * 60_000, NOW - 10 * 60_000, heartbeatAt).run();
}
/** A sweep at virtual time t: delivery reads Date.now() itself (Astra AUTOCANARY-9 P2), so the clock is t for the whole sweep. */
async function sweepAt(t: number, fetcher: typeof fetch, extra: Record<string, unknown> = {}) {
  const spy = vi.spyOn(Date, "now").mockReturnValue(t);
  try { await sweepMonitoring(e(extra), t, fetcher); } finally { spy.mockRestore(); }
}
function hook() {
  const sent: Record<string, any>[] = [];
  const keys: (string | null)[] = [];
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string)); keys.push(new Headers(init.headers).get("idempotency-key")); return new Response("ok"); });
  return { sent, keys, fetcher: fetcher as unknown as typeof fetch };
}
/** A webhook that refuses the "many homes unhealthy" page and accepts everything else. */
function refusingGroupHook() {
  const sent: Record<string, any>[] = [];
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string); sent.push(body);
    return body.kind === "page.homes.unhealthy" ? new Response("no", { status: 500 }) : new Response("ok"); });
  return { sent, fetcher: fetcher as unknown as typeof fetch };
}

describe("heartbeat health schema", () => {
  it("rejects free text on events and unknown fields so no credential content can ride a heartbeat", async () => {
    const { healthSchema } = await import("../src/ops-monitor");
    expect(healthSchema.safeParse({ events: [{ type: "abuse.mining_suspected", at: 1, detail: "sk-ant-oat01-secret" }] }).success).toBe(false);
    expect(healthSchema.safeParse({ token: "x" }).success).toBe(false);
    expect(healthSchema.safeParse({ diskUsedPercent: 50, lastBackupAt: 1, events: [{ type: "abuse.mining_suspected", at: 1 }] }).success).toBe(true);
  });
});

/** The state of the open and resolved rows of a kind, as the evidence: rows are one per home and kind whatever the delivery does. */
const rows = (kind: string) => env.DB.prepare("SELECT home_id,severity,resolved_at,delivered_at FROM cloud_alerts WHERE kind=? ORDER BY home_id").bind(kind)
  .all<{ home_id: string; severity: string; resolved_at: number | null; delivered_at: number | null }>().then((r) => r.results);
async function silentHomes(n: number, at: number) { for (let i = 0; i < n; i++) await home(`h-s${i}`, at); }
const groupRow = () => env.DB.prepare("SELECT state,last_paged_at,pages,attempts,claim_until FROM cloud_alert_groups WHERE group_key='homes.unhealthy'")
  .first<{ state: string; last_paged_at: number | null; pages: number; attempts: number; claim_until: number | null }>();

describe("monitoring sweep", () => {
  it("records one alert row when a home misses heartbeats for 5 minutes, resolves it when it returns, and never posts a single silent home", async () => {
    await home("h-silent", NOW - 6 * 60_000); await home("h-ok", NOW - 60_000);
    const { sent, fetcher } = hook();
    await sweepMonitoring(e(), NOW, fetcher);
    await sweepMonitoring(e(), NOW + 60_000, fetcher);
    const opened = await rows("home.heartbeat_missed");
    expect(opened).toHaveLength(1);                               // deduplicated: one open row per home and kind
    expect(opened[0]).toMatchObject({ home_id: "h-silent", severity: "high", resolved_at: null });
    await env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=? WHERE id='h-silent'").bind(NOW + 90_000).run();
    await sweepMonitoring(e(), NOW + 120_000, fetcher);
    expect((await rows("home.heartbeat_missed"))[0].resolved_at).toBe(NOW + 120_000);
    expect(sent.filter((m) => m.kind !== "daily.summary")).toHaveLength(0);   // one silent home is below the P4 threshold: no page, no resolve notice
  });
  it("does not alert at 4 minutes", async () => {
    await home("h-4", NOW - 4 * 60_000);
    const { sent, fetcher } = hook();
    await sweepMonitoring(e(), NOW, fetcher);
    expect(await rows("home.heartbeat_missed")).toHaveLength(0);
    expect(sent.filter((m) => m.kind === "home.heartbeat_missed")).toHaveLength(0);
  });
  it("records an alert when disk passes 85% (a digest item, never posted) and records heartbeat health", async () => {
    await home("h-disk", NOW - 1000);
    const { sent, fetcher } = hook();
    await recordHealth(env as Env, "h-disk", { diskUsedPercent: 84 }, NOW, fetcher);
    await sweepMonitoring(e(), NOW, fetcher);
    expect(await rows("home.disk_high")).toHaveLength(0);
    await recordHealth(env as Env, "h-disk", { diskUsedPercent: 86 }, NOW, fetcher);
    await sweepMonitoring(e(), NOW, fetcher);
    const disk = await rows("home.disk_high");
    expect(disk).toHaveLength(1);
    expect(disk[0].delivered_at).toBe(NOW);                       // handled, so the backlog never counts it
    expect(sent.filter((m) => m.kind === "home.disk_high")).toHaveLength(0);
  });
  it("records an alert on a stale backup but not on a home that has not reported one yet", async () => {
    await home("h-b", NOW - 1000); await home("h-nb", NOW - 1000);
    const { fetcher } = hook();
    await recordHealth(env as Env, "h-b", { lastBackupAt: NOW - 30 * 3_600_000 }, NOW, fetcher);
    await sweepMonitoring(e(), NOW, fetcher);
    const stale = await rows("home.backup_stale");
    expect(stale).toHaveLength(1); expect(stale[0].home_id).toBe("h-b");
  });
  it("routes the mining flag through the same alert path as abuse.mining_suspected, deduplicated; a digest kind is recorded and handled, never posted", async () => {
    const { sent, fetcher } = hook();
    const event = { type: "abuse.mining_suspected" as const, at: NOW };
    await recordHealth(e(), "h-m", { events: [event] }, NOW, fetcher);
    await recordHealth(e(), "h-m", { events: [event] }, NOW + 1000, fetcher);
    const found = await env.DB.prepare("SELECT kind,severity FROM cloud_alerts WHERE home_id='h-m'").all<{ kind: string; severity: string }>();
    expect(found.results).toEqual([{ kind: "abuse.mining_suspected", severity: "high" }]);
    await sweepMonitoring(e(), NOW + 2000, fetcher);
    expect(sent.filter((m) => m.kind !== "daily.summary")).toHaveLength(0);
    expect((await rows("abuse.mining_suspected"))[0].delivered_at).not.toBeNull();   // handled when raised, so the backlog never counts it
    expect(await raiseAlert(e(), { homeId: "h-m", kind: "abuse.mining_suspected", severity: "high", detail: "again" }, NOW, fetcher)).toBe(false);
  });
  it("sends one daily digest per UTC day and none before the summary hour", async () => {
    await home("h-s", NOW - 1000);
    const { sent, fetcher } = hook();
    await sweepMonitoring(e(), Date.UTC(2026, 9, 10, 3, 0, 0), fetcher);
    expect(sent.filter((m) => m.kind === "daily.summary")).toHaveLength(0);
    await sweepMonitoring(e(), NOW, fetcher); await sweepMonitoring(e(), NOW + 300_000, fetcher);
    const summaries = sent.filter((m) => m.kind === "daily.summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].text).toContain("Daily digest 2026-10-10");
    await sweepMonitoring(e(), NOW + 86_400_000, fetcher);
    expect(sent.filter((m) => m.kind === "daily.summary")).toHaveLength(2);
  });
  it("keeps an undelivered page and retries it when the webhook comes back; non-https webhooks are never called", async () => {
    await silentHomes(3, NOW - 10 * 60_000);
    const fail = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await sweepAt(NOW, fail);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='home.heartbeat_missed' AND delivered_at IS NULL").first<{ n: number }>())?.n).toBe(3);
    const { sent, fetcher } = hook();
    await sweepAt(NOW + 300_000, fetcher);
    expect(sent.filter((m) => m.kind === "page.homes.unhealthy")).toHaveLength(1);
    const insecure = vi.fn();
    await sweepAt(NOW + 600_000, insecure as unknown as typeof fetch, { ALERT_WEBHOOK_URL: "http://insecure.test/x" });
    expect(insecure).not.toHaveBeenCalled();
  });
  it("a page carries its payload fields and its idempotency key", async () => {
    await silentHomes(3, NOW - 6 * 60_000);
    const { sent, keys, fetcher } = hook();
    await sweepAt(NOW, fetcher);
    const page = sent.find((m) => m.kind === "page.homes.unhealthy")!;
    expect(Object.keys(page).sort()).toEqual(["at", "count", "group", "homes", "kind", "mention", "reason", "severity", "text"]);
    expect(keys[sent.indexOf(page)]).toMatch(new RegExp(`^group:homes\\.unhealthy:${NOW}:opened:1:[0-9a-f]+$`));
  });
});

describe("a digest alert whose contents change is still never posted", () => {
  it("a membership change on a refund alert re-arms it, and the sweep marks it handled without a post (was: Astra WP3-4 #3 acknowledgement of one detail)", async () => {
    const A = JSON.stringify({ opId: "a", opIds: ["a"] }); const AB = JSON.stringify({ opId: "a", opIds: ["a", "b"] });
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('al-rev','h-rev','refund.reconcile_stuck','high',?,?)").bind(A, NOW).run();
    const { sent, fetcher } = hook();
    await sweepAt(NOW, fetcher);
    await env.DB.prepare("UPDATE cloud_alerts SET detail=?,delivered_at=NULL,delivery_attempts=0 WHERE id='al-rev'").bind(AB).run();
    await sweepAt(NOW + 60_000, fetcher);
    expect(sent.filter((m) => m.kind !== "daily.summary")).toHaveLength(0);
    expect(await env.DB.prepare("SELECT detail,delivered_at FROM cloud_alerts WHERE id='al-rev'").first()).toEqual({ detail: AB, delivered_at: NOW + 60_000 });
  });
});

describe("Astra AUTOCANARY-7 P2 (now per page group): recoverable delivery claims", () => {
  it("a failed resolve message stays owed and is sent by a later sweep once the group's claim lapses, exactly once", async () => {
    await silentHomes(3, NOW - 6 * 60_000);
    const { sent, fetcher } = hook();
    await sweepAt(NOW, fetcher);
    await env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=?").bind(NOW + 5_000).run();   // the homes return: the sweep resolves their rows
    let tries = 0;
    const down = (async (_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).kind === "page.homes.unhealthy.resolved") tries++;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    await sweepAt(NOW + 10_000, down);
    expect(tries).toBe(1);
    expect(await groupRow()).toMatchObject({ state: "open" });
    expect(await env.DB.prepare("SELECT attempts FROM cloud_alert_group_budget WHERE group_key='homes.unhealthy' AND reason='resolved'").first()).toEqual({ attempts: 1 });
    expect((await groupRow())!.claim_until).toBeGreaterThanOrEqual(NOW + 10_000 + 60_000);
    // Within the claim nothing is sent; after it lapses the message goes, and then the group is closed for good.
    await sweepAt(NOW + 40_000, fetcher);
    expect(sent.filter((m) => m.kind === "page.homes.unhealthy.resolved")).toHaveLength(0);
    await sweepAt(NOW + 10_000 + 120_000, fetcher);
    await sweepAt(NOW + 250_000, fetcher);
    expect(sent.filter((m) => m.kind === "page.homes.unhealthy.resolved")).toHaveLength(1);
    expect(await groupRow()).toMatchObject({ state: "closed", attempts: 0, claim_until: null });
    // The rows' own resolution notices are cleared, never sent one by one.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE resolve_notice_due=1").first<{ n: number }>())?.n).toBe(0);
  });
  it("a sender that died mid-send (claim held, nothing acknowledged) is retried after the claim lapses", async () => {
    await silentHomes(3, NOW - 6 * 60_000);
    await env.DB.prepare(`INSERT INTO cloud_alert_groups (group_key,state,opened_at,attempts,claim_until) VALUES ('homes.unhealthy','open',?,1,?)`).bind(NOW - 1000, NOW + 60_000).run();
    const { sent, fetcher } = hook();
    await sweepAt(NOW + 59_000, fetcher);
    expect(sent.filter((m) => m.kind === "page.homes.unhealthy")).toHaveLength(0);
    await sweepAt(NOW + 60_000, fetcher);
    expect(sent.filter((m) => m.kind === "page.homes.unhealthy")).toHaveLength(1);
    expect(await groupRow()).toMatchObject({ pages: 1, attempts: 0, claim_until: null, last_paged_at: NOW + 60_000 });
  });
  it("two concurrent sweeps send one page once; the send carries its idempotency key as a header", async () => {
    await silentHomes(3, NOW - 6 * 60_000);
    const bodies: Record<string, unknown>[] = [];
    const headers: (string | null)[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.kind === "page.homes.unhealthy") { bodies.push(body); headers.push(new Headers(init.headers).get("idempotency-key")); await gate; }
      return new Response("ok");
    }) as unknown as typeof fetch;
    const first = sweepMonitoring(e(), NOW, fetcher);
    const second = sweepMonitoring(e(), NOW, fetcher);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([first, second]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("idempotencyKey");
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatch(new RegExp(`^group:homes\\.unhealthy:${NOW}:opened:1:[0-9a-f]+$`));
    expect(await groupRow()).toMatchObject({ pages: 1 });
  });
  it("a stalled webhook costs the sweep a bounded delivery stage: no page starts after the stage budget", async () => {
    for (const k of ["rollout.halted", "update.stuck", "image.sales_hold", "billing.webhook_stuck", "pool.empty"]) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,'high','d',?)").bind(`al-${k}`, `x-${k}`, k, NOW).run();
    }
    // A virtual clock: each send stalls until its ALERT_POST_TIMEOUT_MS bound (10 s), moving it 10 s.
    let clock = NOW, calls = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const stalled = (async (_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).kind === "daily.summary") return new Response("ok");
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      clock += 10_000;
      throw new Error("stalled until its bound");
    }) as unknown as typeof fetch;
    try { await sweepMonitoring(e(), NOW, stalled); } finally { now.mockRestore(); }
    // Pages start at 0, 10, 20 and 30 s; at 40 s the budget (ALERT_STAGE_MS = 30 s) is spent, so 4 of the 5, never all of them in series.
    expect(ALERT_STAGE_MS).toBe(30_000);
    expect(calls).toBe(4);
    const owed = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE delivered_at IS NULL").first<{ n: number }>();
    expect(owed!.n).toBe(5);
  });
});

describe("Astra AUTOCANARY-8 P2 (now per page group): claims are dated when written; digest rows and row notices are never posted", () => {
  const claim = (id: string) => env.DB.prepare("SELECT delivered_at,delivery_attempts,delivery_claim_until FROM cloud_alerts WHERE id=?").bind(id)
    .first<Record<string, number | null>>();
  it("a group claim written late in a long sweep is dated then, not at the sweep's start", async () => {
    await silentHomes(3, NOW - 6 * 60_000);
    // The sweep was handed now=NOW but the wall clock is 70 s later when it delivers: the claim is dated by the wall clock.
    const clock = NOW + 70_000; let claimUntil: number | null = null;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const slow = (async (_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).kind === "page.homes.unhealthy") claimUntil = (await groupRow())!.claim_until;
      return new Response("ok");
    }) as unknown as typeof fetch;
    try { await sweepMonitoring(e(), NOW, slow); } finally { spy.mockRestore(); }
    expect(claimUntil).toBe(NOW + 70_000 + 60_000);               // dated when written, never at NOW
    expect(await groupRow()).toMatchObject({ pages: 1, claim_until: null });
  });
  it("a row send whose claim no longer covers the POST is skipped, and its page is sent by a later sweep", async () => {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('al-x','h-x','home.watchdog_exhausted','high','d',?)").bind(NOW).run();
    const { sent, fetcher } = hook();
    // The clock jumps 55 s between the claim being written and the POST: 55 + ALERT_POST_TIMEOUT_MS is past the 60 s claim.
    const times = [NOW, NOW + 55_000];
    const spy = vi.spyOn(Date, "now").mockImplementation(() => times.shift() ?? NOW + 55_000);
    try {
      expect(await deliver(e(), "al-x", "d", { kind: "home.watchdog_exhausted", text: "x" }, NOW, fetcher)).toBe(false);
    } finally { spy.mockRestore(); }
    expect(sent).toHaveLength(0);
    expect(await claim("al-x")).toMatchObject({ delivered_at: null, delivery_attempts: 1, delivery_claim_until: NOW + 60_000 });
    await sweepMonitoring(e(), NOW + 60_000, fetcher);
    expect(sent.filter((m) => m.kind === "page.homes.repair_gave_up")).toHaveLength(1);
    expect(await claim("al-x")).toMatchObject({ delivered_at: NOW + 60_000 });   // handled by the group page, not by a row send
  });
  it("fifty digest alerts and 25 row resolution notices: nothing is posted, every row is handled, every notice cleared, no backlog", async () => {
    for (let i = 0; i < 50; i++) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.disk_high','medium','d',?)")
        .bind(`al-b${i}`, `h-b${i}`, NOW - 100_000 + i).run();
    }
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,delivered_at,resolved_at,resolve_notice_due)
        VALUES (?,?,'home.backup_stale','medium','d',?,?,?,1)`).bind(`al-r${i}`, `h-r${i}`, NOW - 200_000, NOW - 200_000, NOW - 50_000 + i).run();
    }
    const { sent, fetcher } = hook();
    await sweepAt(NOW, fetcher);
    expect(sent.filter((m) => m.kind !== "daily.summary")).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='home.disk_high' AND delivered_at IS NULL").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE resolve_notice_due=1").first<{ n: number }>())?.n).toBe(0);
    expect(await rows(ALERT_BACKLOG_ALERT)).toEqual([]);
  });
});

describe("Astra AUTOCANARY-9 P2: delivery reads its own clock; a backlog is itself an alert", () => {
  it("a long-running caller's stale now never dates a claim: two concurrent sends of one alert make one POST", async () => {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('al-s','h-s','home.disk_high','medium','d',?)")
      .bind(NOW).run();
    // The caller took now=NOW and reaches delivery 70 s later. Dated at NOW the claim (NOW + 60 s) would already have lapsed.
    let clock = NOW + 70_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    let posts = 0, release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const fetcher = (async () => { posts++; await held; return new Response("ok"); }) as unknown as typeof fetch;
    try {
      const first = deliver(e(), "al-s", "d", { kind: "home.disk_high", text: "x" }, NOW, fetcher);
      await new Promise((r) => setTimeout(r, 20));
      expect(posts).toBe(1);
      const claim = await env.DB.prepare("SELECT delivery_claim_until FROM cloud_alerts WHERE id='al-s'").first<{ delivery_claim_until: number }>();
      expect(claim!.delivery_claim_until).toBe(NOW + 70_000 + 60_000);
      clock = NOW + 75_000; // a second sender, inside the real claim, with an equally stale now
      expect(await deliver(e(), "al-s", "d", { kind: "home.disk_high", text: "x" }, NOW, fetcher)).toBe(false);
      expect(posts).toBe(1);
      release();
      expect(await first).toBe(true);
    } finally { spy.mockRestore(); }
  });
  it("a backlog of undelivered PAGE rows raises alerts.backlog (a digest item, never posted), resolved once the queue fits", async () => {
    // Heartbeat alerts whose group page cannot be delivered (the webhook refuses it) wait undelivered, however spread out: a queue of 70 is
    // more than one sweep's limit of 60. The failed sends do not hide them from the backlog count.
    for (let i = 0; i < ALERT_SEND_LIMIT + 10; i++) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.heartbeat_missed','high','d',?)")
        .bind(`al-o${i}`, `h-o${i}`, NOW - 1_000_000 + i).run();
    }
    const { sent, fetcher } = refusingGroupHook();
    await sweepMonitoring(e(), NOW, fetcher);
    const backlog = () => env.DB.prepare("SELECT resolved_at,delivered_at FROM cloud_alerts WHERE home_id='ops' AND kind=?").bind(ALERT_BACKLOG_ALERT).first<{ resolved_at: number | null; delivered_at: number | null }>();
    expect(await backlog()).toEqual({ resolved_at: null, delivered_at: NOW + 0 });
    expect(sent.filter((m) => m.kind !== "daily.summary" && m.kind !== "page.homes.unhealthy")).toHaveLength(0);
    expect(ALERT_SEND_LIMIT).toBe(60);
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=? WHERE id LIKE 'al-o%'").bind(NOW).run();
    await sweepMonitoring(e(), NOW + 300_000, fetcher);
    expect((await backlog())!.resolved_at).toBe(NOW + 300_000);
  });
  it("only a HUGE backlog pages (alerts.backlog_huge), once, and it resolves with one message when the queue drains", async () => {
    for (let i = 0; i < ALERT_BACKLOG_HUGE_AT + 10; i++) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.heartbeat_missed','high','d',?)")
        .bind(`al-h${i}`, `h-h${i}`, NOW - 1_000_000 + i).run();
    }
    const { sent, fetcher } = refusingGroupHook();
    await sweepMonitoring(e(), NOW, fetcher);
    await sweepMonitoring(e(), NOW + 60_000, fetcher);
    const pages = sent.filter((m) => String(m.kind).startsWith("page.") && m.kind !== "page.homes.unhealthy");
    expect(pages.map((m) => m.kind)).toEqual(["page.alerts.backlog_huge"]);
    expect(pages[0].text).toContain("Do this:");
    expect(await rows(ALERT_BACKLOG_HUGE_ALERT)).toHaveLength(1);
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=? WHERE id LIKE 'al-h%'").bind(NOW).run();
    await sweepMonitoring(e(), NOW + 300_000, fetcher);
    await sweepMonitoring(e(), NOW + 360_000, fetcher);
    expect(sent.filter((m) => m.kind === "page.alerts.backlog_huge.resolved")).toHaveLength(1);
  });
});
