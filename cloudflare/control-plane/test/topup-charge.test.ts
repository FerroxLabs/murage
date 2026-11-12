// SPDX-License-Identifier: AGPL-3.0-or-later
// Auto top-up charging: the claim, the monthly cap reservation, the charge, the grant and the sweep. Stripe and Flux are fixtures; no network.
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { releaseItem9HoldForTests } from "../src/held-until-item9-highs";
// ITEM 9: this suite exercises charging switched on; the launch guard (held-until-item9-highs.ts) is released here only.
beforeAll(() => releaseItem9HoldForTests(true));
afterAll(() => releaseItem9HoldForTests(false));
import { claimTopupAttempt, closeTopupAttempt, runTopupAttempt, sweepAutoTopup, topupChargingEnabled, topupPrecheck, topupMonthKey, type TopupAttempt, type TopupDeps, type TopupNotice, type TopupSettings, type TopupSweepCtx, type CapRaiseResult } from "../src/topup-charge";
import { StripeError, type StripeClient } from "../src/b5-stripe";
import { orderWords } from "../src/checkout-moments";

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const HOME = "home-topup-1";
const e = () => env as Env;

async function seedSettings(over: Partial<TopupSettings & { applied: number | null }> = {}): Promise<TopupSettings> {
  const row = { home_id: HOME, enabled: 1, amount_cents: 2000, threshold_cents: 500, cap_cents: 5000, revision: 3, applied_revision: 3 as number | null, consent_id: "c1", ...over };
  await e().DB.prepare(`INSERT OR REPLACE INTO topup_settings (home_id,user_id,enabled,amount_cents,threshold_cents,cap_cents,cap_period,cap_resets,consent_id,updated_at,revision,applied_revision)
    VALUES (?,?,?,?,?,?, 'month','00:00 UTC on the 1st',?,?,?,?)`).bind(row.home_id, "u1", row.enabled, row.amount_cents, row.threshold_cents, row.cap_cents, row.consent_id, NOW, row.revision, row.applied_revision).run();
  return row;
}
beforeEach(async () => {
  for (const t of ["topup_attempts", "topup_month", "topup_state", "topup_settings", "flux_home_keys"]) await e().DB.prepare(`DELETE FROM ${t}`).run();
});

describe("auto top-up claim", () => {
  it("the switch is off unless exactly 1", () => {
    expect(topupChargingEnabled({})).toBe(false);
    expect(topupChargingEnabled({ CLOUD_AUTOTOPUP_ENABLED: "0" })).toBe(false);
    expect(topupChargingEnabled({ CLOUD_AUTOTOPUP_ENABLED: "1" })).toBe(true);
  });

  it("ITEM 9 guard (GrokBuild Low): claimTopupAttempt itself refuses while the hold is in force, whatever its caller checked: no attempt row, no reservation", async () => {
    const s = await seedSettings();
    releaseItem9HoldForTests(false);
    try {
      expect(await claimTopupAttempt(e(), s, NOW)).toEqual({ claimed: false, reason: "held" });
    } finally { releaseItem9HoldForTests(true); }
    expect((await e().DB.prepare("SELECT COUNT(*) AS n FROM topup_attempts").first<{ n: number }>())?.n).toBe(0);
    expect((await e().DB.prepare("SELECT COUNT(*) AS n FROM topup_month").first<{ n: number }>())?.n).toBe(0);
  });

  it("concurrent claims make exactly one attempt and one reservation", async () => {
    const s = await seedSettings();
    const results = await Promise.all([1, 2, 3, 4].map(() => claimTopupAttempt(e(), s, NOW)));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect((await e().DB.prepare("SELECT COUNT(*) AS n FROM topup_attempts").first<{ n: number }>())?.n).toBe(1);
    expect(await e().DB.prepare("SELECT reserved_cents AS r FROM topup_month").first()).toEqual({ r: 2000 });
  });

  it("the monthly cap stops the claim and the next UTC month starts clean", async () => {
    const s = await seedSettings({ amount_cents: 2000, cap_cents: 5000 });
    for (let i = 0; i < 2; i++) {
      const r = await claimTopupAttempt(e(), s, NOW);
      expect(r.claimed).toBe(true);
      if (r.claimed) await e().DB.prepare("UPDATE topup_attempts SET state='done' WHERE attempt_id=?").bind(r.attempt.attempt_id).run();
    }
    expect(await claimTopupAttempt(e(), s, NOW)).toEqual({ claimed: false, reason: "cap" }); // 4000 reserved, 2000 more would pass 5000
    expect((await e().DB.prepare("SELECT reserved_cents AS r FROM topup_month").first<{ r: number }>())?.r).toBe(4000);
    const nextMonth = Date.UTC(2026, 11, 1, 0, 0, 0);
    expect(topupMonthKey(nextMonth)).toBe("2026-12");
    expect((await claimTopupAttempt(e(), s, nextMonth)).claimed).toBe(true);
  });

  it("an amount above the whole cap never claims on a fresh month", async () => {
    const s = await seedSettings({ amount_cents: 6000, cap_cents: 5000 });
    expect(await claimTopupAttempt(e(), s, NOW)).toEqual({ claimed: false, reason: "cap" });
  });

  it("a revision change or the switch off after the read claims nothing", async () => {
    const s = await seedSettings();
    await seedSettings({ revision: 4, applied_revision: 4 });
    expect(await claimTopupAttempt(e(), s, NOW)).toEqual({ claimed: false, reason: "revision" });
    const off = await seedSettings({ enabled: 0 });
    expect(await claimTopupAttempt(e(), off, NOW)).toMatchObject({ claimed: false });
    expect((await e().DB.prepare("SELECT COUNT(*) AS n FROM topup_attempts").first<{ n: number }>())?.n).toBe(0);
    expect((await e().DB.prepare("SELECT COUNT(*) AS n FROM topup_month").first<{ n: number }>())?.n).toBe(0);
  });

  it("closing an attempt returns its reservation once", async () => {
    const s = await seedSettings();
    const r = await claimTopupAttempt(e(), s, NOW);
    if (!r.claimed) throw new Error("claim");
    expect(await closeTopupAttempt(e(), r.attempt, "abandoned", "revision_changed", NOW)).toBe(true);
    expect(await closeTopupAttempt(e(), r.attempt, "abandoned", "revision_changed", NOW)).toBe(false);
    expect((await e().DB.prepare("SELECT reserved_cents AS r FROM topup_month").first<{ r: number }>())?.r).toBe(0);
    expect((await claimTopupAttempt(e(), s, NOW)).claimed).toBe(true);
  });

  it("a paused home and a fresh paid cooldown claim nothing", async () => {
    const s = await seedSettings();
    await e().DB.prepare("INSERT INTO topup_state (home_id, paused_at, pause_reason) VALUES (?,?,?)").bind(HOME, NOW, "declined").run();
    expect(await claimTopupAttempt(e(), s, NOW)).toEqual({ claimed: false, reason: "paused" });
    await e().DB.prepare("UPDATE topup_state SET paused_at=NULL, last_paid_at=?").bind(NOW - 60_000).run();
    expect(await claimTopupAttempt(e(), s, NOW)).toEqual({ claimed: false, reason: "cooldown" });
    expect((await claimTopupAttempt(e(), s, NOW + 11 * 60_000)).claimed).toBe(true);
  });
});

// ---- the charge, with a Stripe fixture that honours idempotency keys the way Stripe does -----------------------------------------------------
interface Fake { calls: string[]; charges: number; client: StripeClient; deps: TopupDeps; notices: TopupNotice[]; voided: string[]; onFinalize?: () => Promise<void>;
  methods: string[]; cfg: { country: string | null; subPm: string | null; pm: string | null; tax: string; payFail: "none" | "decline" | "sca" | "lost_once"; link: boolean; subStatus: string; voidFail: boolean } }
