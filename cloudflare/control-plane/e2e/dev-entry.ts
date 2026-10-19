// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser-journey entry for `wrangler dev`: the REAL merged control-plane Worker (createWorker, real Better Auth, real
// account-2fa, real billing routes, real D1 migrations) with only the outside world replaced:
//   - env.EMAIL captures the OTP mail instead of sending it,
//   - Stripe's HTTPS API answers from fixtures (recorded for the test to read),
//   - the incoming URL is presented to the Worker as its configured https origin.
// Nothing here is deployed: wrangler.e2e.jsonc is only used by cloud-portal's Playwright journey.
import { createWorker } from "../src/index";
import { LEGAL_DOCS } from "../src/legal-docs.generated";

const outbox: { to: string; subject: string; text: string }[] = [];
const stripeCalls: { method: string; path: string; form: Record<string, string> }[] = [];
const cancelAtEnd: Record<string, boolean> = {};
let lastPlanTotal = 0;

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const stripeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
  stripeCalls.push({ method: init?.method ?? "GET", path: url.pathname, form });
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/customers") return json({ id: "cus_e2e0001" });
  if (url.pathname === "/v1/checkout/sessions" && method === "GET") return json({ data: [] });
  if (url.pathname === "/v1/checkout/sessions") return json({ id: "cs_test_e2e0001", url: "https://checkout.stripe.test/c/pay/cs_test_e2e0001" });
  if (/^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(url.pathname)) return json({ id: url.pathname.split("/")[4], status: "expired" });
  // Stripe Tax Calculations stand-in (test mode, fixed rates): the page shows the total including tax before the boxes.
  if (url.pathname === "/v1/tax/calculations") {
    // Postal code 00000 stands for "Stripe Tax is down": the portal must say to try again and keep pay disabled.
    if (form["customer_details[address][postal_code]"] === "00000") return new Response(JSON.stringify({ error: { message: "tax_down" } }), { status: 500, headers: { "content-type": "application/json" } });
    const rate = ({ US: 0.0825, DE: 0.19, FR: 0.2, GB: 0.2, NL: 0.21 } as Record<string, number>)[form["customer_details[address][country]"] ?? ""] ?? 0;
    const items = [0, 1].filter((n) => form[`line_items[${n}][amount]`]).map((n) => ({ reference: form[`line_items[${n}][reference]`],
      amount: Number(form[`line_items[${n}][amount]`]), amount_tax: Math.round(Number(form[`line_items[${n}][amount]`]) * rate) }));
    const tax = items.reduce((t, i) => t + i.amount_tax, 0);
    lastPlanTotal = items[0] ? items[0].amount + items[0].amount_tax : lastPlanTotal;
    return json({ id: "taxcalc_e2e", amount_total: items.reduce((t, i) => t + i.amount, 0) + tax, tax_amount_exclusive: tax, line_items: { data: items } });
  }
  if (url.pathname === "/v1/invoices/upcoming") return json({ amount_due: lastPlanTotal }); // the recurring total the last quote priced
  if (url.pathname === "/v1/invoices" && method === "GET") return json({ data: [] });
  if (url.pathname.startsWith("/v1/invoices/")) return json({ id: url.pathname.split("/").pop(), payment_intent: "pi_e2e0001", charge: "ch_e2e0001", amount_paid: lastPlanTotal });
  if (url.pathname === "/v1/refunds" && method === "GET") return json({ data: [] });
  if (url.pathname.startsWith("/v1/refunds/")) return json({ id: "re_e2e0001", status: "succeeded" });
  if (url.pathname === "/v1/refunds") return json({ id: "re_e2e0001", status: "succeeded" });
  if (url.pathname.startsWith("/v1/subscriptions/")) {
    // Stateful like Stripe: the cancellation sync reads the renewal state before changing it and reads it back after.
    const id = url.pathname.split("/")[3];
    if (method === "POST" && form.cancel_at_period_end !== undefined) cancelAtEnd[id] = form.cancel_at_period_end === "true";
    return json({ id, cancel_at_period_end: cancelAtEnd[id] ?? false, ...(method === "DELETE" ? { status: "canceled" } : { status: "active" }) });
  }
    if (url.pathname === "/v1/billing_portal/sessions") return json({ url: "https://billing.stripe.test/p/session/test_e2e" });
  return json({ error: { code: "unexpected_in_e2e", path: url.pathname } }, 500);
};

