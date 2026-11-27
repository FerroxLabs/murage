// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// C0 Astra High 1: Archive (the real PATCH route on a launched server) must not succeed while one of the bot's abandoned calls
// has no confirmed vendor stop: discovery still pending, or a DELETE that failed. A recorded attempt is read before any resend.
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
import { DatabaseSync } from "../sqlite-open.ts";
import type { CallRow } from "./contracts.ts";
import { PHONE_KEY_ORIGIN, PHONE_SECRETS_ENV } from "./phone-secrets.ts";
import { SqliteCallStore } from "./store.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";

it("Archive refuses until every abandoned call of the bot has a confirmed vendor stop", { timeout: 120_000 }, async () => {
  let failDelete = true;
  const vendor = await startFakeVapi({
    beforeBody: ({ method, path }) => failDelete && method === "DELETE" && path === "/call/vendor-failed" ? 500 : undefined,
  });
  const fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `
      process.env[${JSON.stringify(PHONE_SECRETS_ENV)}] = ${JSON.stringify(JSON.stringify({ key: "fixture", origin: PHONE_KEY_ORIGIN }))};
      const upstreamFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.origin === ${JSON.stringify(PHONE_KEY_ORIGIN)}) {
          const local = new URL(${JSON.stringify(vendor.origin)});
          local.pathname = url.pathname;
          local.search = url.search;
          return upstreamFetch(local, init);
        }
        return upstreamFetch(input, init);
      };
    `,
  }).catch(async error => { await vendor.close(); throw error; });
  try {
    const desktop = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": desktop.secret, "content-type": "application/json" };
    const makeBot = async (name: string) => {
      const made = await fetch(fixture.info.url + "/api/bots", {
        method: "POST", headers, body: JSON.stringify({ name, modelSelection: { instanceId: "verification", model: "fixture" } }),
      });
      expect(made.status).toBe(201);
      return (await made.json() as { bot: { id: string } }).bot.id;
    };
    const pendingBot = await makeBot("Pending fixture");
    const failedBot = await makeBot("Failed fixture");
    const attemptedBot = await makeBot("Attempted fixture");
    const row = (id: string, botId: string, extra: Partial<CallRow>): CallRow => ({
      id, botId, vendorId: "", revision: 1, assistantId: "assistant-fixture", createdAt: Date.now(), status: "abandoned",
      language: "en", to: "+12025550100", goal: "Ask about opening hours", details: "", limits: "", ...extra,
    });
    const created = new Date().toISOString();
    vendor.calls.set("vendor-failed", { id: "vendor-failed", status: "scheduled", createdAt: created });
    vendor.calls.set("vendor-attempted", { id: "vendor-attempted", status: "ended", endedReason: "scheduled-call-deleted", createdAt: created });
    const db = new DatabaseSync(join(fixture.info.dataDir, "phone-calls.db"));
    try {
      const store = new SqliteCallStore(db);
      // Owner Cancel during an unresolved create: abandoned, vendor id not yet discovered.
      store.put(row("call_pending", pendingBot, {}));
      // Discovery found it, but the vendor refused the DELETE.
      store.put(row("call_failed", failedBot, { vendorId: "vendor-failed", abandonCancel: "failed" }));
      // A DELETE whose response was lost; the vendor shows the call deleted.
      store.put(row("call_attempted", attemptedBot, { vendorId: "vendor-attempted", abandonCancel: "attempted" }));
    } finally { db.close(); }
    const archive = (botId: string) => fetch(fixture.info.url + "/api/bots/" + botId, {
      method: "PATCH", headers, body: JSON.stringify({ hidden: true, chiefOfStaff: false, settingsScope: "defaults" }),
    });
    const deletes = () => vendor.requests.filter(r => r.method === "DELETE").map(r => r.path);

    // Pending discovery: nothing to stop yet, so Archive cannot report the bot's calls stopped.
    expect((await archive(pendingBot)).status).toBe(409);
    expect(deletes()).toEqual([]);
    // Discovery now names the call: Archive stops it and completes.
    vendor.calls.set("vendor-pending", { id: "vendor-pending", name: "call_pending", status: "scheduled", createdAt: created });
    expect((await archive(pendingBot)).status).toBe(200);
    expect(deletes()).toEqual(["/call/vendor-pending"]);
    expect(vendor.calls.get("vendor-pending")?.status).toBe("ended");

    // Failed DELETE: the call still reads scheduled and the retry fails again, so Archive refuses.
    expect((await archive(failedBot)).status).toBe(409);
    expect(vendor.calls.get("vendor-failed")?.status).toBe("scheduled");
    failDelete = false;
    expect((await archive(failedBot)).status).toBe(200);
    expect(vendor.calls.get("vendor-failed")?.status).toBe("ended");

    // Attempted with a lost response: the read shows it deleted, so Archive completes without a second DELETE.
    const before = deletes().length;
    expect((await archive(attemptedBot)).status).toBe(200);
    expect(deletes().length).toBe(before);
    expect(deletes().filter(path => path === "/call/vendor-attempted")).toEqual([]);
  } finally {
    await fixture.close().finally(() => vendor.close());
  }
});
