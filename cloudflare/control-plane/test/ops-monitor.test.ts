// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ALERT_BACKLOG_ALERT, ALERT_OLDEST_SHARE, ALERT_SEND_LIMIT, RESOLUTION_SEND_LIMIT, deliver, raiseAlert, recordHealth, sweepMonitoring } from "../src/ops-monitor";

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

describe("heartbeat health schema", () => {
  it("rejects free text on events and unknown fields so no credential content can ride a heartbeat", async () => {
    const { healthSchema } = await import("../src/ops-monitor");
    expect(healthSchema.safeParse({ events: [{ type: "abuse.mining_suspected", at: 1, detail: "sk-ant-oat01-secret" }] }).success).toBe(false);
    expect(healthSchema.safeParse({ token: "x" }).success).toBe(false);
    expect(healthSchema.safeParse({ diskUsedPercent: 50, lastBackupAt: 1, events: [{ type: "abuse.mining_suspected", at: 1 }] }).success).toBe(true);
  });
});

describe("monitoring sweep", () => {
  it("alerts once when a home misses heartbeats for 5 minutes, then resolves when it returns", async () => {
    await home("h-silent", NOW - 6 * 60_000); await home("h-ok", NOW - 60_000);
    const { sent, fetcher } = hook();
    await sweepMonitoring(e(), NOW, fetcher);
    await sweepMonitoring(e(), NOW + 60_000, fetcher);
    const alerts = sent.filter((m) => m.kind === "home.heartbeat_missed");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ homeId: "h-silent", severity: "high" });
    expect(alerts[0].text).toContain("h-silent");
    await env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=? WHERE id='h-silent'").bind(NOW + 90_000).run();
    await sweepMonitoring(e(), NOW + 120_000, fetcher);
    expect(sent.some((m) => m.kind === "home.heartbeat_missed.resolved")).toBe(true);
  });
  it("does not alert at 4 minutes", async () => {
    await home("h-4", NOW - 4 * 60_000);
    const { sent, fetcher } = hook();
    await sweepMonitoring(e(), NOW, fetcher);
    expect(sent.filter((m) => m.kind === "home.heartbeat_missed")).toHaveLength(0);
  });
  it("alerts when disk passes 85% and records heartbeat health", async () => {
    await home("h-disk", NOW - 1000);
    const { sent, fetcher } = hook();
    await recordHealth(env as Env, "h-disk", { diskUsedPercent: 84 }, NOW, fetcher);
    await sweepMonitoring(e(), NOW, fetcher);
    expect(sent.filter((m) => m.kind === "home.disk_high")).toHaveLength(0);
    await recordHealth(env as Env, "h-disk", { diskUsedPercent: 86 }, NOW, fetcher);
    await sweepMonitoring(e(), NOW, fetcher);
    expect(sent.filter((m) => m.kind === "home.disk_high")).toHaveLength(1);
  });
  it("alerts on a stale backup but not on a home that has not reported one yet", async () => {
    await home("h-b", NOW - 1000); await home("h-nb", NOW - 1000);
    const { sent, fetcher } = hook();
    await recordHealth(env as Env, "h-b", { lastBackupAt: NOW - 30 * 3_600_000 }, NOW, fetcher);
    await sweepMonitoring(e(), NOW, fetcher);
    const stale = sent.filter((m) => m.kind === "home.backup_stale");
    expect(stale).toHaveLength(1); expect(stale[0].homeId).toBe("h-b");
  });
  it("routes the mining flag through the same alert path as abuse.mining_suspected, deduplicated", async () => {
    const { sent, fetcher } = hook();
    const event = { type: "abuse.mining_suspected" as const, at: NOW };
    await recordHealth(e(), "h-m", { events: [event] }, NOW, fetcher);
    await recordHealth(e(), "h-m", { events: [event] }, NOW + 1000, fetcher);
    const rows = await env.DB.prepare("SELECT kind,severity FROM cloud_alerts WHERE home_id='h-m'").all<{ kind: string; severity: string }>();
    expect(rows.results).toEqual([{ kind: "abuse.mining_suspected", severity: "high" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "abuse.mining_suspected", homeId: "h-m" });
    expect(Object.keys(sent[0]).sort()).toEqual(["at", "homeId", "kind", "severity", "text"]);
    expect(sent[0].text).toBe("[murage-cloud] abuse.mining_suspected home=h-m: reported by the home");
    expect(await raiseAlert(e(), { homeId: "h-m", kind: "abuse.mining_suspected", severity: "high", detail: "again" }, NOW, fetcher)).toBe(false);
  });
  it("sends one daily summary per UTC day and none before the summary hour", async () => {
    await home("h-s", NOW - 1000);
    const { sent, fetcher } = hook();
    await sweepMonitoring(e(), Date.UTC(2026, 9, 10, 3, 0, 0), fetcher);
    expect(sent.filter((m) => m.kind === "daily.summary")).toHaveLength(0);
    await sweepMonitoring(e(), NOW, fetcher); await sweepMonitoring(e(), NOW + 300_000, fetcher);
    const summaries = sent.filter((m) => m.kind === "daily.summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].text).toContain("daily summary 2026-10-10");
    await sweepMonitoring(e(), NOW + 86_400_000, fetcher);
    expect(sent.filter((m) => m.kind === "daily.summary")).toHaveLength(2);
  });
  it("keeps undelivered alerts and retries them when the webhook comes back; non-https webhooks are never called", async () => {
    await home("h-r", NOW - 10 * 60_000);
    const fail = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await sweepAt(NOW, fail);
    expect((await env.DB.prepare("SELECT delivered_at FROM cloud_alerts WHERE home_id='h-r'").first<{ delivered_at: number | null }>())?.delivered_at).toBeNull();
    const { sent, fetcher } = hook();
    await sweepAt(NOW + 300_000, fetcher);
    expect(sent.some((m) => m.kind === "home.heartbeat_missed")).toBe(true);
    const insecure = vi.fn(); 
    await sweepAt(NOW + 600_000, insecure as unknown as typeof fetch, { ALERT_WEBHOOK_URL: "http://insecure.test/x" });
    expect(insecure).not.toHaveBeenCalled();
  });
});

