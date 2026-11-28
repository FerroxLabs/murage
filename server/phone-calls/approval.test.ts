// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 rows P16, P16b, P16c (F3) and the C0 review's trusted Ask preview: the Ask card, request identity and one call per request.
// The card is read through phoneAskLine with the preview bound to the real service by the recorded turn (phoneAskContext), and
// tool calls go through servePhoneTool, so intent comes from the owner-message turn record, never from tool input.
import { afterEach, expect, it } from "vitest";
import { phoneAskLine, setPhoneAskPreview } from "../drivers/phone-tool-schemas.ts";
import type { PhoneAskTurn } from "./contracts.ts";
import { servePhoneTool } from "./admission.ts";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { forgetAllPhoneTurns, phoneAskContext, recordPhoneTurn } from "./phone-turns.ts";
import { PhoneCallService, trustedAskPreview } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import type { FetchLike } from "./vapi-adapter.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

afterEach(() => {
  _resetPhoneSecretsForTest();
  forgetAllPhoneTurns();
  setPhoneAskPreview(null);
});

const BISTRO = "+12025550101";
const ALLOW = { botMayPhone: () => true };
const BOOK = { purpose: "book", to: BISTRO, goal: "Book a table for four at Corner Bistro", details: "Name: Sam", limits: "No deposit", when: "2026-12-04T18:00:00Z" };
type Vendor = Awaited<ReturnType<typeof startFakeVapi>>;

async function setup(vendor: Vendor, fetchImpl: FetchLike = vendor.fetchImpl) {
  setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
  const rows = new MemoryCallStore();
  const service = new PhoneCallService(new VapiAdapter(fetchImpl), new RevisionStore(), () => "en", () => {}, rows);
  await service.saveSettings(defaultSettings("number-1", "Sam"));
  setPhoneAskPreview((args, turn) => trustedAskPreview(() => service, ALLOW, args, turn));
  return { service, rows };
}

const creates = (vendor: Vendor) => vendor.requests.filter(r => r.method === "POST" && r.path === "/call").length;

/** An admitted owner-message turn: the phone mount's record for (bot, thread, generation) with the owner message as intent. */
function turn(botId: string, threadId: string, generation: string, intent: string): PhoneAskTurn {
  recordPhoneTurn(generation, { botId, threadId, intent });
  return { botId, threadId, dispatchGeneration: generation };
}

function tool(service: PhoneCallService, t: PhoneAskTurn, body: Record<string, unknown>, name: "phone_call_place" | "phone_call_result" = "phone_call_place") {
  return servePhoneTool(() => service, name, { botId: t.botId, threadId: t.threadId, generation: t.dispatchGeneration }, body, { botMayPhone: () => true });
}

it("P16 the Ask card shows the plan as approved, and changed arguments make a new card", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service } = await setup(vendor);
    const t = turn("fixture-bot-a", "fixture-thread-a", "fixture-gen-1", "fixture-message-1");
    const card = phoneAskLine("phone_call_place", BOOK, t)!;
    for (const part of [BISTRO, BOOK.goal, BOOK.details, BOOK.limits, BOOK.when, "Language: en", "Max length: 5 min"]) expect(card).toContain(part);
    const changed = phoneAskLine("phone_call_place", { ...BOOK, limits: "Deposit up to 20" }, t)!;
    expect(changed).not.toBe(card);
    expect(await tool(service, t, BOOK)).toMatchObject({ purpose: "book", status: "scheduled" });
    const body = vendor.requests.find(r => r.method === "POST" && r.path === "/call")!.body as Record<string, any>;
    expect(body.customer.number).toBe(BISTRO);
    expect(body.assistantOverrides.variableValues).toMatchObject({ goal: BOOK.goal, details: BOOK.details, limits: BOOK.limits, language: "en" });
    expect(creates(vendor)).toBe(1);
  } finally { await vendor.close(); }
});

