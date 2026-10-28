// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { InternalCapability } from "../internal-capabilities.ts";
import { PhoneAuthorities } from "./authority.ts";
import { PhoneRegistry, initializePhones } from "./registry.ts";
import { PHONE_COPY } from "./copy.ts";
import { offeredPhoneTools, phoneRpc, type PhoneRpcDeps } from "./rpc.ts";
import type { PhoneApps } from "../../shared/phone-apps.ts";

const fx = JSON.parse(readFileSync(new URL("../../apps/mobile/contract/phone-jobs.json", import.meta.url), "utf8"));
const DEVICE = "11111111-1111-4111-8111-111111111111";
const claim = (over: Partial<InternalCapability> = {}): InternalCapability => {
  const made: InternalCapability = { botId: "bot", threadId: "thread", generation: "gen", depth: 0, kind: "device", skillAuthoring: false, expiresAt: Date.now() + 60000, ...over };
  return Object.freeze(made);
};

interface Rig { deps: PhoneRpcDeps; marks: string[]; order: string[]; request: ReturnType<typeof vi.fn>; authorities: PhoneAuthorities; registry: PhoneRegistry; facts: { value: any }; grant: { value: PhoneApps } }
function rig(options: { grant?: PhoneApps; report?: Record<string, unknown>; outcome?: any } = {}): Rig {
  const db = new DatabaseSync(":memory:");
  initializePhones(db);
  const registry = new PhoneRegistry(db, () => 1000);
  expect(registry.put(DEVICE, { ...fx.registration.valid, capabilities: options.report ?? fx.registration.valid.capabilities }).ok).toBe(true);
  const authorities = new PhoneAuthorities();
  authorities.mint({ threadId: "thread", turnId: "turn", generation: "gen", origin: "desktop", botId: "bot" });
  const marks: string[] = []; const order: string[] = [];
  const request = vi.fn((input: any) => { order.push("request"); return { operationId: "op", outcome: Promise.resolve(options.outcome ?? { kind: "done", result: { events: [], truncated: false }, phoneName: input.phoneName }) }; });
  const facts = { value: { origin: "desktop" } as any };
  const grant = { value: options.grant ?? ({ calendar: "read" } as PhoneApps) };
  const deps: PhoneRpcDeps = {
    authorities, registry, copy: PHONE_COPY,
    dispatchFacts: () => facts.value, grant: () => grant.value, jobs: { request } as any,
    markThread: (id) => { marks.push(id); order.push("mark"); },
    identity: () => ({ botName: "Ember", workspace: "Home", provider: { id: "anthropic", name: "Anthropic" } }),
  };
  return { deps, marks, order, request, authorities, registry, facts, grant };
}
const READ = { tool: "phone_calendar_read" as const, args: { start: "2026-10-01T09:00:00Z", end: "2026-10-02T09:00:00Z" } };

