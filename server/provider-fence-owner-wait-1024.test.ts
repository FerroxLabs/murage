// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P9 / F41 (1.0.24): the owner's own message sent while the desktop holds the uncertain model-connection fence ("Model connections are
// being reconciled ... Try again shortly") is held and sent when the fence lifts, never bounced. Real server, real POST
// /api/bots/:id/messages; the instrumentation delivers the desktop's fence message (as provider-bank-fence-api.test.ts does) and lifts
// it 2.5 s later. Owner of the wait: server/index.ts engineFleetInTransition / startTurn; owner of the fence: server/provider-bank-fence.ts.
// A fence that never lifts still ends in the coded 409 after the bounded wait (MURAGE_ENGINE_START_WAIT_MS): provider-bank-fence-api.test.ts.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const fenceModule = new URL("./provider-bank-fence.ts", import.meta.url).href;
let fixture: VerificationServer;
let headers: Record<string, string> = {};
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as any };
}

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { applyProviderBankFenceMessage, providerBankDispatchFenced } from ${JSON.stringify(fenceModule)};
    if(!applyProviderBankFenceMessage({type:'murage:provider-bank-fence',held:true}))throw Error('fence fixture rejected');
    import { existsSync } from 'node:fs';
    const lift=setInterval(()=>{if(!existsSync(join(process.env.MURAGE_DATA_DIR,'lift-fence')))return;clearInterval(lift);applyProviderBankFenceMessage({type:'murage:provider-bank-fence',held:false});writeFileSync(join(process.env.MURAGE_DATA_DIR,'fence-lifted'),String(providerBankDispatchFenced()));},50);lift.unref();
  ` });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 30_000);
afterAll(async () => { await fixture?.close(); });

it("the owner's message sent during the fence is held and reaches the engine once the fence lifts", async () => {
  const engines = (await api("GET", "/api/instances")).body.instances;
  const model = engines.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  const created = await api("POST", "/api/bots", { name: "Fence wait fixture", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  const lifted = join(fixture.info.dataDir, "fence-lifted");
  expect(existsSync(lifted)).toBe(false);
  const pending = api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "hold me until the fence lifts" });
  let answered = false; void pending.then(() => { answered = true; });
  await new Promise(resolve => setTimeout(resolve, 1500));
  // still held: no answer yet (base answers 409 at once), nothing at the engine
  expect(answered).toBe(false);
  expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
  writeFileSync(join(fixture.info.dataDir, "lift-fence"), "1");
  const sent = await pending;
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
  // the engine saw the turn only after the fence lifted
  expect(existsSync(lifted)).toBe(true);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 20_000 }).toBe(true);
}, 60_000);
