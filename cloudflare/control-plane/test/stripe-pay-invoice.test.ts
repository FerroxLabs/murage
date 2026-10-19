// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra TAXCOUNTRY-8 (coordinator b): paying an invoice names the payment method the customer authorized (and its mandate where needed),
// never an empty body that lets Stripe pick a default method.
import { describe, expect, it } from "vitest";
import { stripeClient } from "../src/b5-stripe";

function capture() {
  const calls: { url: string; body: URLSearchParams; key: string | null }[] = [];
  const fetcher = async (input: Request | string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")), key: new Headers(init?.headers).get("idempotency-key") });
    return new Response(JSON.stringify({ id: "in_1", status: "paid" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, client: stripeClient({ secretKey: "sk_test_x", apiVersion: "2025-01-01" } as never, fetcher) };
}

describe("payInvoice", () => {
  it("sends the authorized payment method, off-session, and its mandate when the method has one", async () => {
    const { calls, client } = capture();
    await client.payInvoice("in_1", "pay:in_1", { paymentMethod: "pm_sepa", mandate: "mandate_1" });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/invoices/in_1/pay");
    expect(Object.fromEntries(calls[0].body)).toEqual({ payment_method: "pm_sepa", mandate: "mandate_1", off_session: "true" });
    expect(calls[0].key).toBe("pay:in_1");
  });
  it("names no mandate for a method that needs none (a card)", async () => {
    const { calls, client } = capture();
    await client.payInvoice("in_2", "pay:in_2", { paymentMethod: "pm_card", mandate: null });
    expect(Object.fromEntries(calls[0].body)).toEqual({ payment_method: "pm_card", off_session: "true" });
  });
});