function fake(): Fake {
  const seen = new Map<string, unknown>();
  const f: Fake = { calls: [], charges: 0, notices: [], voided: [], methods: [], cfg: { country: "US", subPm: null, pm: "pm_1", tax: "complete", payFail: "none", link: false, subStatus: "active", voidFail: false }, client: undefined as never, deps: undefined as never };
  const once = async <T,>(k: string, make: () => T): Promise<T> => { if (!seen.has(k)) seen.set(k, make()); return seen.get(k) as T; };
  f.client = {
    customerTaxState: async () => ({ country: f.cfg.country, postalCode: "94105", liveSubscription: true, balance: 0, defaultPaymentMethod: f.cfg.pm, defaultSource: null, deleted: false, email: null, name: null }),
    getSubscription: async () => ({ id: "sub_t1", status: f.cfg.subStatus, default_payment_method: f.cfg.subPm }),
    getInvoice: async (id: string) => ({ id, status: f.voided.includes(id) ? "void" : f.charges > 0 ? "paid" : "open", tax: 160 }),
    createInvoice: async (_i: unknown, k: string) => { f.calls.push("create"); return once(k, () => ({ id: "in_topup_1", status: "draft" })); },
    addInvoiceItem: async (_i: unknown, k: string) => { f.calls.push("item"); return once(k, () => ({ id: "ii_1" })); },
    finalizeInvoice: async (_id: string, k: string) => { f.calls.push("finalize"); await f.onFinalize?.(); return once(k, () => ({ id: "in_topup_1", status: "open", total: 2160, tax: 160, automatic_tax: { status: f.cfg.tax } })); },
    voidInvoice: async (id: string) => { if (f.cfg.voidFail) throw new Error("network: void failed"); f.voided.push(id); return { id, status: "void" }; },
    payInvoice: async (_id: string, k: string, authorized: { paymentMethod: string }) => {
      f.calls.push("pay"); f.methods.push(authorized.paymentMethod);
      if (seen.has(k)) return seen.get(k) as { id: string; status: string }; // Stripe answers a repeated key from its cache: no second charge
      if (f.cfg.payFail === "decline") throw new StripeError(402, "stripe_card_declined");
      if (f.cfg.payFail === "sca") throw new StripeError(402, "stripe_authentication_required");
      f.charges++;
      const res = { id: "in_topup_1", status: "paid" };
      seen.set(k, res);
      if (f.cfg.payFail === "lost_once") { f.cfg.payFail = "none"; throw new Error("network: response lost"); } // charged, answer never arrived
      return res;
    },
  } as unknown as StripeClient;
  // The pay-time clock reads the fixture's NOW unless a test moves it (the real default is Date.now).
  f.deps = { stripe: f.client, isLink: async () => f.cfg.link, notify: async (k) => { f.notices.push(k); }, taxCode: null, clock: () => NOW, precheck: async () => ({ allow: true }) };
  return f;
}
async function claimed(s: TopupSettings, now = NOW): Promise<TopupAttempt> {
  const r = await claimTopupAttempt(e(), s, now);
  if (!r.claimed) throw new Error(`claim refused: ${r.reason}`);
  return r.attempt;
}
const stateOf = async (id: string) => (await e().DB.prepare("SELECT state, error, invoice_id, tax_cents FROM topup_attempts WHERE attempt_id=?").bind(id).first<{ state: string; error: string | null; invoice_id: string | null; tax_cents: number | null }>())!;
async function seedSub(): Promise<void> {
  await e().DB.prepare("DELETE FROM billing_subscriptions WHERE home_id=?").bind(HOME).run();
  await e().DB.prepare(`INSERT INTO billing_subscriptions (home_id, customer_id, subscription_id, plan, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(HOME, "cus_t1", "sub_t1", "pro", "active", NOW, NOW).run();
}

describe("auto top-up charge", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });

  it("a paid attempt records the tax and starts the cooldown", async () => {
    const s = await seedSettings(); const f = fake(); const a = await claimed(s);
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("paid");
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "paid", invoice_id: "in_topup_1", tax_cents: 160 });
    expect(f.charges).toBe(1);
    expect((await e().DB.prepare("SELECT last_paid_at AS t FROM topup_state WHERE home_id=?").bind(HOME).first<{ t: number }>())?.t).toBe(NOW);
  });

  it("a lost response charges once: the resume replays the same keys", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.payFail = "lost_once"; const a = await claimed(s);
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("retry");
    expect((await stateOf(a.attempt_id)).state).toBe("invoiced");
    expect(await runTopupAttempt(e(), f.deps, (await e().DB.prepare("SELECT * FROM topup_attempts WHERE attempt_id=?").bind(a.attempt_id).first<TopupAttempt>())!, NOW + 130_000)).toBe("paid");
    expect(f.charges).toBe(1);
  });

  it("a decline voids the invoice, gives the reservation back, counts and pauses after three", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.payFail = "decline";
    for (let i = 1; i <= 3; i++) {
      const a = await claimed(s, NOW + i * 3_600_000);
      expect(await runTopupAttempt(e(), f.deps, a, NOW + i * 3_600_000)).toBe("declined");
      expect(await stateOf(a.attempt_id)).toMatchObject({ state: "declined", error: "stripe_card_declined" });
    }
    expect(f.charges).toBe(0);
    expect(f.notices).toEqual(["topup_declined", "topup_declined", "topup_declined"]);
    expect((await e().DB.prepare("SELECT reserved_cents AS r FROM topup_month").first<{ r: number }>())?.r).toBe(0);
    expect(await e().DB.prepare("SELECT declines, pause_reason FROM topup_state").first()).toEqual({ declines: 3, pause_reason: "declined" });
    expect(await claimTopupAttempt(e(), s, NOW + 9 * 3_600_000)).toEqual({ claimed: false, reason: "paused" });
  });

  it("authentication required pauses at once and tells the owner to act", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.payFail = "sca"; const a = await claimed(s);
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("action_required");
    expect(f.notices).toEqual(["topup_action_needed"]);
    expect(f.voided).toEqual(["in_topup_1"]);
    expect((await e().DB.prepare("SELECT pause_reason AS r FROM topup_state").first<{ r: string }>())?.r).toBe("authentication_required");
  });

  it("a revision change after the claim stops the attempt before any invoice", async () => {
    const s = await seedSettings(); const f = fake(); const a = await claimed(s);
    await seedSettings({ revision: 4, applied_revision: 4 });
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("abandoned");
    expect(f.calls).toEqual([]);
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "abandoned", error: "revision_changed" });
  });

  it("a precheck that is not an allow stops the attempt with no invoice and the reservation returned", async () => {
    const s = await seedSettings(); const f = fake();
    const a = await claimed(s);
    f.deps.precheck = async () => ({ allow: false, kind: "transient", reason: "http_503" });
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("abandoned");
    expect(f.calls).toEqual([]); expect(f.charges).toBe(0);
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "abandoned", error: "precheck_http_503", invoice_id: null });
    expect((await e().DB.prepare("SELECT reserved_cents AS r FROM topup_month").first<{ r: number }>())?.r).toBe(0);
    f.deps.precheck = async () => ({ allow: true });
    expect(await runTopupAttempt(e(), f.deps, await claimed(s, NOW + 3_600_000), NOW + 3_600_000)).toBe("paid");
  });

  it("a Link buyer is never charged", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.link = true; const a = await claimed(s);
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("abandoned");
    expect(f.charges).toBe(0); expect(f.calls).toEqual([]);
  });

  it("tax not complete or no address voids and charges nothing", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.tax = "requires_location_inputs"; const a = await claimed(s);
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("abandoned");
    expect(f.charges).toBe(0); expect(f.voided).toEqual(["in_topup_1"]);
    expect((await stateOf(a.attempt_id)).error).toBe("tax_not_complete");
    const f2 = fake(); f2.cfg.country = null; const b = await claimed(s, NOW + 3_600_000);
    expect(await runTopupAttempt(e(), f2.deps, b, NOW + 3_600_000)).toBe("abandoned");
    expect(f2.calls).toEqual([]);
  });
});

describe("auto top-up charges the method consented to at checkout", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("the subscription's own payment method is charged, not the customer default", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.subPm = "pm_checkout"; f.cfg.pm = "pm_other_default";
    expect(await runTopupAttempt(e(), f.deps, await claimed(s), NOW)).toBe("paid");
    expect(f.methods).toEqual(["pm_checkout"]);
  });
  it("the customer default is used only when the subscription names none, and none at all needs the owner", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.subPm = null; f.cfg.pm = "pm_default";
    expect(await runTopupAttempt(e(), f.deps, await claimed(s), NOW)).toBe("paid");
    expect(f.methods).toEqual(["pm_default"]);
    for (const t of ["topup_attempts", "topup_month", "topup_state"]) await e().DB.prepare(`DELETE FROM ${t}`).run();
    const g = fake(); g.cfg.pm = null; const b = await claimed(s, NOW + 3_600_000);
    expect(await runTopupAttempt(e(), g.deps, b, NOW + 3_600_000)).toBe("action_required");
    expect(g.calls).toEqual([]);
  });
});

// ---- the sweep --------------------------------------------------------------------------------------------------------------------------
interface Sweep { log: string[]; spendable: number | null; granted: boolean; raise: CapRaiseResult; ctx: (now?: number) => TopupSweepCtx<object>; f: Fake }
function sweepFixture(): Sweep {
  const f = fake();
  const x: Sweep = { log: [], spendable: 0, granted: true, raise: "raised", f, ctx: undefined as never };
  x.ctx = (now = NOW) => ({
    now, deps: f.deps, onHome: async (_h, work) => { await work({}); },
    spendable: async () => { x.log.push("status"); return x.spendable; },
    grant: async () => { x.log.push("grant"); return x.granted; },
    raiseCap: async () => { x.log.push("raise"); return x.raise; },
  });
  return x;
}
async function seedKey(over: { state?: string; off?: number; hold?: number } = {}): Promise<void> {
  await e().DB.prepare(`INSERT OR REPLACE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,spending_off,billing_hold,updated_at) VALUES (?,?,?,?,?,0,?,?,?)`)
    .bind(HOME, "pro", 1, over.state ?? "active", 30_000_000, over.off ?? 0, over.hold ?? 0, NOW).run();
}
const attempts = async () => (await e().DB.prepare("SELECT state FROM topup_attempts ORDER BY claimed_at").all<{ state: string }>()).results.map((r) => r.state);

describe("auto top-up sweep", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });

  it("concurrent sweeps charge once and the attempt ends done", async () => {
    await seedSettings(); const x = sweepFixture();
    await Promise.all([sweepAutoTopup(e(), x.ctx()), sweepAutoTopup(e(), x.ctx()), sweepAutoTopup(e(), x.ctx())]);
    expect(x.f.charges).toBe(1);
    expect(x.log.filter((l) => l === "grant")).toHaveLength(1);
    expect(await attempts()).toEqual(["done"]);
  });

  it("a balance at or above the threshold is left alone, and an unknown balance too", async () => {
    await seedSettings(); const x = sweepFixture();
    x.spendable = 500 * 10_000; await sweepAutoTopup(e(), x.ctx());
    x.spendable = null; await sweepAutoTopup(e(), x.ctx());
    expect(x.f.charges).toBe(0); expect(await attempts()).toEqual([]);
  });

  it("switching off, spending off, a stop and a billing hold charge nothing and read no balance", async () => {
    const x = sweepFixture();
    await seedSettings({ enabled: 0 }); await sweepAutoTopup(e(), x.ctx());
    await seedSettings();
    for (const k of [{ off: 1 }, { state: "stopped" }, { state: "stopping" }, { hold: 1 }]) { await seedKey(k); await sweepAutoTopup(e(), x.ctx()); }
    await seedKey(); await seedSettings({ applied_revision: null });
    await sweepAutoTopup(e(), x.ctx());
    expect(x.log).toEqual([]); expect(x.f.charges).toBe(0); expect(await attempts()).toEqual([]);
  });

  it("a switch off after an attempt was claimed charges nothing at the resume", async () => {
    const s = await seedSettings(); const x = sweepFixture();
    await claimed(s);
    await seedSettings({ enabled: 0 });
    await sweepAutoTopup(e(), x.ctx(NOW + 3 * 60_000));
    expect(x.f.charges).toBe(0); expect(await attempts()).toEqual(["abandoned"]);
  });

  it("the cap is raised only after the grant lands, and the attempt stays open until then", async () => {
    await seedSettings(); const x = sweepFixture(); x.granted = false;
    await sweepAutoTopup(e(), x.ctx());
    expect(x.log).toEqual(["status", "grant"]); expect(await attempts()).toEqual(["paid"]);
    x.spendable = 0; x.log.length = 0;
    await sweepAutoTopup(e(), x.ctx(NOW + 60_000)); // still open: no second charge, no balance read
    expect(x.f.charges).toBe(1); expect(x.log).toEqual(["grant"]);
    x.granted = true; x.log.length = 0;
    await sweepAutoTopup(e(), x.ctx(NOW + 120_000));
    expect(x.log).toEqual(["grant", "raise"]); expect(await attempts()).toEqual(["done"]);
    expect(x.f.charges).toBe(1);
  });

  it("a paid attempt not granted after a day raises one alert and keeps the money", async () => {
    await seedSettings(); const x = sweepFixture(); x.granted = false;
    await sweepAutoTopup(e(), x.ctx());
    await sweepAutoTopup(e(), x.ctx(NOW + 25 * 3_600_000)); await sweepAutoTopup(e(), x.ctx(NOW + 26 * 3_600_000));
    const alerts = await e().DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id=? AND kind='topup.paid_not_granted' AND resolved_at IS NULL").bind(HOME).all();
    expect(alerts.results).toHaveLength(1); expect(x.f.charges).toBe(1); expect(x.f.voided).toEqual([]);
    await e().DB.prepare("DELETE FROM cloud_alerts WHERE home_id=?").bind(HOME).run();
  });

  it("a lost response is resumed by the next sweep under the same keys: one charge", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.payFail = "lost_once";
    await sweepAutoTopup(e(), x.ctx());
    expect(await attempts()).toEqual(["invoiced"]);
    await sweepAutoTopup(e(), x.ctx(NOW + 130_000));
    expect(x.f.charges).toBe(1); expect(await attempts()).toEqual(["done"]);
  });

  it("an attempt older than the key lifetime is read back from Stripe, and a paid one is granted", async () => {
    const s = await seedSettings(); const x = sweepFixture(); const a = await claimed(s);
    await e().DB.prepare("UPDATE topup_attempts SET state='invoiced', invoice_id='in_old' WHERE attempt_id=?").bind(a.attempt_id).run();
    (x.f.client as unknown as { getInvoice: (id: string) => Promise<unknown> }).getInvoice = async () => ({ status: "paid", tax: 160 });
    await sweepAutoTopup(e(), x.ctx(NOW + 21 * 3_600_000));
    expect(x.log).toEqual(["grant", "raise"]); expect(await attempts()).toEqual(["done"]);
    expect(x.f.charges).toBe(0);
  });

  it("the monthly limit tells the owner once a month and charges nothing", async () => {
    await seedSettings({ amount_cents: 6000, cap_cents: 5000 }); const x = sweepFixture();
    await sweepAutoTopup(e(), x.ctx()); await sweepAutoTopup(e(), x.ctx(NOW + 60_000));
    expect(x.f.notices).toEqual(["topup_cap_reached"]); expect(x.f.charges).toBe(0);
    await sweepAutoTopup(e(), x.ctx(Date.UTC(2026, 11, 2)));
    expect(x.f.notices).toEqual(["topup_cap_reached", "topup_cap_reached"]);
  });

  it("a declined home is paused and the next sweeps do not read its balance", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.payFail = "sca";
    await sweepAutoTopup(e(), x.ctx());
    x.log.length = 0;
    await sweepAutoTopup(e(), x.ctx(NOW + 3_600_000));
    expect(x.log).toEqual([]); expect(x.f.notices).toEqual(["topup_action_needed"]);
  });
});

// ---- review findings 1 to 9 ---------------------------------------------------------------------------------------------------------------
const rowOf = async (id: string) => (await e().DB.prepare("SELECT * FROM topup_attempts WHERE attempt_id=?").bind(id).first<TopupAttempt>())!;
const reserved = async (month: string) => (await e().DB.prepare("SELECT reserved_cents AS r FROM topup_month WHERE month_key=?").bind(month).first<{ r: number }>())?.r ?? 0;

describe("review 1: a paid invoice is never abandoned", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("charged, response lost, settings changed before the resume: the attempt goes on to its grant", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.payFail = "lost_once"; f.cfg.voidFail = true; const a = await claimed(s);
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("retry");
    await seedSettings({ enabled: 0, revision: 4, applied_revision: 4 });
    expect(await runTopupAttempt(e(), f.deps, await rowOf(a.attempt_id), NOW + 130_000)).toBe("paid");
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "paid" });
    expect(await reserved("2026-11")).toBe(2000); // the money is spent: the reservation stays
    expect(f.charges).toBe(1);
  });
  it("an open invoice that cannot be voided keeps the attempt open instead of closing it", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.voidFail = true; const a = await claimed(s);
    f.onFinalize = async () => { await seedSettings({ revision: 4, applied_revision: 4 }); };
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("retry");
    expect((await stateOf(a.attempt_id)).state).toBe("invoiced");
    expect(await reserved("2026-11")).toBe(2000);
    f.cfg.voidFail = false;
    expect(await runTopupAttempt(e(), f.deps, await rowOf(a.attempt_id), NOW + 130_000)).toBe("abandoned");
    expect(await reserved("2026-11")).toBe(0);
  });
});

describe("review 2: the home's state is checked right before payment on every path", () => {
  beforeEach(async () => { await seedSub(); });
  it.each([{ off: 1 }, { state: "stopped" }, { hold: 1 }])("%j after the claim: nothing is charged", async (k) => {
    const s = await seedSettings(); const f = fake(); const a = await claimed(s); await seedKey(k);
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("abandoned");
    expect(f.charges).toBe(0); expect(f.calls).toEqual([]);
    expect((await stateOf(a.attempt_id)).error).toBe("home_state");
  });
  it("a stop that lands between the invoice and the payment still stops the charge", async () => {
    const s = await seedSettings(); const f = fake(); await seedKey(); const a = await claimed(s);
    f.onFinalize = async () => { await seedKey({ off: 1 }); };
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("abandoned");
    expect(f.charges).toBe(0); expect(f.voided).toEqual(["in_topup_1"]);
  });
  it("an interrupted attempt resumed by the sweep after the owner stopped the home charges nothing", async () => {
    await seedKey(); const s = await seedSettings(); const x = sweepFixture(); await claimed(s); await seedKey({ state: "stopped" });
    await sweepAutoTopup(e(), x.ctx(NOW + 3 * 60_000));
    expect(x.f.charges).toBe(0); expect(await attempts()).toEqual(["abandoned"]);
  });
});

describe("review 3: the live subscription must allow the charge", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it.each(["canceled", "past_due", "unpaid", "incomplete_expired"])("a subscription Stripe reports as %s is never charged", async (st) => {
    const s = await seedSettings(); const f = fake(); f.cfg.subStatus = st; const a = await claimed(s);
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("abandoned");
    expect(f.charges).toBe(0); expect(f.calls).toEqual([]);
    expect((await stateOf(a.attempt_id)).error).toBe(`subscription_${st}`);
  });
  it("trialing is allowed", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.subStatus = "trialing";
    expect(await runTopupAttempt(e(), f.deps, await claimed(s), NOW)).toBe("paid");
  });
});

describe("review 4: the monthly limit holds for the month the charge lands in", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  const LATE_NOV = Date.UTC(2026, 10, 30, 23, 59, 50), EARLY_DEC = Date.UTC(2026, 11, 1, 0, 1, 0);
  it("claimed just before midnight and paid after it: the reservation moves, so the new month cannot take a second charge", async () => {
    const s = await seedSettings({ amount_cents: 2000, cap_cents: 2000 }); const f = fake(); const a = await claimed(s, LATE_NOV);
    f.deps = { ...f.deps, clock: () => EARLY_DEC };
    expect(await runTopupAttempt(e(), f.deps, a, EARLY_DEC)).toBe("paid");
    expect(await reserved("2026-11")).toBe(0); expect(await reserved("2026-12")).toBe(2000);
    expect(await claimTopupAttempt(e(), s, EARLY_DEC + 11 * 60_000)).toMatchObject({ claimed: false });
    await e().DB.prepare("UPDATE topup_attempts SET state='done'").run();
    expect(await claimTopupAttempt(e(), s, EARLY_DEC + 11 * 60_000)).toEqual({ claimed: false, reason: "cap" }); // a $20 month holds one $20 charge
    expect(f.charges).toBe(1);
  });
  it("when the new month is already full the attempt is abandoned and nothing is charged", async () => {
    const s = await seedSettings({ amount_cents: 2000, cap_cents: 5000 }); const f = fake(); const a = await claimed(s, LATE_NOV);
    await e().DB.prepare("INSERT INTO topup_month (home_id, month_key, reserved_cents) VALUES (?,?,?)").bind(HOME, "2026-12", 4000).run();
    f.deps = { ...f.deps, clock: () => EARLY_DEC };
    expect(await runTopupAttempt(e(), f.deps, a, EARLY_DEC)).toBe("abandoned");
    expect(f.charges).toBe(0); expect((await stateOf(a.attempt_id)).error).toBe("month_cap");
    expect(await reserved("2026-11")).toBe(0); expect(await reserved("2026-12")).toBe(4000);
  });
  it("a response lost before midnight and resumed after it stays in the month the pay call was made", async () => {
    const s = await seedSettings({ amount_cents: 2000, cap_cents: 5000 }); const f = fake(); f.cfg.payFail = "lost_once"; const a = await claimed(s, LATE_NOV);
    f.deps = { ...f.deps, clock: () => LATE_NOV };
    expect(await runTopupAttempt(e(), f.deps, a, LATE_NOV)).toBe("retry");
    f.deps = { ...f.deps, clock: () => EARLY_DEC };
    expect(await runTopupAttempt(e(), f.deps, await rowOf(a.attempt_id), EARLY_DEC)).toBe("paid");
    expect(await reserved("2026-11")).toBe(2000); expect(await reserved("2026-12")).toBe(0);
    expect(f.charges).toBe(1);
  });
});

describe("review 5: the charge follows the saved payment method the mandate names", () => {
  it("the mandate text authorizes the customer's payment method, not one named card", async () => {
    const { WORDING } = await import("../src/legal-flows");
    expect(WORDING.topupCharge).toContain("to charge my payment method");
    expect(WORDING.topupCharge).not.toMatch(/card ending|this card|the card I/i);
  });
});

describe("review 6: every open attempt gets its turn", () => {
  it("fifty old paid attempts waiting for a grant do not starve a newer lost-response attempt", async () => {
    const x = sweepFixture(); x.granted = false;
    for (let i = 0; i < 50; i++) {
      await e().DB.prepare(`INSERT INTO topup_attempts (attempt_id, home_id, settings_revision, amount_cents, month_key, state, invoice_id, claimed_at, updated_at, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(`old-${i}`, `old-home-${i}`, 1, 2000, "2026-11", "paid", `in_old_${i}`, NOW - 3 * 86_400_000, NOW - 3 * 86_400_000, NOW - 3 * 86_400_000).run();
    }
    await seedSub(); await seedKey(); const s = await seedSettings(); const f = x.f; f.cfg.payFail = "lost_once"; const a = await claimed(s, NOW - 3_600_000);
    await e().DB.prepare("UPDATE topup_attempts SET updated_at=? WHERE attempt_id=?").bind(NOW - 600_000, a.attempt_id).run();
    await sweepAutoTopup(e(), x.ctx(NOW));
    await sweepAutoTopup(e(), x.ctx(NOW + 60_000));
    expect(f.calls).toContain("pay"); // the newer attempt was examined within two sweeps
    expect((await stateOf(a.attempt_id)).state).not.toBe("claimed");
    await e().DB.prepare("DELETE FROM cloud_alerts WHERE home_id LIKE 'old-home-%'").run();
  });
});

