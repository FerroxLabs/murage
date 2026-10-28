// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls: the live free/busy read (BOT-CALLS-109 4.4, BOT-CALLS-109-FREEBUSY rev 1) against a fake broker: free, busy,
// every unsure cause, none, the exact payload and scope, and the F28 slug scan.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createCalendarCheck, CALENDAR_SCOPE_PREFIX, MULTI_EXECUTE_TOOL, type CalendarCheckDeps, type CalendarRelayReply } from "./bot-calls-calendar.ts";
import { CALENDAR_SLUG } from "./bot-calls-policy.ts";
import type { InventoryRead } from "./connected-inventory.ts";

const T0 = 1_800_000_000_000;
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const cal = (o: Partial<{ connected: boolean; pending: boolean; needsReconnect: boolean; accounts: Array<{ id: string; status: string }> }> = {}) => ({
  connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE" }], ...o,
});
const liveRead = (services: InventoryRead["services"], at = T0): InventoryRead => ({ services, at, revalidating: false });
const busyAt = (start: number, end: number) => ({ calendars: { primary: { busy: [{ start: new Date(start).toISOString(), end: new Date(end).toISOString() }] } } });
const FREE = { calendars: { primary: { busy: [] } } };
/** A broker multi-execute reply carrying `data` for the free/busy row, as the relay hands it back. */
function reply(id: string, data: unknown, o: { slug?: string; rows?: number; sse?: boolean; status?: number; structured?: boolean; failed?: boolean } = {}): CalendarRelayReply {
  const row = { tool_slug: o.slug ?? CALENDAR_SLUG, response: { successful: !o.failed, data } };
  const top = { successful: true, data: { results: Array.from({ length: o.rows ?? 1 }, () => row) } };
  const result = o.structured ? { structuredContent: top } : { content: [{ type: "text", text: JSON.stringify(top) }] };
  const frame = { jsonrpc: "2.0", id, result };
  return { status: o.status ?? 200, bytes: enc(o.sse ? `event: message\ndata: ${JSON.stringify(frame)}\n\n` : frame) };
}

function deps(o: {
  mode?: "managed" | "unavailable"; read?: InventoryRead | (() => Promise<InventoryRead>);
  answer?: (id: string, account: string) => CalendarRelayReply | Promise<CalendarRelayReply>; clock?: { t: number };
} = {}) {
  const calls: Array<{ payload: any; options: { botId: string; waitMs: number } }> = [];
  const inventoryOptions: unknown[] = [];
  const clock = o.clock ?? { t: T0 };
  const d: CalendarCheckDeps = {
    mode: () => o.mode ?? "managed",
    inventory: async (options) => { inventoryOptions.push(options); return typeof o.read === "function" ? o.read() : o.read ?? liveRead({ googlecalendar: cal() }); },
    relay: async (payload: any, options) => {
      calls.push({ payload, options });
      return (o.answer ?? ((id) => reply(id, FREE)))(payload.id, payload.params.arguments.tools[0].account);
    },
    now: () => clock.t,
  };
  return { d, calls, inventoryOptions };
}
const ask = (d: CalendarCheckDeps, signal = new AbortController().signal) => createCalendarCheck(d)("scout", signal);