describe("phoneRpc", () => {
  it("accepts a granted call: marks the thread, then opens one job with real names", async () => {
    const r = rig();
    const out = await phoneRpc(claim(), READ, r.deps);
    expect(out.ok).toBe(true);
    expect(r.order).toEqual(["mark", "request"]);
    expect(r.marks).toEqual(["thread"]);
    const input = r.request.mock.calls[0][0];
    expect(input).toMatchObject({ deviceId: DEVICE, capability: "calendar", action: "calendar.read", phoneName: fx.registration.valid.name, botName: "Ember", workspace: "Home", provider: { id: "anthropic", name: "Anthropic" } });
    expect(input.authority).toMatchObject({ generation: "gen", threadId: "thread", botId: "bot" });
  });

  it("puts the phone name last in the bot's result (plan 4.4)", async () => {
    const out = await phoneRpc(claim(), READ, rig().deps);
    expect(out.ok).toBe(true);
    const keys = Object.keys(JSON.parse(out.text));
    expect(keys[keys.length - 1]).toBe("phone");
    expect(keys[0]).toBe("result");
  });

  it("refuses a stale generation, an authority of another thread or bot, and a revoked authority; no mark, no job", async () => {
    const stale = rig();
    expect(await phoneRpc(claim({ generation: "old" }), READ, stale.deps)).toMatchObject({ ok: false, code: "refused" });
    const otherThread = rig();
    expect(await phoneRpc(claim({ threadId: "elsewhere" }), READ, otherThread.deps)).toMatchObject({ ok: false, code: "refused" });
    const otherBot = rig();
    expect(await phoneRpc(claim({ botId: "other" }), READ, otherBot.deps)).toMatchObject({ ok: false, code: "refused" });
    const revoked = rig();
    revoked.authorities.revokeGeneration("gen");
    expect(await phoneRpc(claim(), READ, revoked.deps)).toMatchObject({ ok: false, code: "refused" });
    for (const r of [stale, otherThread, otherBot, revoked]) { expect(r.marks).toEqual([]); expect(r.request).not.toHaveBeenCalled(); }
  });

  it("refuses when the dispatch has an automation source, unproven origin, no facts, or a malformed origin", async () => {
    for (const facts of [{ automationSource: { kind: "webhook" }, origin: "desktop" }, { origin: "unproven" }, null, {}, { origin: "other" }]) {
      const r = rig(); r.facts.value = facts;
      expect(await phoneRpc(claim(), READ, r.deps), JSON.stringify(facts)).toMatchObject({ ok: false, code: "refused" });
      expect(r.marks).toEqual([]); expect(r.request).not.toHaveBeenCalled();
    }
    const companion = rig(); companion.facts.value = { origin: "companion" };
    expect((await phoneRpc(claim(), READ, companion.deps)).ok).toBe(true);
  });

  it("refuses a tool outside the grant and a tool outside the phone's report", async () => {
    const noGrant = rig({ grant: {} });
    expect(await phoneRpc(claim(), READ, noGrant.deps)).toMatchObject({ ok: false, code: "refused" });
    const readOnly = rig({ grant: { calendar: "read" } });
    expect(await phoneRpc(claim(), { tool: "phone_calendar_add", args: { title: "x", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z" } }, readOnly.deps)).toMatchObject({ ok: false, code: "refused" });
    const notReported = rig({ grant: { calendar: "read", alarms: "set" }, report: { calendar: "full" } });
    expect(await phoneRpc(claim(), { tool: "phone_alarm_set", args: { hour: 7, minute: 0 } }, notReported.deps)).toMatchObject({ ok: false, code: "refused" });
    const writeOnly = rig({ grant: { calendar: "change" }, report: { calendar: "write-only" } });
    expect(await phoneRpc(claim(), READ, writeOnly.deps)).toMatchObject({ ok: false, code: "refused" });
    expect(await phoneRpc(claim(), { tool: "phone_nonsense" as never, args: {} }, rig().deps)).toMatchObject({ ok: false, code: "refused" });
    for (const r of [noGrant, readOnly, notReported, writeOnly]) { expect(r.marks).toEqual([]); expect(r.request).not.toHaveBeenCalled(); }
  });

  it("refuses a precise location ask when the grant or the report only allows approximate", async () => {
    const grantLow = rig({ grant: { location: "approximate" } });
    expect(await phoneRpc(claim(), { tool: "phone_location_get", args: { precision: "precise" } }, grantLow.deps)).toMatchObject({ ok: false, code: "refused" });
    const reportLow = rig({ grant: { location: "precise" }, report: { location: "approximate" } });
    expect(await phoneRpc(claim(), { tool: "phone_location_get", args: { precision: "precise" } }, reportLow.deps)).toMatchObject({ ok: false, code: "refused" });
    expect(grantLow.request).not.toHaveBeenCalled(); expect(reportLow.request).not.toHaveBeenCalled();
    const fine = rig({ grant: { location: "precise" } });
    expect((await phoneRpc(claim(), { tool: "phone_location_get", args: { precision: "precise" } }, fine.deps)).ok).toBe(true);
    expect((await phoneRpc(claim(), { tool: "phone_location_get", args: { precision: "approximate" } }, grantLow.deps)).ok).toBe(true);
  });

  it("answers invalid_args with no mark and no job when the arguments fail the action schema", async () => {
    for (const args of [{}, { start: "tomorrow", end: "later" }, { ...READ.args, extra: 1 }, null, "text"]) {
      const r = rig();
      const out = await phoneRpc(claim(), { tool: "phone_calendar_read", args }, r.deps);
      expect(out, JSON.stringify(args)).toMatchObject({ ok: false, code: "invalid_args", text: PHONE_COPY.invalidArgs });
      expect(r.marks).toEqual([]); expect(r.request).not.toHaveBeenCalled();
    }
  });

  it("marks the thread before the job even when the job fails, and carries the failure line", async () => {
    const r = rig({ outcome: { kind: "did_not_run", line: "The phone did not allow it; nothing ran." } });
    const out = await phoneRpc(claim(), READ, r.deps);
    expect(out).toMatchObject({ ok: false, text: "The phone did not allow it; nothing ran." });
    expect(r.order).toEqual(["mark", "request"]);
    const declined = rig({ outcome: { kind: "declined", line: "Not allowed on the phone this time." } });
    expect(await phoneRpc(claim(), READ, declined.deps)).toMatchObject({ ok: false, code: "declined" });
    const maybe = rig({ outcome: { kind: "may_have_run", line: "May have run on the phone; read it back before repeating." } });
    expect(await phoneRpc(claim(), READ, maybe.deps)).toMatchObject({ ok: false });
  });

  it("fails closed when a dependency throws", async () => {
    const r = rig();
    r.deps.grant = () => { throw new Error("boom"); };
    expect(await phoneRpc(claim(), READ, r.deps)).toMatchObject({ ok: false, code: "refused" });
    expect(r.request).not.toHaveBeenCalled();
  });

  it("offeredPhoneTools is the grant intersected with a registered phone, in catalog order", () => {
    const r = rig({ grant: { calendar: "read", contacts: "read" } });
    expect(offeredPhoneTools(r.grant.value, r.registry)).toEqual(["phone_calendar_read", "phone_calendar_find_free_time", "phone_contacts_search", "phone_contacts_get"]);
    expect(offeredPhoneTools({}, r.registry)).toEqual([]);
    const empty = rig({ grant: { calendar: "read" } });
    empty.registry.remove(DEVICE);
    expect(offeredPhoneTools({ calendar: "read" }, empty.registry)).toEqual([]);
  });
});