describe("review 7: tax trouble backs off and the owner is told once", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("a missing tax address makes no new attempt for an hour, then a longer wait, and one notice", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.country = null;
    await sweepAutoTopup(e(), x.ctx(NOW));
    for (const m of [5, 10, 30, 55]) await sweepAutoTopup(e(), x.ctx(NOW + m * 60_000));
    expect((await attempts()).length).toBe(1);
    expect(x.f.notices).toEqual(["topup_address_needed"]);
    await sweepAutoTopup(e(), x.ctx(NOW + 61 * 60_000)); // an hour later: tried again, 2 h wait now
    expect((await attempts()).length).toBe(2);
    await sweepAutoTopup(e(), x.ctx(NOW + 61 * 60_000 + 90 * 60_000));
    expect((await attempts()).length).toBe(2);
    expect(x.f.notices).toEqual(["topup_address_needed"]);
  });
  it("tax not complete: one invoice per backoff, not one per pass", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.tax = "requires_location_inputs";
    for (let m = 0; m < 60; m += 5) await sweepAutoTopup(e(), x.ctx(NOW + m * 60_000));
    expect(x.f.calls.filter((c) => c === "create")).toHaveLength(1);
    expect(x.f.notices).toEqual(["topup_address_needed"]);
    x.f.cfg.tax = "complete";
    await sweepAutoTopup(e(), x.ctx(NOW + 61 * 60_000));
    expect(x.f.charges).toBe(1);
    expect(await e().DB.prepare("SELECT retry_after, retry_fails, notified_reason FROM topup_state").first()).toEqual({ retry_after: null, retry_fails: 0, notified_reason: null });
  });
});