const worker = createWorker(fetch, fetch, {}, {}, { stripeFetch });
const CP_ORIGIN = "https://auth.murage.test";
const ADMIN = (env: Env) => ({ authorization: `Bearer ${(env as { CLOUD_ADMIN_TOKEN?: string }).CLOUD_ADMIN_TOKEN}`, "content-type": "application/json" });

async function e2eRoute(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (path === "/__e2e/outbox") return json(outbox);
  if (path === "/__e2e/stripe-calls") return json(stripeCalls);
  if (path === "/__e2e/consents") return json((await env.DB.prepare("SELECT * FROM checkout_consents ORDER BY created_at").all()).results as never);
  if (path === "/__e2e/topups") return json((await env.DB.prepare("SELECT * FROM topup_settings").all()).results as never);
  if (path === "/__e2e/withdrawals") return json((await env.DB.prepare("SELECT * FROM withdrawals").all()).results as never);
  if (path === "/__e2e/exports") return json((await env.DB.prepare("SELECT * FROM data_export_requests").all()).results as never);
  if (path === "/__e2e/acceptances") return json((await env.DB.prepare("SELECT * FROM terms_acceptances ORDER BY accepted_at").all()).results as never);
  // Simulates a later change of the Cloud terms for one customer: their accepted version is no longer the one in force.
  if (path === "/__e2e/age-terms") {
    const email = new URL(request.url).searchParams.get("email") ?? "";
    const r = await env.DB.prepare(`UPDATE terms_acceptances SET cloud_terms_version='cloud-terms-0ld0ld0ld0ld' WHERE user_id=(SELECT id FROM "user" WHERE email=?)`).bind(email).run();
    // ...and its 30-day notice has gone out (the prompt only follows a delivered notice).
    const now = Date.now();
    await env.DB.prepare(`INSERT OR IGNORE INTO terms_change_notices (user_id,cloud_terms_version,tos_version,privacy_version,home_id,notified_at,effective_at)
      SELECT u.id,?,?,?,(SELECT id FROM cloud_homes WHERE owner_id=u.id ORDER BY created_at DESC LIMIT 1),?,? FROM "user" u WHERE u.email=?`)
      .bind(LEGAL_DOCS.cloudTerms.versionId, LEGAL_DOCS.termsOfService.versionId, LEGAL_DOCS.privacyPolicy.versionId, now, now + 30 * 86_400_000, email).run();
    return json({ changed: r.meta.changes });
  }
  if (path === "/__e2e/reconcile") {
    const r = await worker.fetch(new Request(`${CP_ORIGIN}/v1/fake-b3/reconcile`, { method: "POST", headers: { ...ADMIN(env), "CF-Connecting-IP": "203.0.113.9" }, body: "{}" }), env, ctx);
    return json({ status: r.status });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const incoming = new URL(request.url);
    if (incoming.pathname.startsWith("/__e2e/")) return e2eRoute(request, env, ctx, incoming.pathname);
    const headers = new Headers(request.headers);
    if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", "203.0.113.10");
    const forwarded = new Request(`${CP_ORIGIN}${incoming.pathname}${incoming.search}`, { method: request.method, headers, body: request.body, redirect: "manual" });
    const stubbed = { ...env, EMAIL: { async send(message: { to: string; subject: string; text: string }) { outbox.push({ to: message.to, subject: message.subject, text: message.text }); } } } as unknown as Env;
    return worker.fetch(forwarded, stubbed, ctx);
  },
  scheduled: worker.scheduled,
} satisfies ExportedHandler<Env>;
