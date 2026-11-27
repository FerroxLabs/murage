// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
import { DatabaseSync } from "../sqlite-open.ts";
import { PHONE_KEY_ORIGIN, PHONE_SECRETS_ENV } from "./phone-secrets.ts";
import { SqliteCallStore } from "./store.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";

it("a stale Archive request never cancels a vendor call", async () => {
  const vendor = await startFakeVapi();
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
    const headers = {
      "x-murage-surface": "desktop",
      "x-murage-surface-secret": desktop.secret,
      "content-type": "application/json",
    };
    const made = await fetch(fixture.info.url + "/api/bots", {
      method: "POST", headers, body: JSON.stringify({ name: "Archive fixture", modelSelection: { instanceId: "verification", model: "fixture" } }),
    });
    expect(made.status).toBe(201);
    const { bot } = await made.json() as { bot: { id: string; permissionRev?: number } };
    vendor.calls.set("vendor-call", { id: "vendor-call", status: "scheduled", createdAt: new Date().toISOString() });
    const db = new DatabaseSync(join(fixture.info.dataDir, "phone-calls.db"));
    try {
      new SqliteCallStore(db).put({
        id: "call_fixture", botId: bot.id, vendorId: "vendor-call", revision: 1, assistantId: "assistant-fixture",
        createdAt: Date.now(), status: "scheduled", language: "en", to: "+12025550100", goal: "Ask about opening hours", details: "", limits: "",
      });
    } finally { db.close(); }
    const archive = (ifRev?: number) => fetch(fixture.info.url + "/api/bots/" + bot.id, {
      method: "PATCH", headers, body: JSON.stringify({ hidden: true, chiefOfStaff: false, settingsScope: "defaults", ifRev }),
    });
    expect((await archive((bot.permissionRev ?? 0) + 1)).status).toBe(409);
    expect(vendor.requests).toEqual([]);
    expect(vendor.calls.get("vendor-call")?.status).toBe("scheduled");
    expect((await archive()).status).toBe(200);
    expect(vendor.requests.map(request => [request.method, request.path])).toEqual([["DELETE", "/call/vendor-call"]]);
  } finally {
    await fixture.close().finally(() => vendor.close());
  }
});