describe("review 8: a pause lifts on a real recovery", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("authentication required pauses; the same card stays paused; a new card starts it again", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.payFail = "sca"; x.f.cfg.pm = "pm_old";
    await sweepAutoTopup(e(), x.ctx(NOW));
    expect((await e().DB.prepare("SELECT paused_method AS m FROM topup_state").first<{ m: string }>())?.m).toBe("pm_old");
    x.f.cfg.payFail = "none";
    await sweepAutoTopup(e(), x.ctx(NOW + 20 * 60_000));
    expect(x.f.charges).toBe(0); expect((await e().DB.prepare("SELECT paused_at AS p FROM topup_state").first<{ p: number | null }>())?.p).not.toBeNull();
    x.f.cfg.pm = "pm_new";
    await sweepAutoTopup(e(), x.ctx(NOW + 40 * 60_000));
    expect(x.f.charges).toBe(1); expect(x.f.methods.at(-1)).toBe("pm_new");
    expect(await e().DB.prepare("SELECT paused_at, pause_reason FROM topup_state").first()).toEqual({ paused_at: null, pause_reason: null });
  });
  it("no card at all pauses, and adding one lifts it", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.pm = null;
    await sweepAutoTopup(e(), x.ctx(NOW));
    expect(x.f.notices).toEqual(["topup_action_needed"]);
    x.f.cfg.pm = "pm_added";
    await sweepAutoTopup(e(), x.ctx(NOW + 20 * 60_000));
    expect(x.f.charges).toBe(1);
  });
  it("switching top-up off lifts the pause, and so does switching it on after it was off; an edit while on does not", async () => {
    const { saveTopup } = await import("../src/legal-flows");
    const { acquireHomeLease } = await import("../src/billing-lease");
    const lease = (await acquireHomeLease(e(), HOME, "test-holder"))!;
    const save = (enabled: boolean, amountCents = 2000) => saveTopup(e(), lease, { homeId: HOME, userId: "u1", enabled, amountCents, thresholdCents: 500, capCents: 5000, consentId: null, source: "test", ip: null, userAgent: null }, NOW);
    const paused = async () => (await e().DB.prepare("SELECT paused_at AS p FROM topup_state WHERE home_id=?").bind(HOME).first<{ p: number | null }>())?.p ?? null;
    const pause = async () => { await e().DB.prepare("INSERT OR REPLACE INTO topup_state (home_id, paused_at, pause_reason, declines) VALUES (?,?,?,3)").bind(HOME, NOW, "declined").run(); };
    await seedSettings({ enabled: 1 }); await pause();
    await save(true, 3000); expect(await paused()).toBe(NOW); // an edit while on keeps the pause
    await save(false); expect(await paused()).toBeNull(); // switching off lifts it
    await pause(); await save(true); expect(await paused()).toBeNull(); // on again after off: it was lifted at the switch
    await pause(); await e().DB.prepare("UPDATE topup_settings SET enabled=0").run(); await save(true);
    expect(await paused()).toBeNull(); // paused while off, then switched on: lifted
  });
});

describe("review 9: no eligible home waits forever behind the first hundred", () => {
  it("homes past the first page are examined by the next sweep", async () => {
    const seen = new Set<string>(); const x = sweepFixture();
    for (let i = 0; i < 105; i++) {
      const h = `h-${String(i).padStart(3, "0")}`;
      await e().DB.prepare(`INSERT INTO topup_settings (home_id,user_id,enabled,amount_cents,threshold_cents,cap_cents,cap_period,cap_resets,consent_id,updated_at,revision,applied_revision) VALUES (?,?,1,2000,500,5000,'month','00:00 UTC on the 1st','c1',?,1,1)`).bind(h, "u", NOW).run();
      await e().DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,spending_off,billing_hold,updated_at) VALUES (?,?,?,?,?,0,0,0,?)`).bind(h, "pro", 1, "active", 30_000_000, NOW).run();
      await e().DB.prepare(`INSERT INTO billing_subscriptions (home_id, customer_id, subscription_id, plan, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).bind(h, `cus_${h}`, `sub_${h}`, "pro", "active", NOW, NOW).run();
    }
    const ctx = (now: number): TopupSweepCtx<object> => ({ ...x.ctx(now), spendable: async (h) => { seen.add(h); return 10_000 * 10_000; } });
    await sweepAutoTopup(e(), ctx(NOW));
    expect(seen.size).toBe(100);
    await sweepAutoTopup(e(), ctx(NOW + 300_000));
    expect(seen.size).toBe(105);
    for (const t of ["topup_settings", "flux_home_keys", "billing_subscriptions"]) await e().DB.prepare(`DELETE FROM ${t} WHERE home_id LIKE 'h-%'`).run();
  });
});

// ---- second review round ------------------------------------------------------------------------------------------------------------------
describe("round 2, finding 1: the stale path abandons only after a void that took effect", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  async function staleAttempt(x: Sweep): Promise<TopupAttempt> {
    const s = await seedSettings(); const a = await claimed(s);
    await e().DB.prepare("UPDATE topup_attempts SET state='invoiced', invoice_id='in_old' WHERE attempt_id=?").bind(a.attempt_id).run();
    x.f.cfg.voidFail = true; x.spendable = null; // the balance is unknown: only the open attempt is worked, no new claim
    return a;
  }
  it("open at the read, paid before the void, the void rejected: the payment goes to its grant and the reservation stays", async () => {
    const x = sweepFixture(); const a = await staleAttempt(x);
    let reads = 0;
    (x.f.client as unknown as { getInvoice: (id: string) => Promise<unknown> }).getInvoice = async () => ({ status: ++reads === 1 ? "open" : "paid", tax: 160 });
    await sweepAutoTopup(e(), x.ctx(NOW + 21 * 3_600_000));
    expect(x.log).toContain("grant");
    expect((await stateOf(a.attempt_id)).state).toBe("done");
    expect(await reserved("2026-11")).toBe(2000);
  });
  it("a void that fails with the invoice still open leaves the attempt open, and the next pass reads it again", async () => {
    const x = sweepFixture(); const a = await staleAttempt(x);
    (x.f.client as unknown as { getInvoice: (id: string) => Promise<unknown> }).getInvoice = async () => ({ status: "open", tax: 160 });
    await sweepAutoTopup(e(), x.ctx(NOW + 21 * 3_600_000));
    expect((await stateOf(a.attempt_id)).state).toBe("invoiced");
    expect(await reserved("2026-11")).toBe(2000);
    x.f.cfg.voidFail = false;
    await sweepAutoTopup(e(), x.ctx(NOW + 21 * 3_600_000 + 60_000));
    expect((await stateOf(a.attempt_id)).state).toBe("abandoned");
    expect(await reserved("2026-11")).toBe(0);
  });
});