it("trusted Ask preview: no card without a recorded turn or for another generation; a valid repeat shows the same-request card", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service } = await setup(vendor);
    expect(trustedAskPreview(() => service, ALLOW, BOOK)).toBeNull();
    expect(phoneAskLine("phone_call_place", BOOK)).toBeNull();
    const t = turn("fixture-bot-a", "fixture-thread-a", "fixture-gen-1", "fixture-message-1");
    expect(phoneAskLine("phone_call_place", BOOK, { ...t, dispatchGeneration: "fixture-gen-forged" })).toBeNull();
    expect(phoneAskLine("phone_call_place", BOOK, { ...t, botId: "fixture-bot-b" })).toBeNull();
    expect(trustedAskPreview(() => service, { botMayPhone: () => false }, BOOK, t)).toBeNull();
    const first = phoneAskLine("phone_call_place", BOOK, t)!;
    expect(first).toContain(`Call ${BISTRO}`);
    expect(first).not.toContain("same request");
    const placed = await tool(service, t, BOOK);
    expect(creates(vendor)).toBe(1);
    expect(service.askPreview(BOOK, phoneAskContext(t))).toMatchObject({ sameRequest: true });
    expect(phoneAskLine("phone_call_place", BOOK, t)).toContain("This is the same request as a call already made in this chat.");
    // Approving the repeat returns the stored call and makes no create.
    expect(await tool(service, t, BOOK)).toMatchObject({ call: placed.call });
    expect(creates(vendor)).toBe(1);
  } finally { await vendor.close(); }
});

it("P16b purpose and booking are part of the request identity", async () => {
  // Discovery fails, so an uncertain row stays uncertain and the comparison alone decides the answer.
  const vendor = await startFakeVapi({ beforeBody: ({ method, path }) => (method === "GET" && path === "/call" ? 500 : undefined) });
  try {
    const { service, rows } = await setup(vendor);
    const bot = "fixture-bot-a";
    const base = { revision: 1, assistantId: "assistant-1", createdAt: 1, language: "en", to: BISTRO, limits: "", botId: bot };
    const same = { to: BISTRO, goal: "Sort out Friday at Corner Bistro", details: "Name: Sam" };
    const booking = `call_${"a".repeat(24)}`;
    rows.put({ ...base, id: booking, vendorId: "vendor-booking", status: "ended", goal: "Book a table", details: "", purpose: "book",
      structured: { outcome: "done", reference: "REF-1" }, reference: "REF-1" });
    // (i) an uncertain ask, then a book with the same fields.
    rows.put({ ...base, ...same, id: `call_${"b".repeat(24)}`, vendorId: "vendor-ask", status: "uncertain", purpose: "ask" });
    expect(await service.place({ ...same, purpose: "book" }, { botId: bot })).toEqual({ ok: false, error: "not_confirmed" });
    rows.put({ ...rows.get(`call_${"b".repeat(24)}`)!, status: "ended" });
    // (ii) an uncertain book, then a cancel with the same to/goal/details.
    rows.put({ ...base, ...same, id: `call_${"c".repeat(24)}`, vendorId: "vendor-book", status: "uncertain", purpose: "book" });
    expect(await service.place({ ...same, purpose: "cancel", booking }, { botId: bot })).toEqual({ ok: false, error: "not_confirmed" });
    expect(creates(vendor)).toBe(0);
    const t = turn(bot, "fixture-thread-a", "fixture-gen-1", "fixture-message-1");
    expect(service.askPreview({ ...same, purpose: "cancel", booking }, phoneAskContext(t)))
      .toMatchObject({ purpose: "cancel", booking, to: BISTRO, cancelOf: { business: "Book a table", to: BISTRO } });
    expect(phoneAskLine("phone_call_place", { ...same, purpose: "cancel", booking }, t)).toContain("Cancel your booking at Book a table");
  } finally { await vendor.close(); }
});

