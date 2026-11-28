// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 rows P10-P13 (F3): book and cancel as real goals on the owner's own Vapi account. Loopback vendor, real adapter.
import { afterEach, expect, it, vi } from "vitest";
import { ANALYSIS_GRACE_MS, type CallRow } from "./contracts.ts";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { isFinal, PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

const BISTRO = "+12025550101";
const SENTINEL = "REF-SENTINEL-7Q";
const TIME = "2026-12-05T19:00:00Z";
const BOT_A = "fixture-bot-a";
const BOT_B = "fixture-bot-b";

type Vendor = Awaited<ReturnType<typeof startFakeVapi>>;

async function setup(vendor: Vendor) {
  setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
  const rows = new MemoryCallStore();
  const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", () => {}, rows);
  await service.saveSettings(defaultSettings("number-1", "Sam"));
  return { service, rows };
}

const creates = (vendor: Vendor) => vendor.requests.filter(r => r.method === "POST" && r.path === "/call");

function endAt(vendor: Vendor, vendorId: string, structuredData: Record<string, unknown>) {
  const call = vendor.calls.get(vendorId)!;
  vendor.calls.set(vendorId, { ...call, status: "ended", endedReason: "customer-ended-call", analysis: { structuredData } });
}

/** A real booking: placed by bot A, ended `done` with the sentinel reference and a time. */
async function booked(vendor: Vendor, service: PhoneCallService) {
  const placed = await service.place({ purpose: "book", to: BISTRO, goal: "Book a table for four on Friday at 7" }, { botId: BOT_A });
  expect(placed.ok).toBe(true);
  const id = String(placed.ok && placed.value.call);
  endAt(vendor, service._row(id)!.vendorId, { outcome: "done", reference: SENTINEL, time: TIME });
  const read = await service.result({ call: id });
  return { id, read };
}

/** A stored row that passes every booking check, so one changed field isolates one check. */
function bookingRow(over: Partial<CallRow> = {}): CallRow {
  return {
    id: `call_${"a".repeat(24)}`, vendorId: "vendor-fixture", revision: 1, assistantId: "assistant-1", createdAt: 1, status: "ended",
    language: "en", to: BISTRO, goal: "Book a table", details: "", limits: "", purpose: "book", botId: BOT_A,
    structured: { outcome: "done", reference: SENTINEL }, reference: SENTINEL, ...over,
  };
}

it("P10 a booking is stored for the owner and hidden from the engine", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service } = await setup(vendor);
    const { id, read } = await booked(vendor, service);
    expect(read).toMatchObject({ ok: true, value: { call: id, purpose: "book", has_reference: true, time: TIME, outcome: "done" } });
    expect(JSON.stringify(read)).not.toContain(SENTINEL);
    expect(service.ownerCard(id)).toMatchObject({ line: "phoneCalls.result.booked", time: TIME, reference: SENTINEL, bookingState: "booked" });
  } finally { await vendor.close(); }
});

it("P11 a cancel quotes the stored reference without the engine seeing it", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service } = await setup(vendor);
    const { id: booking } = await booked(vendor, service);
    const args = { purpose: "cancel", booking, goal: "Cancel my table on Friday" };
    const placed = await service.place(args, { botId: BOT_A });
    expect(placed.ok).toBe(true);
    expect(JSON.stringify([args, placed])).not.toContain(SENTINEL);
    const body = creates(vendor).at(-1)!.body as Record<string, any>;
    expect(body.customer.number).toBe(BISTRO);
    expect(body.assistantOverrides.variableValues.reference).toBe(SENTINEL);
    const cancel = String(placed.ok && placed.value.call);
    expect(service.ownerCard(booking)?.bookingState).toBe("cancelling");
    endAt(vendor, service._row(cancel)!.vendorId, { outcome: "done" });
    const read = await service.result({ call: cancel });
    expect(read).toMatchObject({ ok: true, value: { purpose: "cancel", booking, outcome: "done" } });
    expect(JSON.stringify(read)).not.toContain(SENTINEL);
    expect(service.ownerCard(cancel)?.line).toBe("phoneCalls.result.cancelled");
    expect(service.ownerCard(booking)?.bookingState).toBe("cancelled");
  } finally { await vendor.close(); }
});