describe("round 2, finding 2: the cap month is the month of a fresh clock read at the first pay call", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("the sweep started before midnight, the pay call is after it: the charge counts in the new month", async () => {
    const BEFORE = Date.UTC(2026, 10, 30, 23, 59, 58), AFTER = Date.UTC(2026, 11, 1, 0, 0, 3);
    const s = await seedSettings({ amount_cents: 2000, cap_cents: 2000 }); const f = fake(); const a = await claimed(s, BEFORE);
    f.deps = { ...f.deps, clock: () => AFTER };
    expect(await runTopupAttempt(e(), f.deps, a, BEFORE)).toBe("paid");
    expect(await reserved("2026-11")).toBe(0); expect(await reserved("2026-12")).toBe(2000);
    await e().DB.prepare("UPDATE topup_attempts SET state='done'").run();
    expect(await claimTopupAttempt(e(), s, AFTER + 11 * 60_000)).toEqual({ claimed: false, reason: "cap" });
  });
});

describe("round 2, finding 3: notices are queued under the lease the sweep holds, and a marker follows its notice", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  function leasedFixture(x: Sweep, fail: { n: number }) {
    const got: Array<{ kind: string; lease: unknown }> = [];
    x.f.deps = { ...x.f.deps, notify: async (kind, _h, _k, lease) => {
      if (!lease) throw new Error("home_busy"); // what the real notify does when the home's lease is held and not passed
      if (fail.n > 0) { fail.n--; throw new Error("notice store down"); }
      got.push({ kind, lease });
    } };
    const ctx = (now = NOW): TopupSweepCtx<object> => ({ ...x.ctx(now), deps: x.f.deps, onHome: async (_h, work) => { await work({ held: true }); } });
    return { got, ctx };
  }
  it("a pause notice reaches the owner with the held lease", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.payFail = "sca"; const l = leasedFixture(x, { n: 0 });
    await sweepAutoTopup(e(), l.ctx());
    expect(l.got).toEqual([{ kind: "topup_action_needed", lease: { held: true } }]);
  });
  it("a notice that failed leaves the pause unmarked and the next sweep sends it, once", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.payFail = "sca"; const l = leasedFixture(x, { n: 1 });
    await sweepAutoTopup(e(), l.ctx());
    expect(l.got).toEqual([]);
    expect((await e().DB.prepare("SELECT notified_reason AS n FROM topup_state").first<{ n: string | null }>())?.n).toBeNull();
    await sweepAutoTopup(e(), l.ctx(NOW + 60_000)); await sweepAutoTopup(e(), l.ctx(NOW + 120_000));
    expect(l.got.map((g) => g.kind)).toEqual(["topup_action_needed"]);
  });
  it("a cap notice that failed is tried again, and one that went out is not repeated", async () => {
    await seedSettings({ amount_cents: 6000, cap_cents: 5000 }); const x = sweepFixture(); const l = leasedFixture(x, { n: 1 });
    await sweepAutoTopup(e(), l.ctx());
    expect(l.got).toEqual([]);
    await sweepAutoTopup(e(), l.ctx(NOW + 60_000)); await sweepAutoTopup(e(), l.ctx(NOW + 120_000));
    expect(l.got.map((g) => g.kind)).toEqual(["topup_cap_reached"]);
  });
  it("a tax notice that failed leaves no marker, so the next backoff tells the owner", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.country = null; const l = leasedFixture(x, { n: 1 });
    await sweepAutoTopup(e(), l.ctx());
    expect(l.got).toEqual([]);
    await sweepAutoTopup(e(), l.ctx(NOW + 61 * 60_000));
    expect(l.got.map((g) => g.kind)).toEqual(["topup_address_needed"]);
  });
});

describe("round 2, finding 4: a tax finalization refusal backs off, tells the owner once and voids the invoice", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("HTTP 400 customer_tax_location_invalid: one invoice per backoff, one notice, the invoice voided", async () => {
    await seedSettings(); const x = sweepFixture();
    x.f.onFinalize = async () => { throw new StripeError(400, "stripe_customer_tax_location_invalid"); };
    for (let m = 0; m < 60; m += 5) await sweepAutoTopup(e(), x.ctx(NOW + m * 60_000));
    expect(x.f.calls.filter((c) => c === "create")).toHaveLength(1);
    expect(x.f.notices).toEqual(["topup_address_needed"]);
    expect(x.f.voided).toContain("in_topup_1");
    expect(x.f.charges).toBe(0);
    await sweepAutoTopup(e(), x.ctx(NOW + 61 * 60_000));
    expect((await attempts()).length).toBe(2);
    expect(x.f.notices).toEqual(["topup_address_needed"]);
  });
});

