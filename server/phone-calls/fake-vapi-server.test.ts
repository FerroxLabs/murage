// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, expect, it } from "vitest";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { PhoneCallService } from "./service.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(open => { resolve = open; });
  return { promise, resolve };
}

it("holds the loopback create response after recording the call, then serves a bounded reconcile page", async () => {
  const beforeBody = barrier();
  const readBody = barrier();
  const created = barrier();
  const reply = barrier();
  const now = Date.parse("2026-11-20T09:00:00Z");
  const vendor = await startFakeVapi({
    now: () => now,
    beforeBody: async ({ method, path }) => {
      if (method === "POST" && path === "/call") {
        beforeBody.resolve();
        await readBody.promise;
      }
    },
    beforeReply: async ({ method, path }) => {
      if (method === "POST" && path === "/call") {
        created.resolve();
        await reply.promise;
      }
    },
    orderCalls: calls => calls.reverse(),
  });
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en");
    expect(await service.numbers()).toEqual({ numbers: [{ id: "number-1", number: "+12025550100", canCallOut: true }] });
    await service.saveSettings(defaultSettings("number-1", "Sam"));
    const placing = service.place({ to: "+12025550101", goal: "Ask about opening hours", when: "2026-12-01T10:00:00Z" });
    await beforeBody.promise;
    expect(vendor.creates).toBe(0);
    readBody.resolve();
    await created.promise;
    expect(vendor.creates).toBe(1);
    expect(vendor.calls.get("fixture-call-1")).toMatchObject({ name: expect.stringMatching(/^call_/), status: "scheduled" });

    vendor.calls.set("earlier", { id: "earlier", status: "ended", createdAt: new Date(now - 1).toISOString() });
    vendor.calls.set("tie", { id: "tie", status: "ended", createdAt: new Date(now).toISOString() });
    const endpoint = new URL("/call", PHONE_KEY_ORIGIN);
    endpoint.searchParams.set("createdAtGe", new Date(now).toISOString());
    endpoint.searchParams.set("createdAtLe", new Date(now).toISOString());
    endpoint.searchParams.set("limit", "1");
    const request = { method: "GET", headers: {}, redirect: "error" } as const;
    const result = await vendor.fetchImpl(endpoint.href, request);
    expect(await result.json()).toEqual([expect.objectContaining({ id: "tie" })]);
    endpoint.searchParams.set("other", "1");
    expect((await vendor.fetchImpl(endpoint.href, request)).status).toBe(400);
    await expect(vendor.fetchImpl("https://other.example/call", request)).rejects.toThrow("Unexpected vendor origin");

    reply.resolve();
    const placed = await placing;
    expect(placed).toMatchObject({ ok: true, value: { status: "scheduled" } });
    if (!placed.ok) throw new Error("Expected a placed fixture call");
    expect(await service.cancel(String(placed.value.call))).toBe("cancelled");
  } finally {
    readBody.resolve();
    reply.resolve();
    await vendor.close();
  }
});

it("injects 5xx and 409 before mutating vendor state", async () => {
  const vendor = await startFakeVapi({
    beforeBody: ({ method, path }) => method === "DELETE" ? 409 : method === "POST" && path === "/call" ? 503 : undefined,
  });
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const adapter = new VapiAdapter(vendor.fetchImpl);
    const service = new PhoneCallService(adapter, new RevisionStore(), () => "en");
    await service.saveSettings(defaultSettings("number-1", "Sam"));
    await expect(service.place({ to: "+12025550101", goal: "Ask about opening hours" })).resolves.toEqual({ ok: false, error: "vendor_unreachable" });
    await expect(adapter.cancel("fixture-call-1")).rejects.toMatchObject({ httpStatus: 409 });
    expect(vendor.creates).toBe(0);
  } finally {
    await vendor.close();
  }
});

it("leaves archive unconfirmed when an in-flight create cannot yet be identified", async () => {
  const created = barrier();
  const reply = barrier();
  const vendor = await startFakeVapi({
    beforeBody: ({ method, path }) => method === "GET" && path === "/call" ? 503 : undefined,
    beforeReply: async ({ method, path }) => {
      if (method === "POST" && path === "/call") {
        created.resolve();
        await reply.promise;
      }
    },
  });
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en");
    await service.saveSettings(defaultSettings("number-1", "Sam"));
    const placing = service.place({ to: "+12025550101", goal: "Ask about opening hours", when: "2026-12-01T10:00:00Z" }, { botId: "bot-a" });
    await created.promise;
    const call = String(vendor.calls.get("fixture-call-1")?.name);
    const stopped = await service.cancelForBot("bot-a");
    expect(stopped).toEqual([{ call, status: "unconfirmed" }]);
    expect(service._row(call)?.status).toBe("uncertain");
    expect(vendor.requests.filter(request => request.method === "DELETE")).toHaveLength(0);
    reply.resolve();
    await expect(placing).resolves.toMatchObject({ ok: true, value: { call, status: "scheduled" } });
    await expect(service.cancelForBot("bot-a")).resolves.toEqual([{ call, status: "confirmed" }]);
  } finally {
    reply.resolve();
    await vendor.close();
  }
});