it("P12 a cancel needs a real booking", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service, rows } = await setup(vendor);
    const cases: [string, CallRow | undefined, string][] = [
      ["unknown id", undefined, `call_${"b".repeat(24)}`],
      ["ask call", bookingRow({ id: `call_${"c".repeat(24)}`, purpose: "ask" }), `call_${"c".repeat(24)}`],
      ["scheduled book", bookingRow({ id: `call_${"d".repeat(24)}`, status: "scheduled" }), `call_${"d".repeat(24)}`],
      ["not_done book", bookingRow({ id: `call_${"e".repeat(24)}`, structured: { outcome: "not_done", reference: SENTINEL } }), `call_${"e".repeat(24)}`],
      ["cancelled book", bookingRow({ id: `call_${"f".repeat(24)}`, cancel: { by: `call_${"0".repeat(24)}`, state: "cancelled" } }), `call_${"f".repeat(24)}`],
      ["malformed id", undefined, "call_not-a-real-id"],
    ];
    for (const [, row] of cases) if (row) rows.put(row);
    const before = vendor.requests.length;
    for (const [name, , booking] of cases) {
      expect([name, await service.place({ purpose: "cancel", booking, goal: "Cancel my table" }, { botId: BOT_A })])
        .toEqual([name, { ok: false, error: "no_such_booking" }]);
    }
    expect(vendor.requests.length).toBe(before);
  } finally { await vendor.close(); }
});

it("P12b a bot cannot cancel another bot's booking", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service, rows } = await setup(vendor);
    const row = bookingRow();
    rows.put(row);
    expect(await service.place({ purpose: "cancel", booking: row.id, goal: "Cancel my table" }, { botId: BOT_B }))
      .toEqual({ ok: false, error: "no_such_booking" });
    expect(creates(vendor)).toHaveLength(0);
    expect(await service.place({ purpose: "cancel", booking: row.id, goal: "Cancel my table" }, { botId: BOT_A }))
      .toMatchObject({ ok: true });
    expect(creates(vendor)).toHaveLength(1);
  } finally { await vendor.close(); }
});

it("P12c a cancel cannot be redirected to another number", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service, rows } = await setup(vendor);
    const row = bookingRow();
    rows.put(row);
    expect(await service.place({ purpose: "cancel", booking: row.id, to: "+12025550199", goal: "Cancel my table" }, { botId: BOT_A }))
      .toEqual({ ok: false, error: "no_such_booking" });
    expect(creates(vendor)).toHaveLength(0);
    expect(JSON.stringify(vendor.requests.map(r => r.body ?? null))).not.toContain(SENTINEL);
  } finally { await vendor.close(); }
});

it("P12f two cancels of one booking in one tick make one create", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service, rows } = await setup(vendor);
    const row = bookingRow();
    rows.put(row);
    const answers = await Promise.all([
      service.place({ purpose: "cancel", booking: row.id, goal: "Cancel my table" }, { botId: BOT_A }),
      service.place({ purpose: "cancel", booking: row.id, goal: "Cancel the booking for Friday" }, { botId: BOT_A }),
    ]);
    expect(creates(vendor)).toHaveLength(1);
    expect(answers.filter(a => a.ok)).toHaveLength(1);
    expect(answers.filter(a => !a.ok).map(a => !a.ok && a.error)).toEqual([expect.stringMatching(/^(no_such_booking|not_confirmed)$/)]);
  } finally { await vendor.close(); }
});

it("P13 the result enum is closed", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service } = await setup(vendor);
    const placed = await service.place({ purpose: "book", to: BISTRO, goal: "Book a table for two" }, { botId: BOT_A });
    const id = String(placed.ok && placed.value.call);
    endAt(vendor, service._row(id)!.vendorId, { outcome: "maybe_later", reason: "they said call back after the holidays", time: "9".repeat(3000) });
    const read = await service.result({ call: id });
    expect(read.ok).toBe(true);
    const value = read.ok ? read.value : {};
    expect(value).not.toHaveProperty("outcome");
    expect(value).not.toHaveProperty("reason");
    expect(value).not.toHaveProperty("time");
    expect(service.ownerCard(id)?.line).toBe("phoneCalls.result.unclear");
  } finally { await vendor.close(); }
});

afterEach(() => vi.restoreAllMocks());

/** P10's booking, then a cancel of it whose first ended read carries no analysis. */
async function lateCancel(vendor: Vendor, service: PhoneCallService) {
  const { id: booking } = await booked(vendor, service);
  const placed = await service.place({ purpose: "cancel", booking, goal: "Cancel my table on Friday" }, { botId: BOT_A });
  const cancel = String(placed.ok && placed.value.call);
  const vendorId = service._row(cancel)!.vendorId;
  vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, status: "ended", endedReason: "customer-ended-call" });
  await service.result({ call: cancel });
  expect(service._row(cancel)!.status).toBe("ended");
  return { booking, cancel, vendorId };
}

const atClock = (offset: number) => { const real = Date.now.bind(Date); vi.spyOn(Date, "now").mockImplementation(() => real() + offset); };