describe("round 2, finding 5: a busy home moves to the back of the line", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("fifty attempts whose homes are always busy do not hold the slots; they still come round when the home is free", async () => {
    const x = sweepFixture(); x.granted = true;
    for (let i = 0; i < 50; i++) {
      await e().DB.prepare(`INSERT INTO topup_attempts (attempt_id, home_id, settings_revision, amount_cents, month_key, state, invoice_id, claimed_at, updated_at, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(`busy-${i}`, `busy-home-${i}`, 1, 2000, "2026-11", "paid", `in_busy_${i}`, NOW - 3 * 86_400_000, NOW - 3 * 86_400_000, NOW - 3 * 86_400_000).run();
    }
    const s = await seedSettings(); const f = x.f; f.cfg.payFail = "lost_once"; const a = await claimed(s, NOW - 3_600_000);
    await e().DB.prepare("UPDATE topup_attempts SET updated_at=? WHERE attempt_id=?").bind(NOW - 600_000, a.attempt_id).run();
    const ctx = (now: number): TopupSweepCtx<object> => ({ ...x.ctx(now), onHome: async (h, work) => { if (h.startsWith("busy-home-")) return; await work({}); } });
    await sweepAutoTopup(e(), ctx(NOW));
    await sweepAutoTopup(e(), ctx(NOW + 60_000));
    expect(f.calls).toContain("pay");
    expect((await stateOf(a.attempt_id)).state).not.toBe("claimed");
    // the home frees up: the paid attempts are still there and get their grant
    await sweepAutoTopup(e(), x.ctx(NOW + 120_000)); await sweepAutoTopup(e(), x.ctx(NOW + 180_000));
    expect((await e().DB.prepare("SELECT COUNT(*) AS n FROM topup_attempts WHERE attempt_id LIKE 'busy-%' AND state='done'").first<{ n: number }>())?.n).toBe(50);
  });
  it("a hundred eligible homes that are always busy do not starve the ones after them", async () => {
    const seen = new Set<string>(); const x = sweepFixture();
    for (let i = 0; i < 105; i++) {
      const h = `bh-${String(i).padStart(3, "0")}`;
      await e().DB.prepare(`INSERT INTO topup_settings (home_id,user_id,enabled,amount_cents,threshold_cents,cap_cents,cap_period,cap_resets,consent_id,updated_at,revision,applied_revision) VALUES (?,?,1,2000,500,5000,'month','00:00 UTC on the 1st','c1',?,1,1)`).bind(h, "u1", NOW).run();
      await e().DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,spending_off,billing_hold,updated_at) VALUES (?,?,?,?,?,0,0,0,?)`).bind(h, "pro", 1, "active", 30_000_000, NOW).run();
      await e().DB.prepare(`INSERT INTO billing_subscriptions (home_id, customer_id, subscription_id, plan, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).bind(h, `cus_${h}`, `sub_${h}`, "pro", "active", NOW, NOW).run();
    }
    const ctx = (now: number): TopupSweepCtx<object> => ({ ...x.ctx(now),
      onHome: async (h, work) => { if (h < "bh-100") return; await work({}); },
      spendable: async (h) => { seen.add(h); return 10_000 * 10_000; } });
    await sweepAutoTopup(e(), ctx(NOW));
    await sweepAutoTopup(e(), ctx(NOW + 300_000));
    expect(seen.size).toBe(5); // bh-100 to bh-104 were reached by the second sweep at the latest
    for (const t of ["topup_settings", "flux_home_keys", "billing_subscriptions"]) await e().DB.prepare(`DELETE FROM ${t} WHERE home_id LIKE 'bh-%'`).run();
  });
});

describe("round 3, finding 1: a restart between the pay stamp and the pay call never charges outside the cap", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  const LATE_NOV = Date.UTC(2026, 10, 30, 23, 59, 50), EARLY_DEC = Date.UTC(2026, 11, 1, 0, 1, 0);
  it("stamped in November, never sent, resumed in December: the invoice is voided, the reservation returned, and the new month charges once within its cap", async () => {
    const s = await seedSettings({ amount_cents: 2000, cap_cents: 2000 }); const f = fake(); const a = await claimed(s, LATE_NOV);
    f.deps = { ...f.deps, clock: () => LATE_NOV };
    const real = f.client.payInvoice; let sent = 0;
    f.client.payInvoice = (async () => { sent++; throw new Error("process died before the call went out"); }) as never; // the stamp is written, the call never leaves
    expect(await runTopupAttempt(e(), f.deps, a, LATE_NOV)).toBe("retry");
    expect((await rowOf(a.attempt_id)).pay_started_at).toBe(LATE_NOV);
    f.client.payInvoice = ((...x: Parameters<typeof real>) => { sent++; return real(...x); }) as never; sent = 0;
    f.deps = { ...f.deps, clock: () => EARLY_DEC };
    expect(await runTopupAttempt(e(), f.deps, await rowOf(a.attempt_id), EARLY_DEC)).toBe("abandoned");
    expect(sent).toBe(0); expect(f.charges).toBe(0); expect(f.voided).toEqual(["in_topup_1"]);
    expect(await reserved("2026-11")).toBe(0); expect(await reserved("2026-12")).toBe(0);
    // a fresh attempt in December takes the December allowance once; a second one is refused by the cap
    const b = await claimed(s, EARLY_DEC + 60_000);
    f.voided.length = 0;
    expect(await runTopupAttempt(e(), f.deps, b, EARLY_DEC + 60_000)).toBe("paid");
    await e().DB.prepare("UPDATE topup_attempts SET state='done'").run();
    expect(await claimTopupAttempt(e(), s, EARLY_DEC + 20 * 60_000)).toEqual({ claimed: false, reason: "cap" });
    expect(f.charges).toBe(1); expect(await reserved("2026-12")).toBe(2000);
  });
});

describe("round 3, finding 2: an uncollectible invoice is still payable, so it is voided before the attempt is given up", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("an uncollectible stale invoice is voided and only then abandoned; one that cannot be voided stays open", async () => {
    const s = await seedSettings(); const a = await claimed(s); const x = sweepFixture();
    await e().DB.prepare("UPDATE topup_attempts SET state='invoiced', invoice_id='in_unc' WHERE attempt_id=?").bind(a.attempt_id).run();
    x.spendable = null;
    (x.f.client as unknown as { getInvoice: (id: string) => Promise<unknown> }).getInvoice = async (id: string) => ({ id, status: x.f.voided.includes(id) ? "void" : "uncollectible", tax: 160 });
    x.f.cfg.voidFail = true;
    await sweepAutoTopup(e(), x.ctx(NOW + 21 * 3_600_000));
    expect((await stateOf(a.attempt_id)).state).toBe("invoiced"); expect(await reserved("2026-11")).toBe(2000);
    x.f.cfg.voidFail = false;
    await sweepAutoTopup(e(), x.ctx(NOW + 21 * 3_600_000 + 60_000));
    expect(x.f.voided).toEqual(["in_unc"]);
    expect((await stateOf(a.attempt_id)).state).toBe("abandoned"); expect(await reserved("2026-11")).toBe(0);
  });
});

describe("round 3, finding 3: an authentication refusal as Stripe's client really reports it pauses at once", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("stripe_authentication_required is an action-needed pause, not a decline", async () => {
    const s = await seedSettings(); const f = fake(); const a = await claimed(s);
    (f.client as unknown as { payInvoice: () => Promise<never> }).payInvoice = async () => { throw new StripeError(402, "stripe_authentication_required"); };
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("action_required");
    expect(f.notices).toEqual(["topup_action_needed"]);
    expect(await e().DB.prepare("SELECT pause_reason, declines FROM topup_state").first()).toEqual({ pause_reason: "authentication_required", declines: 0 });
    expect((await stateOf(a.attempt_id)).error).toBe("authentication_required");
  });
  it("the stored reasons carry one stripe_ prefix", async () => {
    const s = await seedSettings(); const f = fake(); f.cfg.payFail = "decline"; const a = await claimed(s);
    expect(await runTopupAttempt(e(), f.deps, a, NOW)).toBe("declined");
    expect((await stateOf(a.attempt_id)).error).toBe("stripe_card_declined");
  });
});

describe("round 3, finding 4: the paused-notice queue rotates", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("twenty-six unnoticed pauses with the first twenty-five always busy: the twenty-sixth is reached", async () => {
    const x = sweepFixture(); const told: string[] = [];
    x.f.deps = { ...x.f.deps, notify: async (_k, h) => { told.push(h); } };
    for (let i = 0; i < 26; i++) {
      const h = `pz-${String(i).padStart(2, "0")}`;
      await e().DB.prepare("INSERT INTO topup_state (home_id, paused_at, pause_reason) VALUES (?,?,?)").bind(h, NOW - 1000, "declined").run();
    }
    // sweep 1 sees pz-00..pz-24 (all busy) and stamps them; sweep 2 then looks at pz-25 first
    const busy = (now: number): TopupSweepCtx<object> => ({ ...x.ctx(now), deps: x.f.deps, onHome: async (h, work) => { if (h < "pz-25") return; await work({}); } });
    await sweepAutoTopup(e(), busy(NOW)); expect(told).toEqual([]);
    await sweepAutoTopup(e(), busy(NOW + 60_000));
    expect(told).toEqual(["pz-25"]);
    await e().DB.prepare("DELETE FROM topup_state WHERE home_id LIKE 'pz-%'").run();
  });
});

describe("round 3, finding 5: the tax notice key names the problem, not the attempt", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  it("two attempts of one unchanged tax problem carry the same notice key, even when the marker was lost", async () => {
    await seedSettings(); const x = sweepFixture(); x.f.cfg.country = null; const keys: string[] = [];
    x.f.deps = { ...x.f.deps, notify: async (_k, _h, key) => { keys.push(key); } };
    await sweepAutoTopup(e(), x.ctx(NOW));
    await e().DB.prepare("UPDATE topup_state SET notified_reason=NULL").run(); // the notice went out, the marker write was lost
    await sweepAutoTopup(e(), x.ctx(NOW + 61 * 60_000));
    expect((await attempts()).length).toBe(2);
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    expect(keys[0]).not.toContain((await e().DB.prepare("SELECT attempt_id FROM topup_attempts LIMIT 1").first<{ attempt_id: string }>())!.attempt_id);
  });
});

// ---- the Flux eligibility precheck: the real call, through a fake fetcher that answers as FluxMain's contract says ---------------------------
describe("auto top-up Flux eligibility precheck", () => {
  const ACCT = "flux-acct-9"; const OWNER = "user-pre-1";
  const fe = { ...env, FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: "t".repeat(40), FLUX_CLOUD_SERVICE_TOKEN: "s".repeat(40), CLOUD_FLUX_ROUTES_ENABLED: "1" } as Env;
  type Answer = { status: number; body: string } | "network" | "timeout";
  const ok = { status: 200, body: JSON.stringify({ eligible: true }) };
  const notFresh = { status: 200, body: JSON.stringify({ eligible: false, reason: "account_not_fresh" }) };
  const bad = { status: 400, body: JSON.stringify({ error: { code: "invalid_request", message: "account_id is required" } }) };
  const retry503 = { status: 503, body: JSON.stringify({ error: { code: "credit_grants_retry", reason: "unavailable" } }) };
  function fetcher(answer: Answer, caps: Record<string, boolean> = { grantEligibility: true, reversalTargets: true }) {
    const log: { url: string; auth: string | null }[] = [];
    const fn = async (url: string, init?: RequestInit): Promise<Response> => {
      log.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/capabilities")) return new Response(JSON.stringify({ capabilities: caps }), { status: 200 });
      if (answer === "network") throw new TypeError("fetch failed");
      if (answer === "timeout") throw new DOMException("timed out", "TimeoutError");
      return new Response(answer.body, { status: answer.status });
    };
    return { fn, log };
  }
  const alertsOf = async (kind: string) => (await e().DB.prepare("SELECT detail FROM cloud_alerts WHERE kind=? AND resolved_at IS NULL").bind(kind).all<{ detail: string }>()).results;
  async function setup(answer: Answer, caps?: Record<string, boolean>) {
    const s = await seedSettings(); const f = fake(); const fx = fetcher(answer, caps);
    delete f.deps.precheck; f.deps.fetch = fx.fn;
    const keys: string[] = [];
    f.deps.notify = async (k, _h, key) => { f.notices.push(k); keys.push(key); };
    return { s, f, fx, keys };
  }
  beforeEach(async () => {
    await seedSub(); await seedKey();
    await e().DB.prepare("DELETE FROM cloud_alerts").run();
    await e().DB.prepare(`INSERT OR REPLACE INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)`)
      .bind(HOME, "inst-pre", OWNER, "running", "running", "sha256:x", "k").run();
    await e().DB.prepare("INSERT OR REPLACE INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,1,'lnk-pre',1,0)").bind(OWNER, ACCT).run();
  });
  afterEach(async () => {
    for (const t of ["cloud_alerts", "flux_links", "cloud_homes", "billing_subscriptions"]) await e().DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("eligible true charges, asked with the grants token for the home's Flux account, after reading the capability", async () => {
    const { s, f, fx } = await setup(ok); const a = await claimed(s);
    expect(await runTopupAttempt(fe, f.deps, a, NOW)).toBe("paid");
    expect(f.charges).toBe(1);
    const asked = fx.log.find((l) => l.url.includes("/eligibility"))!;
    expect(asked.url).toBe(`https://router.test/internal/cloud-home/credit-grants/eligibility?account_id=${ACCT}`);
    expect(asked.auth).toBe(`Bearer ${"t".repeat(40)}`);
    expect(fx.log[0]!.url.endsWith("/credit-grants/capabilities")).toBe(true);
  });

  const nothingCharged: [string, Answer, Record<string, boolean>?][] = [
    ["capability absent", ok, { reversalTargets: true }],
    ["capability false", ok, { grantEligibility: false }],
    ["503 credit_grants_retry", retry503],
    ["500", { status: 500, body: "{}" }],
    ["404 route missing", { status: 404, body: "" }],
    ["200 with malformed JSON", { status: 200, body: "<html>bad gateway" }],
    ["200 with no eligible field", { status: 200, body: "{}" }],
    ["200 with eligible as a string", { status: 200, body: JSON.stringify({ eligible: "true" }) }],
    ["200 with eligible 1", { status: 200, body: JSON.stringify({ eligible: 1 }) }],
    ["a timeout", "timeout"],
    ["a network error", "network"],
  ];
  for (const [name, answer, caps] of nothingCharged) {
    it(`${name}: nothing charged, no Stripe call, no notice, no alert, no backoff, no reservation left`, async () => {
      const { s, f } = await setup(answer, caps); const a = await claimed(s);
      expect(await runTopupAttempt(fe, f.deps, a, NOW)).toBe("abandoned");
      expect(f.calls).toEqual([]); expect(f.charges).toBe(0); expect(f.notices).toEqual([]);
      expect((await e().DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind LIKE 'topup.%' OR kind LIKE 'flux.%'").first<{ n: number }>())!.n).toBe(0);
      expect((await e().DB.prepare("SELECT reserved_cents AS r FROM topup_month").first<{ r: number }>())?.r).toBe(0);
      expect(await e().DB.prepare("SELECT retry_after FROM topup_state").first()).toBeNull();
      // The normal cadence asks again, and an answer of eligible then charges.
      const f2 = await setup(ok); expect(await runTopupAttempt(fe, f2.f.deps, await claimed(f2.s, NOW + 60_000), NOW + 60_000)).toBe("paid");
    });
  }
  it("Flux off, or a home with no Flux link: no request, nothing charged", async () => {
    const { s, f, fx } = await setup(ok); const a = await claimed(s);
    expect(await runTopupAttempt({ ...fe, CLOUD_FLUX_ROUTES_ENABLED: undefined } as Env, f.deps, a, NOW)).toBe("abandoned");
    expect(fx.log).toEqual([]); expect(f.calls).toEqual([]);
    await e().DB.prepare("DELETE FROM flux_links").run();
    expect(await runTopupAttempt(fe, f.deps, await claimed(s, NOW + 60_000), NOW + 60_000)).toBe("abandoned");
    expect(fx.log).toEqual([]); expect(f.calls).toEqual([]); expect(f.charges).toBe(0);
  });

  it("eligible false: no charge, no pause, backed off 24 hours, ONE owner notice per episode, one digest alert that charged nothing", async () => {
    const { s, f, keys } = await setup(notFresh); const a = await claimed(s);
    expect(await runTopupAttempt(fe, f.deps, a, NOW)).toBe("abandoned");
    expect(f.calls).toEqual([]); expect(f.charges).toBe(0);
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "abandoned", error: "precheck_account_not_fresh", invoice_id: null });
    expect(await e().DB.prepare("SELECT paused_at, retry_after FROM topup_state").first()).toEqual({ paused_at: null, retry_after: NOW + 86_400_000 });
    expect(await claimTopupAttempt(e(), s, NOW + 3_600_000)).toEqual({ claimed: false, reason: "backoff" });
    expect(f.notices).toEqual(["topup_ineligible"]); expect(keys).toEqual(["address:account_not_fresh:0"]);
    const al = await alertsOf("topup.flux_ineligible"); expect(al).toHaveLength(1);
    expect(JSON.parse(al[0]!.detail)).toMatchObject({ reason: "account_not_fresh", charged: false });
    expect(await alertsOf("flux.account_not_fresh")).toHaveLength(0); // that page kind is for a charge that was taken
    // A day later: asked again, still refused, same episode: no second notice, no second alert, a new 24 hour backoff.
    const t2 = NOW + 86_400_000 + 1000;
    expect(await runTopupAttempt(fe, f.deps, await claimed(s, t2), t2)).toBe("abandoned");
    expect(f.notices).toEqual(["topup_ineligible"]); expect(await alertsOf("topup.flux_ineligible")).toHaveLength(1);
    expect(f.calls).toEqual([]);
  });
  it("a failed notice leaves no marker and the next look sends it again under the same key", async () => {
    const { s, f, keys } = await setup(notFresh);
    let fail = true; f.deps.notify = async (k, _h, key) => { if (fail) throw new Error("queue down"); f.notices.push(k); keys.push(key); };
    await runTopupAttempt(fe, f.deps, await claimed(s), NOW);
    expect(f.notices).toEqual([]); fail = false;
    const t2 = NOW + 86_400_000 + 1000;
    await runTopupAttempt(fe, f.deps, await claimed(s, t2), t2);
    expect(f.notices).toEqual(["topup_ineligible"]); expect(keys).toEqual(["address:account_not_fresh:0"]);
  });
  it("400: no charge, a digest alert, no owner notice, backed off", async () => {
    const { s, f } = await setup(bad); const a = await claimed(s);
    expect(await runTopupAttempt(fe, f.deps, a, NOW)).toBe("abandoned");
    expect(f.calls).toEqual([]); expect(f.charges).toBe(0); expect(f.notices).toEqual([]);
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "abandoned", error: "precheck_refused" });
    expect(await alertsOf("topup.precheck_refused")).toHaveLength(1);
    expect((await e().DB.prepare("SELECT retry_after AS r FROM topup_state").first<{ r: number }>())!.r).toBeGreaterThan(NOW);
  });
  it("Stripe is called only when eligible is exactly true", async () => {
    const cases: [Answer, number][] = [[ok, 1], [notFresh, 0], [bad, 0], [retry503, 0], ["network", 0], [{ status: 200, body: "nope" }, 0]];
    for (const [answer, charges] of cases) {
      await e().DB.prepare("DELETE FROM topup_attempts").run(); await e().DB.prepare("DELETE FROM topup_state").run(); await e().DB.prepare("DELETE FROM topup_month").run();
      const { s, f } = await setup(answer);
      await runTopupAttempt(fe, f.deps, await claimed(s), NOW);
      expect(f.charges).toBe(charges);
      expect(f.calls.length > 0).toBe(charges === 1);
    }
  });
  // PRODFLUX r4 A: switched on with EITHER Flux secret missing, a grant cannot be sent, so the precheck is transient flux_not_ready: no invoice
  // is made, an open one is voided, nothing is charged, and no new attempt is claimed until both are back.
  const MISSING: [string, Partial<Env>][] = [["FLUX_CLOUD_SERVICE_TOKEN", { FLUX_CLOUD_SERVICE_TOKEN: undefined }], ["FLUX_CLOUD_GRANTS_TOKEN", { FLUX_CLOUD_GRANTS_TOKEN: undefined }]];
  it.each(MISSING)("%s absent: a claimed attempt with no invoice is released with no Stripe call and no Flux read", async (_k, over) => {
    const { s, f, fx } = await setup(ok); const a = await claimed(s);
    expect(await runTopupAttempt({ ...fe, ...over } as Env, f.deps, a, NOW)).toBe("abandoned");
    expect(f.calls).toEqual([]); expect(f.charges).toBe(0); expect(fx.log).toEqual([]); expect(f.notices).toEqual([]);
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "abandoned", error: "precheck_flux_not_ready", invoice_id: null });
    expect((await e().DB.prepare("SELECT reserved_cents AS r FROM topup_month").first<{ r: number }>())?.r).toBe(0);
    expect(await e().DB.prepare("SELECT retry_after FROM topup_state").first()).toBeNull(); // no backoff: asked again on the normal cadence
  });
  it.each(MISSING)("%s absent: an invoiced attempt whose invoice is open is voided and never paid", async (_k, over) => {
    const { s, f } = await setup(ok); const a = await claimed(s);
    f.onFinalize = async () => { throw new Error("network: finalize lost"); };
    expect(await runTopupAttempt(fe, f.deps, a, NOW)).toBe("retry");
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "invoiced", invoice_id: "in_topup_1" });
    f.onFinalize = undefined;
    const cur = (await e().DB.prepare("SELECT * FROM topup_attempts WHERE attempt_id=?").bind(a.attempt_id).first<TopupAttempt>())!;
    expect(await runTopupAttempt({ ...fe, ...over } as Env, f.deps, cur, NOW + 3 * 60_000)).toBe("abandoned");
    expect(f.voided).toEqual(["in_topup_1"]); expect(f.charges).toBe(0); expect(f.calls).not.toContain("pay");
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "abandoned", error: "precheck_flux_not_ready" });
    expect((await e().DB.prepare("SELECT reserved_cents AS r FROM topup_month").first<{ r: number }>())?.r).toBe(0);
  });
  it("the default precheck with no service token answers flux_not_ready before any Flux read", async () => {
    const { s, f, fx } = await setup(ok); const a = await claimed(s);
    expect(await topupPrecheck({ ...fe, FLUX_CLOUD_SERVICE_TOKEN: undefined } as Env, a, fx.fn)).toEqual({ allow: false, kind: "transient", reason: "flux_not_ready" });
    expect(await topupPrecheck({ ...fe, FLUX_CLOUD_SERVICE_TOKEN: "short" } as Env, a, fx.fn)).toEqual({ allow: false, kind: "transient", reason: "flux_not_ready" });
    expect(fx.log).toEqual([]); expect(f.calls).toEqual([]);
  });
  it.each(MISSING)("%s absent: the outage voids an in-flight auto top-up, claims nothing new, and after recovery it fires again exactly once while under the threshold", async (_k, over) => {
    const { s, f } = await setup(ok);
    const log: string[] = [];
    let spendable: number | null = 0; // under the threshold (500 cents) the whole time
    const ctx = (now: number, claiming = true): TopupSweepCtx<object> => ({
      now, deps: f.deps, onHome: async (_h, work) => { await work({}); }, claiming,
      spendable: async () => { log.push("status"); return spendable; },
      grant: async () => { log.push("grant"); return true; }, raiseCap: async () => { log.push("raise"); return "raised"; },
    });
    // In flight when the secret goes missing: invoiced, the invoice open (finalize's answer was lost).
    f.onFinalize = async () => { throw new Error("network: finalize lost"); };
    await sweepAutoTopup(fe, ctx(NOW));
    f.onFinalize = undefined;
    expect(await attempts()).toEqual(["invoiced"]); expect(f.charges).toBe(0);
    const out = { ...fe, ...over } as Env;
    await sweepAutoTopup(out, ctx(NOW + 3 * 60_000, false));
    expect(await attempts()).toEqual(["abandoned"]); expect(f.voided).toEqual(["in_topup_1"]); expect(f.charges).toBe(0);
    log.length = 0;
    for (const m of [10, 20, 30]) await sweepAutoTopup(out, ctx(NOW + m * 60_000, false));
    expect(await attempts()).toEqual(["abandoned"]); expect(log).toEqual([]); // not even a balance read: no new claim while not ready
    // Both secrets back: one new attempt, charged once, granted; the next sweeps (cooldown, then still under threshold but open/paid) buy nothing more.
    await sweepAutoTopup(fe, ctx(NOW + 40 * 60_000));
    expect(await attempts()).toEqual(["abandoned", "done"]); expect(f.charges).toBe(1);
    for (const m of [42, 45, 49]) await sweepAutoTopup(fe, ctx(NOW + m * 60_000));
    expect(await attempts()).toEqual(["abandoned", "done"]); expect(f.charges).toBe(1);
    expect(log.filter((l) => l === "grant")).toEqual(["grant"]);
    spendable = 5_000 * 10_000; // the credit landed: above the threshold, nothing more is bought
    await sweepAutoTopup(fe, ctx(NOW + 60 * 60_000));
    expect(f.charges).toBe(1);
  });

  it("the owner notice wording is exact, in English and German, with no dashes", () => {
    expect(orderWords("topupIneligibleSubject", "en")).toBe("Your auto top-up didn't run");
    expect(orderWords("topupIneligible", "en")).toBe("We tried to top up your Murage Cloud credits, but your Flux Router account can't take them right now. Nothing was charged. Reply to this email and we'll sort it out with you.");
    for (const lang of ["en", "de"]) for (const k of ["topupIneligibleSubject", "topupIneligible"] as const) expect(orderWords(k, lang)).not.toMatch(/[\u2013\u2014]|\b(safe|unsafe|safety)\b/i);
    expect(orderWords("topupIneligible", "de")).toContain("Es wurde nichts abgebucht");
  });
});

