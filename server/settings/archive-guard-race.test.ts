// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 C6, behavioural: a real booted server, the real PATCH /api/bots/:id archive path. While the archive waits on
// the phone-call cleanup, the owner saves new app choices (PUT /api/bots/:id/access). The archive must answer 409
// ACCESS_CHANGED and leave the bot visible; it must not archive on the revision it reviewed before the save.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";

const SERVICE = new URL("../phone-calls/service.ts", import.meta.url).href;

it("an access save that lands during the phone-call cleanup makes the archive answer 409 and archives nothing", async () => {
  // Child-process instrumentation: an empty phone store makes the archive path run the cleanup, and the cleanup holds
  // until the test releases it, so the save lands inside the await.
  const instrumentationSource = `
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = process.env.MURAGE_DATA_DIR;
    fs.writeFileSync(path.join(dir, 'phone-calls.db'), '');
    const { PhoneCallService } = await import(${JSON.stringify(SERVICE)});
    const original = PhoneCallService.prototype.cancelForBot;
    PhoneCallService.prototype.cancelForBot = async function (botId) {
      fs.writeFileSync(path.join(dir, 'cleanup-entered'), botId);
      while (!fs.existsSync(path.join(dir, 'cleanup-release'))) await new Promise((resolve) => setTimeout(resolve, 20));
      return original.call(this, botId);
    };
  `;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const call = (method: string, path: string, body?: unknown) => fetch(fixture.info.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const dataDir = fixture.info.dataDir;

    const { bot } = await (await call("POST", "/api/bots", { name: "Archive race fixture" })).json() as { bot: { id: string } };
    const configure = async () => {
      const view = await (await call("GET", `/api/bots/${bot.id}/access`)).json() as { policy: { revision: number } };
      const saved = await call("PUT", `/api/bots/${bot.id}/access`, { action: "configure", revision: view.policy.revision, mode: "restricted", allowWrites: false, grants: [] });
      expect(saved.status).toBe(200);
      return ((await saved.json()) as { policy: { revision: number } }).policy.revision;
    };
    const reviewed = await configure();

    // The owner reviewed `reviewed` and presses Archive; the cleanup is held.
    const archive = call("PATCH", `/api/bots/${bot.id}`, { hidden: true, accessRevision: reviewed });
    const entered = join(dataDir, "cleanup-entered");
    for (let waited = 0; !existsSync(entered) && waited < 300; waited++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(entered)).toBe(true);

    // A second save lands inside the await, so the reviewed revision is stale.
    const current = await configure();
    expect(current).toBeGreaterThan(reviewed);
    writeFileSync(join(dataDir, "cleanup-release"), "");

    const answer = await archive;
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: "ACCESS_CHANGED", botId: bot.id });
    const after = await (await call("GET", `/api/bots/${bot.id}/access`)).json() as { policy: { revision: number } };
    expect(after.policy.revision).toBe(current);
    const list = await (await call("GET", "/api/bots")).json() as { bots: Array<{ id: string; hidden?: boolean }> };
    expect(list.bots.find((item) => item.id === bot.id)?.hidden).not.toBe(true);
  } finally {
    await fixture.close();
  }
}, 120_000);
