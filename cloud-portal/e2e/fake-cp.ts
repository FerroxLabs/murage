// Test-only control plane for the browser journey. It speaks the real HTTP contract the portal
// uses (Better Auth email OTP + bearer, /v1/account/2fa/*, /v1/homes, /v1/billing/*). The second
// factor is the control plane's own account-2fa-core over an in-memory store, so the assertion
// checks (b1b-webauthn.ts) are the real ones. Stripe is never contacted: the URLs are stubs.
import { createServer } from "node:http";
import {
  assertFinish, assertOptions, registerFinish, registerOptions, stepUpSatisfied, twoFactorStatus,
  type FactorRow, type TwoFactorContext, type TwoFactorStore,
} from "../../cloudflare/control-plane/src/account-2fa-core";
import { HTTPError } from "../../cloudflare/control-plane/src/http";
import { buildDisclosure, prepareConsent, consentSchema, PLAN_NAMES, type PreparedConsent, type TaxQuoteRow } from "../../cloudflare/control-plane/src/legal-flows";
import { PLAN_MONTHLY_USD } from "../../cloudflare/control-plane/src/b5-config";

const PORT = Number(process.env.FAKE_CP_PORT ?? 8788);
const PORTAL_ORIGIN = process.env.PORTAL_ORIGIN ?? "https://cloud.murage.test:3443";
const OTP = "12345678";

const factors: FactorRow[] = [];
const challenges = new Map<string, { userId: string; purpose: string; message: string; exp: number }>();
const stepups = new Map<string, { userId: string; until: number }>();
const store: TwoFactorStore = {
  async listFactors(u) { return factors.filter((f) => f.userId === u); },
  async insertFactor(f) { if (factors.some((x) => x.credentialId === f.credentialId)) return false; factors.push(f); return true; },
  async setCounter(id, c) { const f = factors.find((x) => x.id === id); if (f) f.counter = c; },
  async putChallenge(id, userId, purpose, message, exp) { challenges.set(id, { userId, purpose, message, exp }); },
  async takeChallenge(id, userId, purpose, now) {
    const c = challenges.get(id); challenges.delete(id);
    return c && c.userId === userId && c.purpose === purpose && c.exp > now ? c.message : null;
  },
  async markVerified(s, userId, until) { stepups.set(s, { userId, until }); },
  async verifiedUntil(s, userId) { const v = stepups.get(s); return v && v.userId === userId ? v.until : null; },
};

const users = new Map<string, { id: string; email: string }>();
const sessions = new Map<string, { id: string; userId: string }>();
const purchased = new Set<string>();
const calls: { path: string; body: unknown; userId: string }[] = [];
// Legal flows, in memory: the same consent gate as the real control plane (it runs prepareConsent), the cancel state, the export request, the top-up.
// Stripe Tax stand-in: the same quote shape the real control plane stores (fixed rates per country, test only).
const RATES: Record<string, number> = { US: 0.0825, DE: 0.19, FR: 0.2, GB: 0.2, NL: 0.21 };
const quotes = new Map<string, TaxQuoteRow>();
const state = new Map<string, { plan: string; consent: PreparedConsent; cancelled: boolean; exportRequestedAt: number | null;
  topup: { enabled: boolean; amountUsd: number; thresholdUsd: number; capUsd: number } }>();