describe("Astra WP3-4 #3: an acknowledgement clears only the detail it delivered", () => {
  it("a membership change while [A] is being posted is a new notification: the old acknowledgement never marks [A,B] delivered", async () => {
    const A = JSON.stringify({ opId: "a", opIds: ["a"] }); const AB = JSON.stringify({ opId: "a", opIds: ["a", "b"] });
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('al-rev','h-rev','refund.reconcile_stuck','high',?,?)").bind(A, NOW).run();
    const sent: string[] = [];
    let changeDuringPost = true;
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string).text);
      if (changeDuringPost) {
        changeDuringPost = false; // the membership grows after [A] left but before its acknowledgement is written (reconcileAlertStmts' reset)
        await env.DB.prepare("UPDATE cloud_alerts SET detail=?,delivered_at=NULL,delivery_attempts=0 WHERE id='al-rev'").bind(AB).run();
      }
      return new Response("ok");
    }) as unknown as typeof fetch;
    const row = () => env.DB.prepare("SELECT detail,delivered_at FROM cloud_alerts WHERE id='al-rev'").first<{ detail: string; delivered_at: number | null }>();
    await sweepAt(NOW, fetcher);
    expect(sent.filter((t) => t.includes("refund.reconcile_stuck home=h-rev"))).toHaveLength(1);
    expect(await row()).toMatchObject({ detail: AB, delivered_at: null }); // [A,B] is still owed to ops
    await sweepAt(NOW + 60_000, fetcher);
    const texts = sent.filter((t) => t.includes("refund.reconcile_stuck home=h-rev"));
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain(AB);
    expect(await row()).toMatchObject({ detail: AB, delivered_at: NOW + 60_000 });
    await sweepAt(NOW + 120_000, fetcher);
    expect(sent.filter((t) => t.includes("refund.reconcile_stuck home=h-rev"))).toHaveLength(2); // delivered once per detail
  });
});