describe("bot calls free/busy read", () => {
  it("free: one live read, one free/busy query with the exact payload, in the botcall scope", async () => {
    const { d, calls, inventoryOptions } = deps();
    expect(await ask(d)).toBe("free");
    expect(inventoryOptions).toEqual([{ force: true, waitMs: 3_000 }]);
    expect(calls).toHaveLength(1);
    const { payload, options } = calls[0];
    expect(options.botId).toBe(`${CALENDAR_SCOPE_PREFIX}scout`);
    expect(options.botId).not.toBe("scout");
    expect(Object.keys(options).sort()).toEqual(["botId", "waitMs"]);
    expect(payload.method).toBe("tools/call");
    expect(payload.params.name).toBe(MULTI_EXECUTE_TOOL);
    expect(Object.keys(payload.params.arguments)).toEqual(["tools"]);
    const tools = payload.params.arguments.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_slug).toBe(CALENDAR_SLUG);
    expect(Object.keys(tools[0].arguments).sort()).toEqual(["items", "timeMax", "timeMin", "timeZone"]);
    expect(tools[0].arguments).toEqual({ timeMin: new Date(T0).toISOString(), timeMax: new Date(T0 + 300_000).toISOString(), timeZone: "UTC", items: [{ id: "primary" }] });
  });

  it("busy on an overlapping interval, over JSON, SSE, structuredContent and response_data", async () => {
    const busy = busyAt(T0 + 60_000, T0 + 120_000);
    for (const shape of [{}, { sse: true }, { structured: true }]) {
      expect(await ask(deps({ answer: (id) => reply(id, busy, shape) }).d)).toBe("busy");
    }
    expect(await ask(deps({ answer: (id) => reply(id, { response_data: busy }) }).d)).toBe("busy");
    expect(await ask(deps({ answer: (id) => reply(id, busyAt(T0 - 120_000, T0 - 60_000)) }).d)).toBe("free");
  });

  it("two accounts: busy on either is busy; one unsure and one free is unsure", async () => {
    const two = liveRead({ googlecalendar: cal({ accounts: [{ id: "a", status: "ACTIVE" }, { id: "b", status: "ACTIVE" }] }) });
    expect(await ask(deps({ read: two, answer: (id, acc) => reply(id, acc === "b" ? busyAt(T0, T0 + 60_000) : FREE) }).d)).toBe("busy");
    expect(await ask(deps({ read: two, answer: (id, acc) => acc === "b" ? { status: 500, bytes: enc("") } : reply(id, FREE) }).d)).toBe("unsure");
    const { d, calls } = deps({ read: two });
    expect(await ask(d)).toBe("free");
    expect(calls.map((c) => c.payload.params.arguments.tools[0].account).sort()).toEqual(["a", "b"]);
  });

  it("none only on this decision's own live list without googlecalendar", async () => {
    const { d, calls } = deps({ read: liveRead({ gmail: cal() }) });
    expect(await ask(d)).toBe("none");
    expect(calls).toHaveLength(0);
    expect(await ask(deps({ read: liveRead({ googlecalendar: cal({ connected: false, accounts: [] }) }) }).d)).toBe("none");
  });

  it("unsure for every inventory state that is not live and clean (F26, F47)", async () => {
    const cases: Array<Parameters<typeof deps>[0]> = [
      { mode: "unavailable" },
      { read: () => Promise.reject(new Error("broker down")) },
      { read: liveRead({ googlecalendar: cal() }, T0 - 1) },                   // a remembered snapshot
      { read: { services: { googlecalendar: cal() }, at: T0, revalidating: true } },
      { read: { services: null, at: null, revalidating: true } },
      { read: liveRead({ googlecalendar: cal({ pending: true }) }) },
      { read: liveRead({ googlecalendar: cal({ needsReconnect: true }) }) },
      { read: liveRead({ googlecalendar: cal({ accounts: [{ id: "x", status: "EXPIRED" }] }) }) },
      { read: liveRead({ googlecalendar: cal({ connected: false }) }) },
      { read: liveRead({ googlecalendar: cal({ accounts: ["a", "b", "c", "d"].map((id) => ({ id, status: "ACTIVE" })) }) }) },
    ];
    for (const c of cases) {
      const { d, calls } = deps(c);
      expect(await ask(d)).toBe("unsure");
      expect(calls).toHaveLength(0);
    }
  });

  it("unsure for every reply that is not a clean free/busy answer", async () => {
    const answers: Array<(id: string) => CalendarRelayReply | Promise<CalendarRelayReply>> = [
      (id) => reply(id, FREE, { status: 401 }),
      (id) => reply(id, FREE, { status: 403 }),
      (id) => reply(id, FREE, { status: 500 }),
      () => Promise.reject(new Error("socket")),
      (id) => ({ status: 200, bytes: enc({ jsonrpc: "2.0", id, error: { code: -1, message: "no" } }) }),
      (id) => ({ status: 200, bytes: enc({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "{}" }] } }) }),
      (id) => ({ status: 200, bytes: enc({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Still running. Handle op_1." }] } }) }),
      () => reply("another-id", FREE),
      (id) => reply(id, FREE, { slug: "GOOGLECALENDAR_EVENTS_LIST" }),
      (id) => reply(id, FREE, { rows: 2 }),
      (id) => reply(id, FREE, { failed: true }),
      (id) => reply(id, { errors: [{ reason: "x" }], calendars: { primary: { busy: [] } } }),
      (id) => reply(id, { calendars: { other: { busy: [] } } }),
      (id) => reply(id, { calendars: { primary: { errors: [{ reason: "notFound" }], busy: [] } } }),
      (id) => reply(id, { truncated: true, calendars: { primary: { busy: [] } } }),
      (id) => reply(id, { calendars: { primary: { busy: [{ start: "soon", end: "later" }] } } }),
      () => ({ status: 200, bytes: enc("not json") }),
      (id) => reply(id, { calendars: { primary: { busy: [{ start: new Date(T0 + 300_000).toISOString(), end: new Date(T0).toISOString() }] } } }),
      (id) => reply(id, { calendars: { primary: { busy: [{ start: T0, end: T0 + 1 }] } } }),
      (id) => reply(id, { calendars: { primary: { busy: [null] } } }),
      (id) => ({ status: 200, bytes: enc({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ successful: false, data: { results: [{ tool_slug: CALENDAR_SLUG, response: { data: FREE } }] } }) }] } }) }),
      (id) => ({ status: 200, bytes: enc({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: CALENDAR_SLUG, response: { error: "insufficient scope", data: FREE } }] } }) }] } }) }),
    ];
    for (const answer of answers) expect(await ask(deps({ answer }).d)).toBe("unsure");
  });

  it("an abort or a spent budget is unsure, whatever arrives later", async () => {
    const before = new AbortController(); before.abort();
    const { d, calls } = deps();
    expect(await ask(d, before.signal)).toBe("unsure");
    expect(calls).toHaveLength(0);
    const during = new AbortController();
    expect(await ask(deps({ answer: (id) => { during.abort(); return reply(id, FREE); } }).d, during.signal)).toBe("unsure");
    const clock = { t: T0 };
    expect(await ask(deps({ clock, read: async () => { clock.t += 5_000; return liveRead({ googlecalendar: cal() }, T0); } }).d)).toBe("unsure");
  });

  it("returns only the answer enum and logs no reply content", async () => {
    const warned: unknown[] = [];
    const secret = "Board meeting with Dana at 5 Main St";
    const { d } = deps({ answer: () => Promise.reject(new Error(secret)) });
    d.warn = (step, error) => warned.push(step, error instanceof Error ? error.name : "error");
    const answer = await ask(d);
    expect(answer).toBe("unsure");
    expect(JSON.stringify(warned)).not.toContain("Dana");
  });

  it("F28: bot calls name no googlecalendar slug but free/busy, and index.ts wires the live read", () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir).filter((f) => /^bot-calls.*\.ts$/.test(f) && !f.endsWith(".test.ts"));
    expect(files).toContain("bot-calls-calendar.ts");
    for (const f of files) {
      const slugs = readFileSync(join(dir, f), "utf8").match(/GOOGLECALENDAR_[A-Z_]+/g) ?? [];
      for (const slug of slugs) expect(`${f}: ${slug}`).toBe(`${f}: ${CALENDAR_SLUG}`);
    }
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    expect(index).toMatch(/calendar: createCalendarCheck\(\{/);
    expect(index).not.toMatch(/calendar: async \(\) => "unsure"/);
  });
});