function send(res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const path = url.pathname;

    if (path === "/__calls") return send(res, 200, calls);
    if (path === "/__health") return send(res, 200, { ok: true });

    if (path === "/v1/legal/disclosure") {
      const plan = url.searchParams.get("plan");
      if (plan !== "starter" && plan !== "pro" && plan !== "max") return send(res, 400, { error: "invalid_request" });
      return send(res, 200, buildDisclosure(plan, Date.now()));
    }

    if (path === "/api/auth/email-otp/send-verification-otp") return send(res, 200, { success: true });
    if (path === "/api/auth/sign-in/email-otp") {
      if (body?.otp !== OTP) return send(res, 400, { code: "INVALID_OTP" });
      let user = [...users.values()].find((u) => u.email === body.email);
      if (!user) { user = { id: crypto.randomUUID(), email: body.email }; users.set(user.id, user); }
      const session = { id: crypto.randomUUID(), userId: user.id };
      const token = `tok_${crypto.randomUUID()}`;
      sessions.set(token, session);
      return send(res, 200, { token, user }, { "set-auth-token": token, "access-control-expose-headers": "set-auth-token" });
    }

    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const session = bearer ? sessions.get(bearer) : undefined;
    if (path === "/api/auth/sign-out") { if (bearer) sessions.delete(bearer); return send(res, 200, { success: true }); }
    if (!session) return send(res, 401, { error: "unauthorized" });
    const user = users.get(session.userId)!;
    const ctx: TwoFactorContext = {
      store, portalOrigin: PORTAL_ORIGIN, userId: user.id, userEmail: user.email, sessionId: session.id,
      now: Date.now(), randomId: () => crypto.randomUUID(),
    };

    try {
      if (path === "/v1/account/2fa" && req.method === "GET") return send(res, 200, await twoFactorStatus(ctx));
      if (path === "/v1/account/2fa/register/options") return send(res, 200, await registerOptions(ctx));
      if (path === "/v1/account/2fa/register") return send(res, 201, await registerFinish(ctx, body));
      if (path === "/v1/account/2fa/assert/options") return send(res, 200, await assertOptions(ctx));
      if (path === "/v1/account/2fa/assert") return send(res, 200, await assertFinish(ctx, body));
      if (path === "/v1/billing/reserve") {
        if (!(await stepUpSatisfied(ctx))) return send(res, 403, { error: "step_up_required" });
        return send(res, 201, { homeId: "home-1", state: "payment_pending", existing: false });
      }
      if (path === "/v1/legal/quote") {
        const plan = body?.plan as "starter" | "pro" | "max";
        if (!["starter", "pro", "max"].includes(plan) || !/^[A-Za-z]{2}$/.test(String(body?.country))) return send(res, 400, { error: "invalid_request" });
        if (body.postalCode === "00000") return send(res, 409, { error: "tax_unavailable" }); // stands for "Stripe Tax is down"
        const country = String(body.country).toUpperCase(); const rate = RATES[country] ?? 0; const price = PLAN_MONTHLY_USD[plan] * 100;
        const topup = (Number.isInteger(body.topupAmountUsd) ? body.topupAmountUsd : 20) * 100; const now = Date.now();
        const row: TaxQuoteRow = { id: `quote-${crypto.randomUUID()}`, user_id: user.id, plan, country, postal_code: body.postalCode ? String(body.postalCode).trim().toUpperCase() : null,
          price_cents: price, tax_cents: Math.round(price * rate), total_cents: price + Math.round(price * rate), topup_amount_cents: topup,
          topup_tax_cents: Math.round(topup * rate), topup_total_cents: topup + Math.round(topup * rate), source: "stripe_tax", calculation_id: "taxcalc_fake",
          created_at: now, expires_at: now + 30 * 60_000 };
        quotes.set(row.id, row);
        return send(res, 200, buildDisclosure(plan, now, row));
      }
      if (path === "/v1/billing/checkout") {
        // Lane 1's endpoint must refuse a session that has not proved its second factor.
        if (!(await stepUpSatisfied(ctx))) return send(res, 403, { error: "step_up_required" });
        calls.push({ path, body, userId: user.id });
        const parsed = consentSchema.safeParse(body?.consent);
        if (!parsed.success) return send(res, 400, { error: "invalid_request" });
        let consent: PreparedConsent;
        const meta = { claimed: { ip: parsed.data.client?.ip ?? null, ipSource: parsed.data.client?.ipSource ?? "unavailable", userAgent: parsed.data.client?.userAgent ?? null },
          observed: { ip: null, userAgent: null } };
        try { consent = prepareConsent(parsed.data, body.plan, Date.now(), meta, parsed.data.quoteId ? quotes.get(parsed.data.quoteId) ?? null : null, user.id); }
        catch (e) { if (e instanceof HTTPError) return send(res, e.status, { error: e.code }); throw e; }
        state.set(user.id, { plan: body.plan, consent, cancelled: false, exportRequestedAt: null,
          topup: { enabled: consent.topup.enabled, amountUsd: consent.topup.amountCents / 100, thresholdUsd: consent.topup.thresholdCents / 100, capUsd: consent.topup.capCents / 100 } });
        purchased.add(user.id);
        return send(res, 200, { url: "https://checkout.stripe.test/c/pay/cs_test_stub" });
      }
      const mine = state.get(user.id);
      if (path === "/v1/account/cloud") {
        if (!mine) return send(res, 404, { error: "not_found" });
        const plan = mine.plan as "starter" | "pro" | "max";
        return send(res, 200, { homeId: "home-1", subscription: { plan, planName: PLAN_NAMES[plan], priceUsd: PLAN_MONTHLY_USD[plan], status: mine.consent.schedule.delayed ? "trialing" : "active",
          cancelAtPeriodEnd: mine.cancelled, activeUntil: Date.now() + 30 * 86_400_000, serviceStartsAt: mine.consent.schedule.startAt, firstChargeAt: mine.consent.schedule.firstChargeAt,
          waitingForStart: mine.consent.schedule.delayed, refundWindowEndsAt: Date.now() + 7 * 86_400_000 },
        topup: { ...mine.topup, capPeriod: "calendar month", capResets: "00:00 UTC on the first day of each month", applied: true, applyError: null },
        terms: { reacceptRequired: false }, withdrawal: { available: false, endsAt: null, withdrawnAt: null, status: null },
        exportRequest: mine.exportRequestedAt ? { id: "export-1", status: "open", requestedAt: mine.exportRequestedAt, deliveredAt: null, pausesDeletionUntil: mine.exportRequestedAt + 7 * 86_400_000 } : null });
      }
      if (path === "/v1/account/terms") return send(res, 200, { reacceptRequired: false, changed: [], current: buildDisclosure("starter", Date.now()).versions,
        accepted: null, noticeSentAt: null, effectiveAt: null, wording: { reaccept: "", arbitration: "" } });
      if (path === "/v1/account/confirmation") {
        if (!mine) return send(res, 404, { error: "not_found" });
        return send(res, 200, { subject: "Murage Cloud: your order confirmation and contract copy", sentAt: Date.now(),
          text: `${mine.consent.renewalText}\n\nCOPY OF THE MURAGE CLOUD TERMS (fake control plane)` });
      }
      if (path === "/v1/account/cancel-plan") { if (!mine) return send(res, 404, { error: "not_found" }); mine.cancelled = true; return send(res, 200, { canceled: true }); }
      if (path === "/v1/account/export-request") { if (!mine) return send(res, 404, { error: "not_found" }); mine.exportRequestedAt ??= Date.now(); return send(res, 201, { requestId: "export-1" }); }
      if (path === "/v1/account/topup") {
        if (!mine) return send(res, 404, { error: "not_found" });
        mine.topup = { enabled: body.enabled, amountUsd: body.amountUsd, thresholdUsd: body.thresholdUsd, capUsd: body.capUsd };
        return send(res, 200, mine.topup);
      }
      if (path === "/v1/billing/portal") return send(res, 200, { url: "https://billing.stripe.test/p/session/test_stub" });
      if (path === "/v1/homes") {
        return send(res, 200, { homes: purchased.has(user.id)
          ? [{ id: "home-1", name: "Cloud home", status: "running", publicOrigin: "https://home-test.murage.test" }] : [] });
      }
    } catch (e) {
      if (e instanceof HTTPError) return send(res, e.status, { error: e.code });
      throw e;
    }
    return send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "internal_error" });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`fake control plane on ${PORT}`));