describe("round 4, finding 1: an attempt already started is settled with the flag off, and nothing new is charged", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  const off = (x: Sweep, now: number, over: Partial<TopupSweepCtx<object>> = {}): TopupSweepCtx<object> => ({ ...x.ctx(now), charging: false, ...over });
  const invoiced = async (s: TopupSettings) => {
    const a = await claimed(s);
    await e().DB.prepare("UPDATE topup_attempts SET state='invoiced', invoice_id='in_topup_1' WHERE attempt_id=?").bind(a.attempt_id).run();
    return a;
  };
  it("a crash after Stripe took the money, then the flag off: the sweep reads the invoice, grants, and the attempt ends done", async () => {
    const s = await seedSettings(); const x = sweepFixture(); const a = await invoiced(s);
    x.f.charges = 1; // Stripe paid in_topup_1; the worker died before markPaid
    await sweepAutoTopup(e(), off(x, NOW + 3 * 60_000));
    expect(x.log).toEqual(["grant", "raise"]); expect((await stateOf(a.attempt_id)).state).toBe("done");
    expect(x.f.calls).toEqual([]); // no create, no pay: the resume is a read
  });
  it("an open invoice is voided and the reservation returned; no charge is made", async () => {
    const s = await seedSettings(); const x = sweepFixture(); const a = await invoiced(s);
    await sweepAutoTopup(e(), off(x, NOW + 3 * 60_000));
    expect(x.f.voided).toEqual(["in_topup_1"]); expect(x.f.charges).toBe(0);
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "abandoned", error: "charging_off" });
    expect(await reserved("2026-11")).toBe(0);
  });
  it("a claimed attempt with no invoice yet is closed without creating one", async () => {
    const s = await seedSettings(); const x = sweepFixture(); const a = await claimed(s);
    await sweepAutoTopup(e(), off(x, NOW + 3 * 60_000));
    expect(x.f.calls).toEqual([]); expect((await stateOf(a.attempt_id)).state).toBe("abandoned"); expect(await reserved("2026-11")).toBe(0);
  });
  it("paid money whose grant cannot be sent raises the page alert at once, once, and keeps the money", async () => {
    const s = await seedSettings(); const x = sweepFixture(); const a = await invoiced(s);
    x.f.charges = 1;
    await sweepAutoTopup(e(), off(x, NOW + 3 * 60_000, { canGrant: false }));
    await sweepAutoTopup(e(), off(x, NOW + 8 * 60_000, { canGrant: false }));
    expect(x.log).toEqual([]); expect((await stateOf(a.attempt_id)).state).toBe("paid");
    const rows = await e().DB.prepare("SELECT id, severity FROM cloud_alerts WHERE kind='topup.paid_not_granted' AND resolved_at IS NULL").all<{ id: string; severity: string }>();
    expect(rows.results).toEqual([{ id: "alert:topup-paid-ungranted:in_topup_1", severity: "high" }]);
    await e().DB.prepare("DELETE FROM cloud_alerts WHERE kind='topup.paid_not_granted'").run();
  });
  it("Astra r5: the page raised while a grant could not be sent ends when the grant lands", async () => {
    const s = await seedSettings(); const x = sweepFixture(); const a = await invoiced(s);
    x.f.charges = 1;
    await sweepAutoTopup(e(), off(x, NOW + 3 * 60_000, { canGrant: false }));
    await sweepAutoTopup(e(), off(x, NOW + 8 * 60_000));
    expect((await stateOf(a.attempt_id)).state).toBe("done");
    const row = await e().DB.prepare("SELECT resolved_at, resolve_notice_due FROM cloud_alerts WHERE id='alert:topup-paid-ungranted:in_topup_1'").first<{ resolved_at: number | null; resolve_notice_due: number | null }>();
    expect(row).toEqual({ resolved_at: NOW + 8 * 60_000, resolve_notice_due: 1 });
    await e().DB.prepare("DELETE FROM cloud_alerts WHERE kind='topup.paid_not_granted'").run();
  });
  it("with nothing open, charging off starts no charge and reads no balance", async () => {
    await seedSettings(); const x = sweepFixture();
    await sweepAutoTopup(e(), off(x, NOW));
    expect(x.log).toEqual([]); expect(x.f.calls).toEqual([]); expect(await attempts()).toEqual([]);
  });
});