describe("Astra AUTOCANARY-7 P2: recoverable delivery claims for alerts and resolution notices", () => {
  const row = (id: string) => env.DB.prepare(`SELECT delivered_at,delivery_attempts,delivery_claim_until,resolved_at,resolve_notice_due,resolve_attempts,
    resolve_claim_until FROM cloud_alerts WHERE id=?`).bind(id).first<Record<string, number | null>>();
  it("a failed resolution notice stays owed and is sent by a later sweep once its claim lapses, exactly once", async () => {
    await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,delivered_at,resolved_at,resolve_notice_due)
      VALUES ('al-n','h-n','home.ui_render_missing','high','d',?,?,?,1)`).bind(NOW - 60_000, NOW - 60_000, NOW).run();
    let tries = 0;
    const down = (async (_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).kind === "home.ui_render_missing.resolved") tries++;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    await sweepAt(NOW, down);
    expect(tries).toBe(1);
    expect(await row("al-n")).toMatchObject({ resolve_notice_due: 1, resolve_attempts: 1 });
    // Dated when written (Astra AUTOCANARY-8 P2): the sweep's NOW plus the little real time it took to get there.
    expect((await row("al-n"))!.resolve_claim_until).toBeGreaterThanOrEqual(NOW + 60_000);
    expect((await row("al-n"))!.resolve_claim_until).toBeLessThan(NOW + 59_000 + 1_000 + 1_000);
    // Within the claim nothing is sent; after it lapses the notice goes, and then it is acknowledged for good.
    const { sent, keys, fetcher } = hook();
    await sweepAt(NOW + 30_000, fetcher);
    expect(sent.filter((m) => m.kind === "home.ui_render_missing.resolved")).toHaveLength(0);
    await sweepAt(NOW + 60_000, fetcher);
    await sweepAt(NOW + 300_000, fetcher);
    const notices = sent.filter((m) => m.kind === "home.ui_render_missing.resolved");
    expect(notices).toHaveLength(1);
    expect(keys[sent.indexOf(notices[0])]).toBe("alert:al-n:resolved");
    expect(await row("al-n")).toMatchObject({ resolve_notice_due: null, resolve_attempts: 2, resolve_claim_until: null });
  });
  it("a sender that died mid-send (claim held, nothing acknowledged) is retried after the claim lapses", async () => {
    await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,delivery_attempts,delivery_claim_until)
      VALUES ('al-d','h-d','home.disk_high','medium','d',?,1,?)`).bind(NOW, NOW + 60_000).run();
    const { sent, fetcher } = hook();
    await sweepAt(NOW + 59_000, fetcher);
    expect(sent.filter((m) => m.homeId === "h-d")).toHaveLength(0);
    await sweepAt(NOW + 60_000, fetcher);
    expect(sent.filter((m) => m.homeId === "h-d")).toHaveLength(1);
    expect(await row("al-d")).toMatchObject({ delivered_at: NOW + 60_000, delivery_attempts: 2, delivery_claim_until: null });
  });
  it("two concurrent sweeps send one persisted alert once; the send carries its idempotency key as a header", async () => {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('al-c','h-c','home.ui_render_missing','high','d',?)")
      .bind(NOW).run();
    const bodies: Record<string, unknown>[] = [];
    const headers: (string | null)[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.homeId === "h-c") { bodies.push(body); headers.push(new Headers(init.headers).get("idempotency-key")); await gate; }
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
    expect(headers[0]).toMatch(/^alert:al-c:[0-9a-f]{8}$/);
    expect(await row("al-c")).toMatchObject({ delivered_at: NOW, delivery_attempts: 1 });
  });
  it("a stalled webhook costs the sweep a bounded delivery stage: sends run in parallel and none starts after the stage budget", async () => {
    for (let i = 0; i < 40; i++) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.ui_render_missing','high','d',?)")
        .bind(`al-s${i}`, `h-s${i}`, NOW + i).run();
    }
    // A virtual clock: each send stalls until its ALERT_POST_TIMEOUT_MS bound (10 s), so every wave of parallel sends moves it 10 s.
    let clock = NOW, calls = 0, inflight = 0, most = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const stalled = (async (_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).kind === "daily.summary") return new Response("ok");
      const k = calls++;
      most = Math.max(most, ++inflight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inflight--;
      clock = Math.max(clock, NOW + 10_000 * (Math.floor(k / 10) + 1));
      throw new Error("stalled until its bound");
    }) as unknown as typeof fetch;
    try {
      await sweepMonitoring(e(), NOW, stalled);
    } finally { now.mockRestore(); }
    expect(most).toBe(10);
    // 10 at a time, 10 s each: waves start at 0, 10 and 20 s; at 30 s the stage budget is spent, so 30 sends, never 40 in series.
    expect(calls).toBe(30);
    const owed = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE id LIKE 'al-s%' AND delivered_at IS NULL").first<{ n: number }>();
    expect(owed!.n).toBe(40);
  });
});