it("P16c one request, one call, in every state", async () => {
  let lose = false;
  const vendor = await startFakeVapi();
  const lossy: FetchLike = async (url, init) => {
    const answer = await vendor.fetchImpl(url, init);
    if (lose && init.method === "POST" && new URL(url).pathname === "/call") throw new Error("response lost");
    return answer;
  };
  try {
    const { service } = await setup(vendor, lossy);
    const a1 = turn("fixture-bot-a", "fixture-thread-a", "fixture-gen-1", "fixture-message-1");
    const first = await tool(service, a1, BOOK);
    expect(first).toMatchObject({ status: "scheduled" });
    // A repeats while scheduled, twice in one tick.
    const repeats = await Promise.all([tool(service, a1, BOOK), tool(service, a1, BOOK)]);
    expect(repeats.map(r => r.call)).toEqual([first.call, first.call]);
    expect(creates(vendor)).toBe(1);
    // Another bot's identical request is its own call.
    const b1 = turn("fixture-bot-b", "fixture-thread-b", "fixture-gen-b", "fixture-message-b");
    const other = await tool(service, b1, BOOK);
    expect(other.call).not.toBe(first.call);
    expect(creates(vendor)).toBe(2);
    // A new owner message from A with the identical request, while A's call is still live, gets that call.
    const a1b = turn("fixture-bot-a", "fixture-thread-a", "fixture-gen-1b", "fixture-message-1b");
    expect(await tool(service, a1b, BOOK)).toMatchObject({ call: first.call });
    expect(creates(vendor)).toBe(2);

    // Lost response: a new owner message on A's thread; the vendor creates the call but the answer never arrives.
    const lostRequest = { ...BOOK, goal: "Book a table for six at Corner Bistro", when: undefined };
    const a2 = turn("fixture-bot-a", "fixture-thread-a", "fixture-gen-2", "fixture-message-2");
    lose = true;
    expect(await tool(service, a2, lostRequest)).toEqual({ error: "vendor_unreachable" });
    lose = false;
    expect(creates(vendor)).toBe(3);
    await service.refreshOwnerCalls(); // discovery by operation id adopts the call
    const adopted = service.recentOwnerCards().find(c => c.goal === lostRequest.goal)!;
    const vendorCall = [...vendor.calls.values()].find(c => c.name === adopted.id)!;
    vendor.calls.set(vendorCall.id, { ...vendorCall, status: "ended", endedReason: "customer-ended-call",
      analysis: { structuredData: { outcome: "done", reference: "REF-2", time: "2026-12-04T19:00:00Z" } } });
    await service.refreshOwnerCalls();
    expect(service.ownerCard(adopted.id)).toMatchObject({ status: "ended", outcome: "done" });
    // The engine repeats in the same turn, then the same owner message is re-run under a new generation.
    expect(await tool(service, a2, lostRequest)).toMatchObject({ call: adopted.id, outcome: "done" });
    const a3 = turn("fixture-bot-a", "fixture-thread-a", "fixture-gen-3", "fixture-message-2");
    expect(await tool(service, a3, lostRequest)).toMatchObject({ call: adopted.id, outcome: "done" });
    expect(creates(vendor)).toBe(3);
    // Ask mode: the repeat card says it is the same request.
    expect(phoneAskLine("phone_call_place", lostRequest, a3)).toContain("This is the same request as a call already made in this chat.");
    // A new owner message (in another chat of the same bot) may place the identical request again once the first has ended.
    const a2b = turn("fixture-bot-a", "fixture-thread-a2", "fixture-gen-2b", "fixture-message-2b");
    const fresh = await tool(service, a2b, lostRequest);
    expect(fresh.call).not.toBe(adopted.id);
    expect(creates(vendor)).toBe(4);
    const freshVendor = [...vendor.calls.values()].find(c => c.name === fresh.call)!;
    vendor.calls.set(freshVendor.id, { ...freshVendor, status: "ended", endedReason: "customer-ended-call", analysis: { structuredData: { outcome: "busy" } } });
    expect(await tool(service, a2b, { call: fresh.call }, "phone_call_result")).toMatchObject({ status: "ended", outcome: "busy" });
    // The owner deletes the row: the intent's turn records are revoked, so the repeat makes no request at all.
    expect(service.deleteCall(adopted.id)).toEqual({ ok: true });
    const requests = vendor.requests.length;
    expect(await tool(service, a3, lostRequest)).toMatchObject({ error: "not_set_up" });
    expect(vendor.requests.length).toBe(requests);
    // Only a new owner message places the identical request again.
    const a4 = turn("fixture-bot-a", "fixture-thread-a", "fixture-gen-4", "fixture-message-3");
    const again = await tool(service, a4, lostRequest);
    expect(again.call).toEqual(expect.stringMatching(/^call_[0-9a-f]{24}$/));
    expect(again.call).not.toBe(adopted.id);
    expect(again.call).not.toBe(fresh.call);
    expect(creates(vendor)).toBe(5);
  } finally { await vendor.close(); }
});