describe("round 4, finding 2: the reservation is pinned to the current month before finalize can take the money", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  const LATE_NOV = Date.UTC(2026, 10, 30, 23, 59, 50), EARLY_DEC = Date.UTC(2026, 11, 1, 0, 1, 0);
  // Stripe applies the customer's credit balance when it finalizes: the invoice comes back paid with nothing due.
  const paidAtFinalize = (f: Fake) => {
    (f.client as unknown as { finalizeInvoice: (id: string, k: string) => Promise<unknown> }).finalizeInvoice = async (id: string) => {
      f.calls.push("finalize"); f.charges++;
      return { id, object: "invoice", status: "paid", total: 2160, tax: 160, amount_due: 0, amount_paid: 0, starting_balance: -2160, ending_balance: 0, automatic_tax: { status: "complete" } };
    };
  };
  it("claimed in November, resumed in December, settled from credit at finalize: the reservation sits in December and a second top-up hits the cap", async () => {
    const s = await seedSettings({ amount_cents: 2000, cap_cents: 2000 }); const f = fake(); const a = await claimed(s, LATE_NOV);
    paidAtFinalize(f); f.deps = { ...f.deps, clock: () => EARLY_DEC };
    expect(await runTopupAttempt(e(), f.deps, a, EARLY_DEC)).toBe("paid");
    expect(f.charges).toBe(1); expect(f.calls).not.toContain("pay");
    expect(await reserved("2026-11")).toBe(0); expect(await reserved("2026-12")).toBe(2000);
    await e().DB.prepare("UPDATE topup_attempts SET state='done'").run();
    expect(await claimTopupAttempt(e(), s, EARLY_DEC + 20 * 60_000)).toEqual({ claimed: false, reason: "cap" });
  });
  it("a new month without room never finalizes: the invoice is given up, the reservation returned", async () => {
    const s = await seedSettings({ amount_cents: 2000, cap_cents: 2000 }); const f = fake(); const a = await claimed(s, LATE_NOV);
    await e().DB.prepare("INSERT INTO topup_month (home_id, month_key, reserved_cents, last_attempt) VALUES (?,?,?,?)").bind(HOME, "2026-12", 2000, "other").run();
    paidAtFinalize(f); f.deps = { ...f.deps, clock: () => EARLY_DEC };
    expect(await runTopupAttempt(e(), f.deps, a, EARLY_DEC)).toBe("abandoned");
    expect(f.calls).not.toContain("finalize"); expect(f.charges).toBe(0);
    expect(await stateOf(a.attempt_id)).toMatchObject({ state: "abandoned", error: "month_cap" });
    expect(await reserved("2026-11")).toBe(0); expect(await reserved("2026-12")).toBe(2000);
  });
});

describe("ITEM 9 fail-closed guard (held-until-item9-highs.ts): CLOUD_AUTOTOPUP_ENABLED=1 charges nothing until the dormant-High fixes land", () => {
  beforeEach(async () => { await seedSub(); await seedKey(); });
  afterEach(() => releaseItem9HoldForTests(true));
  it("with the switch set to 1 the sweep, wired as b5-billing.ts wires it, makes no new claim and no charge", async () => {
    releaseItem9HoldForTests(false);
    await seedSettings(); const x = sweepFixture();
    const charging = topupChargingEnabled({ CLOUD_AUTOTOPUP_ENABLED: "1" });
    expect(charging).toBe(false);
    await sweepAutoTopup(e(), { ...x.ctx(), charging });
    expect(x.f.charges).toBe(0);
    expect(await attempts()).toEqual([]);
    expect(await e().DB.prepare("SELECT COUNT(*) AS n FROM topup_month").first()).toEqual({ n: 0 });
  });
});