describe("Astra AUTOCANARY-8 P2: claims are dated when written; resolutions are never starved by an alert backlog", () => {
  const claim = (id: string) => env.DB.prepare("SELECT delivered_at,delivery_attempts,delivery_claim_until FROM cloud_alerts WHERE id=?").bind(id)
    .first<Record<string, number | null>>();
  it("a claim written late in a long sweep is dated then, not at the sweep's start", async () => {
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.disk_high','medium','d',?)")
        .bind(`al-t${i}`, `h-t${i}`, NOW + i).run();
    }
    // A virtual clock: the sweep starts at NOW (its first Date.now()) and spends 70 s recording before it delivers; each send then
    // takes about 9.9 s. Dated at the sweep's start, every claim (NOW + 60 s) would be expired before its POST began.
    let clock = NOW + 70_000, calls = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? NOW : clock));
    const slow = (async (_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).kind === "daily.summary") return new Response("ok");
      await new Promise((resolve) => setTimeout(resolve, 5));
      clock += 990; // ten in flight: about 9.9 s a wave
      return new Response("ok");
    }) as unknown as typeof fetch;
    try {
      await sweepMonitoring(e(), NOW, slow);
    } finally { spy.mockRestore(); }
    const c0 = await claim("al-t0");
    expect(c0!.delivered_at).toBe(NOW);
    // Its claim was taken at NOW + 70 s, never at NOW: every alert of the stage's waves was sent on its first attempt.
    const sentOnce = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE id LIKE 'al-t%' AND delivered_at IS NOT NULL AND delivery_attempts=1")
      .first<{ n: number }>();
    expect(sentOnce!.n).toBe(25);
  });
  it("a send whose claim no longer covers the POST is skipped, and retried by a later sweep", async () => {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('al-x','h-x','home.disk_high','medium','d',?)")
      .bind(NOW).run();
    const { sent, fetcher } = hook();
    // The clock jumps 55 s between the claim being written and the POST: 55 + ALERT_POST_TIMEOUT_MS is past the 60 s claim.
    const times = [NOW, NOW + 55_000];
    const spy = vi.spyOn(Date, "now").mockImplementation(() => times.shift() ?? NOW + 55_000);
    try {
      expect(await deliver(e(), "al-x", "d", { kind: "home.disk_high", text: "x" }, NOW, fetcher)).toBe(false);
    } finally { spy.mockRestore(); }
    expect(sent).toHaveLength(0);
    expect(await claim("al-x")).toMatchObject({ delivered_at: null, delivery_attempts: 1, delivery_claim_until: NOW + 60_000 });
    await sweepMonitoring(e(), NOW + 60_000, fetcher);
    expect(sent.filter((m) => m.homeId === "h-x")).toHaveLength(1);
    expect(await claim("al-x")).toMatchObject({ delivered_at: NOW + 60_000, delivery_attempts: 2 });
  });
  it("fifty alerts ahead of every resolution: resolutions go first each sweep, each kind within its own per-run limit", async () => {
    for (let i = 0; i < 50; i++) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.disk_high','medium','d',?)")
        .bind(`al-b${i}`, `h-b${i}`, NOW - 100_000 + i).run();
    }
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,delivered_at,resolved_at,resolve_notice_due)
        VALUES (?,?,'home.backup_stale','medium','d',?,?,?,1)`).bind(`al-r${i}`, `h-r${i}`, NOW - 200_000, NOW - 200_000, NOW - 50_000 + i).run();
    }
    // Every send succeeds after 9.9 virtual seconds.
    let clock = NOW;
    const order: string[] = [];
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const slow = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.kind === "daily.summary") return new Response("ok");
      order.push(body.kind);
      await new Promise((resolve) => setTimeout(resolve, 5));
      clock += 990;
      return new Response("ok");
    }) as unknown as typeof fetch;
    try {
      await sweepMonitoring(e(), NOW, slow);
    } finally { spy.mockRestore(); }
    const resolutions = order.filter((k) => k === "home.backup_stale.resolved").length;
    const alerts = order.filter((k) => k === "home.disk_high").length;
    expect(resolutions).toBeGreaterThan(0);
    expect(resolutions).toBeLessThanOrEqual(RESOLUTION_SEND_LIMIT);
    expect(alerts).toBeLessThanOrEqual(ALERT_SEND_LIMIT);
    expect(order[0]).toBe("home.backup_stale.resolved"); // resolutions first
    // The next sweep sends the remaining resolutions before any further alert.
    const owed = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE id LIKE 'al-r%' AND resolve_notice_due=1").first<{ n: number }>();
    expect(owed!.n).toBe(25 - resolutions);
    order.length = 0;
    clock = NOW + 3_600_000;
    const spy2 = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      await sweepMonitoring(e(), NOW + 3_600_000, slow);
    } finally { spy2.mockRestore(); }
    expect(order.filter((k) => k === "home.backup_stale.resolved")).toHaveLength(25 - resolutions);
    expect(order[0]).toBe("home.backup_stale.resolved");
  });
});

describe("Astra AUTOCANARY-9 P2: delivery reads its own clock; urgent alerts first, a backlog is itself an alert", () => {
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
  it("a render failure behind 400 older alerts goes out on the first sweep; the backlog raises alerts.backlog, resolved once the queue fits", async () => {
    for (let i = 0; i < 400; i++) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.disk_high','medium','d',?)")
        .bind(`al-o${i}`, `h-o${i}`, NOW - 1_000_000 + i).run();
    }
    await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('al-render','h-c','home.ui_render_missing','high','r',?),
      ('al-high','h-h','power.unconfirmed','high','p',?)`).bind(NOW - 1_000, NOW - 2_000).run();
    const { sent, fetcher } = hook();
    await sweepMonitoring(e(), NOW, fetcher);
    const kinds = sent.map((m) => m.kind).filter((k) => k !== "daily.summary");
    expect(kinds[0]).toBe(ALERT_BACKLOG_ALERT); // the backlog alert itself goes first (Astra AUTOCANARY-10 P2)
    expect(kinds[1]).toBe("home.ui_render_missing");
    expect(kinds.indexOf("power.unconfirmed")).toBeLessThan(kinds.indexOf("home.disk_high"));
    expect(kinds).toHaveLength(ALERT_SEND_LIMIT);
    expect(ALERT_SEND_LIMIT).toBe(60);
    const backlog = () => env.DB.prepare("SELECT resolved_at FROM cloud_alerts WHERE home_id='ops' AND kind=?").bind(ALERT_BACKLOG_ALERT).first<{ resolved_at: number | null }>();
    expect(await backlog()).toEqual({ resolved_at: null });
    // The queue drains; once it fits one sweep the backlog alert is resolved.
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=? WHERE id LIKE 'al-o%'").bind(NOW).run();
    await sweepMonitoring(e(), NOW + 300_000, fetcher);
    expect((await backlog())!.resolved_at).toBe(NOW + 300_000);
  });
});