it("P12h (i)(ii) a cancel whose analysis is late never frees the booking, and a late done settles it", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service } = await setup(vendor);
    const { booking, cancel, vendorId } = await lateCancel(vendor, service);
    // isFinal is the net-new settled-call predicate (absent before this lane): the late-done settlement below already held on base.
    expect(typeof isFinal).toBe("function");
    expect(isFinal(service._row(cancel)!)).toBe(false);
    const before = creates(vendor).length;
    expect(await service.place({ purpose: "cancel", booking, goal: "Cancel my table" }, { botId: BOT_A })).toEqual({ ok: false, error: "no_such_booking" });
    expect(creates(vendor)).toHaveLength(before);
    expect(service.ownerCard(booking)?.bookingState).toBe("cancelling");
    endAt(vendor, vendorId, { outcome: "done" });
    await service.refreshOwnerCalls();
    expect(service._row(booking)!.cancel).toEqual({ by: cancel, state: "cancelled" });
    expect(service.ownerCard(booking)?.bookingState).toBe("cancelled");
    expect(isFinal(service._row(cancel)!)).toBe(true);
  } finally { await vendor.close(); }
});

it("P12h (iii)(iv) no analysis by the grace, or an unlisted outcome, settles unclear and the booking stays taken", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service } = await setup(vendor);
    const late = await lateCancel(vendor, service);
    atClock(ANALYSIS_GRACE_MS + 1000);
    await service.refreshOwnerCalls();
    expect(service._row(late.booking)!.cancel?.state).toBe("unclear");
    expect(service.ownerCard(late.booking)?.bookingState).toBe("unclear");
    expect(isFinal(service._row(late.cancel)!)).toBe(true);
    const before = creates(vendor).length;
    expect(await service.place({ purpose: "cancel", booking: late.booking, goal: "Cancel my table" }, { botId: BOT_A })).toEqual({ ok: false, error: "no_such_booking" });
    expect(creates(vendor)).toHaveLength(before);
    vi.restoreAllMocks();
    const odd = await lateCancel(vendor, service);
    endAt(vendor, odd.vendorId, { outcome: "rescheduled" });
    await service.result({ call: odd.cancel });
    expect(service._row(odd.booking)!.cancel?.state).toBe("unclear");
    // A late definite done upgrades unclear (I4; D6a refreshOne).
    endAt(vendor, odd.vendorId, { outcome: "done" });
    await service.refreshOne(odd.cancel);
    expect(service._row(odd.booking)!.cancel?.state).toBe("cancelled");
  } finally { await vendor.close(); }
});

it("P12h (v)(vi) the analysis deadline is durable and reaches calls outside the 50 shown", async () => {
  const vendor = await startFakeVapi();
  try {
    for (const lateDone of [false, true]) {
      const { service, rows } = await setup(vendor);
      const { booking, cancel, vendorId } = await lateCancel(vendor, service);
      expect(typeof rows.get(cancel)!.analysisDue).toBe("number");
      expect(rows.get(cancel)!.analysisDue!).toBeGreaterThan(Date.now());
      for (let i = 0; i < 60; i++) await service.place({ to: `+120255501${String(10 + i).padStart(2, "0")}`, goal: `Ask about item ${i}` }, { botId: `fixture-bot-${i}` });
      expect(rows.recent(50).map(r => r.id)).not.toContain(cancel);
      const restarted = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", () => {}, rows);
      if (lateDone) endAt(vendor, vendorId, { outcome: "done" });
      atClock(ANALYSIS_GRACE_MS + 1000);
      await restarted.refreshOwnerCalls();
      expect(rows.get(booking)!.cancel?.state).toBe(lateDone ? "cancelled" : "unclear");
      expect(rows.get(cancel)!.analysisDue).toBeUndefined();
      expect(restarted.ownerCard(booking)?.bookingState).toBe(lateDone ? "cancelled" : "unclear");
      vi.restoreAllMocks();
    }
  } finally { await vendor.close(); }
});

it("P17c (half) a cancel that reaches voicemail frees the booking and says it couldn't", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service } = await setup(vendor);
    const { booking, cancel, vendorId } = await lateCancel(vendor, service);
    endAt(vendor, vendorId, { outcome: "voicemail" });
    await service.result({ call: cancel });
    expect(service._row(booking)!.cancel).toEqual({ by: cancel, state: "free" });
    expect(service.ownerCard(cancel)?.line).toBe("phoneCalls.result.couldnt");
    expect(service.ownerCard(booking)?.bookingState).toBe("booked");
  } finally { await vendor.close(); }
});
