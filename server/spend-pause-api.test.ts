// SPDX-License-Identifier: AGPL-3.0-or-later
// BOARD-1019 row 22. This is the documented isolated launcher with a fake
// Flux reader; all external fetches are refused and no real credential exists.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
const actions: unknown[] = [];
const key = "sk-flux-gap-spend-fixture-000000000000";
const stateFile = () => join(fixture.info.dataDir, "pause-fixture.json");
const api = async (method: string, path: string, body?: unknown, proof = headers) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...proof }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = { status: response.status, body: await response.json() as any };
  // Keep only the workflow's own status/actions and fake transcript. Proofs
  // and config credentials are deliberately excluded from the receipt.
  if (path !== "/api/desktop-secret" && path !== "/api/config") actions.push({ method, path, ...(body === undefined ? {} : { input: body }), result });
  return result;
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { qualifySpendPause: true, turnLog: { replies: ["Non-Flux work completed"] }, instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.flux = { apiKey: ${JSON.stringify(key)} }; cfg.spend = { monthlyLimitUsd: 100 };
    fs.writeFileSync(file, JSON.stringify(cfg));
    const state = path.join(process.env.MURAGE_DATA_DIR, 'pause-fixture.json');
    if (!fs.existsSync(state)) fs.writeFileSync(state, JSON.stringify({spent: 100, fail: false}));
    let seq = 0; const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'api.fluxrouter.ai' || url.hostname === 'fluxrouter.ai') {
        if (url.pathname === '/v1/key/limits') {
          const row = JSON.parse(fs.readFileSync(state, 'utf8'));
          if (row.fail) return Response.json({error: 'fixture unreadable'}, {status: 503});
          const stamp = new Date(Date.UTC(2026,10,13,12,0,++seq)).toISOString();
          return Response.json({key_id: 'fixture-key', key_monthly_budget_usd: null, key_monthly_token_limit: null,
            spent_usd_this_month: 1, tokens_this_month: 0, spend_basis: 'customer_billed_sale', resets_at: '2026-12-01T00:00:00Z', as_of: stamp,
            account_id: 'fixture-account', month: '2026-11', account_spent_usd_this_month: row.spent, account_as_of: stamp});
        }
        if (url.pathname.endsWith('/models')) return Response.json({data: [{id: 'flux-fast', object: 'model', owned_by: 'fixture'}]});
        return Response.json({error: 'fixture endpoint unavailable'}, {status: 404});
      }
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return original(input, init);
      throw new Error('external fetch refused by the isolated spending fixture');
    };
  ` });
  const proof = await api("GET", "/api/desktop-secret", undefined, {});
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 60_000);
afterAll(async () => {
  const evidence = process.env.GAP_SPEND_EVIDENCE_DIR;
  if (fixture && evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "fixture-evidence.json"), JSON.stringify({ fixture: fixture.info, actions }, null, 2));
    writeFileSync(join(evidence, "fixture-server.log"), readFileSync(fixture.info.logPath));
  }
  await fixture?.close();
});

it("the default server exposes the account hold, rechecks and wakes, and never exposes a key", async () => {
  const check = await api("POST", "/api/spend/check", {});
  expect(check.status).toBe(200);
  expect(check.body.pause).toMatchObject({ capability: "on", limitUsd: 100, held: [{ credentialId: "account", holds: [{ kind: "limit" }] }] });
  const reading = await api("GET", "/api/spend");
  expect(reading.body.total).toMatchObject({ state: "ok", spentUsd: 100 }); // account 100, not this key's 1
  expect(JSON.stringify(reading.body)).not.toContain(key);
  expect((await api("PUT", "/api/spend/limit", { monthlyLimitUsd: 200 })).body.pause.held).toEqual([]);
  writeFileSync(stateFile(), JSON.stringify({ spent: 100, fail: true }));
  expect((await api("POST", "/api/spend/check", {})).body.pause.held).toContainEqual({ credentialId: "account", holds: [{ kind: "unknown" }] });
  writeFileSync(stateFile(), JSON.stringify({ spent: 100, fail: false }));
  expect((await api("POST", "/api/spend/check", {})).body.pause.held).toEqual([]);
  const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
  expect(saved.spend.monthlyLimitUsd).toBe(200);
}, 30_000);

it("spending writes are desktop-only and malformed limits cannot mutate the saved value", async () => {
  for (const [method, path] of [["PUT", "/api/spend/limit"], ["POST", "/api/spend/check"], ["POST", "/api/spend/notice/dismiss"]]) {
    expect((await api(method!, path!, { monthlyLimitUsd: 999 }, { "x-murage-companion": "1", "x-murage-door-token": "d".repeat(64) })).status).toBe(404);
  }
  for (const value of [-1, 1_000_001, "100", { monthlyLimitUsd: 500, refusals: {} }]) {
    const body = typeof value === "object" ? value : { monthlyLimitUsd: value };
    expect((await api("PUT", "/api/spend/limit", body)).status).toBe(400);
  }
  expect((await api("GET", "/api/spend")).body.pause.limitUsd).toBe(200);
});

it("an owner Flux send refuses before taking its words, while the fake native engine still answers", async () => {
  await api("PUT", "/api/spend/limit", { monthlyLimitUsd: 100 });
  const instances = (await api("GET", "/api/instances")).body.instances;
  const nativeModel = instances.find((item: any) => item.instanceId === "verification").models.options.find((model: any) => !model.id.includes("flux")).id;
  const native = await api("POST", "/api/bots", { name: "Native spending fixture", modelSelection: { instanceId: "verification", model: nativeModel } });
  expect(native.status).toBe(201);
  await api("PATCH", `/api/bots/${native.body.bot.id}`, { computer: "off", browser: false, composio: false });
  const nativeSend = await api("POST", `/api/bots/${native.body.bot.id}/messages`, { text: "native fixture still answers", threadId: native.body.bot.threadId });
  expect(nativeSend.status, JSON.stringify(nativeSend.body)).toBe(202);
  await expect.poll(async () => {
    const transcript = await api("GET", `/api/threads/${native.body.bot.threadId}/messages?limit=100`);
    return transcript.body.messages.some((message: any) => message.role === "bot" && message.kind === "text" && message.text?.includes("Non-Flux work completed"));
  }, { timeout: 30_000 }).toBe(true);
  const flux = await api("POST", "/api/bots", { name: "Flux spending fixture", modelSelection: { instanceId: "verification", model: "flux-fast" } });
  expect(flux.status).toBe(201);
  await api("PATCH", `/api/bots/${flux.body.bot.id}`, { computer: "off", browser: false, composio: false });
  const refused = await api("POST", `/api/bots/${flux.body.bot.id}/messages`, { text: "these words stay in the composer", threadId: flux.body.bot.threadId });
  expect(refused).toMatchObject({ status: 409, body: { code: "spend_limit", retry: "never" } });
  const transcript = await api("GET", `/api/threads/${flux.body.bot.threadId}/messages?limit=100`);
  expect(transcript.body.messages.some((message: any) => message.role === "user" && message.text === "these words stay in the composer")).toBe(false);
}, 60_000);

it("the owner's pause response is bound to the configured credential inventory", async () => {
  const config = await api("GET", "/api/config");
  const response = await api("GET", "/api/spend");
  expect(response.body.pauseFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(response.body.pauseFingerprint).toBe(config.body.spend.pauseFingerprint);
  expect(response.body.pauseFingerprint).not.toContain(key);
});