describe("Astra AUTOCANARY-10 P2: urgent alerts never starve the oldest, nor alerts.backlog", () => {
  it("ASTRA-AUTOCANARY-10 P2 #2 replay: 100 urgent alerts and 30 older ordinary ones: the backlog alert goes first and the 20 oldest ordinary alerts are in the run", async () => {
    for (let i = 0; i < 100; i++) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.ui_render_missing','high','r',?)")
        .bind(`al-u${i}`, `h-u${i}`, NOW - 1_000 + i).run();
    }
    for (let i = 0; i < 30; i++) {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.disk_high','medium','d',?)")
        .bind(`al-o${String(i).padStart(2, "0")}`, `h-o${i}`, NOW - 10_000_000 + i).run();
    }
    const { sent, fetcher } = hook();
    await sweepMonitoring(e(), NOW, fetcher);
    const alerts = sent.filter((m) => m.kind !== "daily.summary");
    expect(alerts).toHaveLength(ALERT_SEND_LIMIT);
    expect(alerts[0].kind).toBe(ALERT_BACKLOG_ALERT);
    const old = alerts.filter((m) => m.kind === "home.disk_high").map((m) => m.homeId);
    expect(ALERT_OLDEST_SHARE).toBe(20);
    expect(old).toEqual(Array.from({ length: ALERT_OLDEST_SHARE }, (_, i) => `h-o${i}`)); // the oldest first, by age alone
    expect(alerts.filter((m) => m.kind === "home.ui_render_missing")).toHaveLength(ALERT_SEND_LIMIT - 1 - ALERT_OLDEST_SHARE);
    // The next sweep reaches the rest of the oldest; the backlog alert, already delivered, is not sent again.
    const { sent: next, fetcher: f2 } = hook();
    await sweepMonitoring(e(), NOW + 300_000, f2);
    const again = next.filter((m) => m.kind !== "daily.summary");
    expect(again.some((m) => m.kind === ALERT_BACKLOG_ALERT)).toBe(false);
    expect(again.filter((m) => m.kind === "home.disk_high").map((m) => m.homeId)).toEqual(Array.from({ length: 10 }, (_, i) => `h-o${20 + i}`));
  });
});
