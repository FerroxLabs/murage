// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fuigo 1.0.47 held MCP server card and the idle guard, through the REAL route: a booted Murage server, the real fuigoAgent
// driver, the server's own wait rule (server/index.ts presentedRequests.subscribeExecution + approvalAttention.ask) and the
// driver's idle guard (MURAGE_ACP_PROMPT_IDLE_MS), against a fake ACP engine that holds an owner's MCP server and then goes
// silent. An ambient card (the held server's "changed: Approve") is not a decision the turn waits on, so a silent engine is
// still stopped by the idle guard; a real permission ask in the same setup is a decision and keeps the turn open.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const IDLE_MS = 1500;
let fixture: VerificationServer;
let headers: Record<string, string>;
let model = "default";
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(fixture.info.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json() as any;
  expect(r.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
  return value;
};

beforeAll(async () => {
  const root = resolve(".");
  fixture = await launchVerificationServer(process.env, undefined, {
    portRange: { from: 45400, span: 90 },
    instrumentationSource: `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      process.env.NODE_ENV = 'test';
      process.env.MURAGE_ACP_PROMPT_IDLE_MS = '${IDLE_MS}';
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
      process.env.MURAGE_ENGINE_EXCLUSION_PATH = ${JSON.stringify(join(root, "server/testing/engine-exclusion-stub.cjs"))};
      const data = process.env.MURAGE_DATA_DIR;
      writeFileSync(join(data, 'f1047-env'), '{}');
      const cli = join(data, 'f1047-fuigo.mjs');
      writeFileSync(cli, [
        '#!/usr/bin/env -S node --experimental-strip-types',
        "import { readFileSync } from 'node:fs';",
        'Object.assign(process.env, JSON.parse(readFileSync(' + JSON.stringify(join(data, 'f1047-env')) + ', "utf8")));',
        'await import(' + JSON.stringify('file://' + ${JSON.stringify(join(root, "server/testing/"))} + 'fake-acp-cli.ts') + ');',
      ].join('\\n'), {mode: 0o755});
      mkdirSync(join(process.env.HOME, '.fuigo'), {recursive:true});
      writeFileSync(join(process.env.HOME, '.fuigo', 'auth.json'), '{}');
      const file = join(data, 'config.json');
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      cfg.instances = { fuigo: { driver: 'fuigoAgent', config: { cli } } };
      writeFileSync(file, JSON.stringify(cfg));
    `,
  });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const instance = (await api("GET", "/api/instances")).instances.find((i: any) => i.instanceId === "fuigo");
  expect(instance?.snapshot?.state).toBe("available");
  const first = instance.models.options[0];
  model = instance.models.default || (typeof first === "string" ? first : first?.id || "default");
}, 120_000);

afterAll(async () => { await fixture?.close(); });

/** A fresh bot (fresh thread, fresh engine process) on an engine configured by `env`, one turn started through the message route. */
async function start(env: Record<string, string>) {
  writeFileSync(join(fixture.info.dataDir, "f1047-env"), JSON.stringify({ FAKE_ACP_PERMISSION_SESSION: "1", ...env }));
  let { bot } = await api("POST", "/api/bots", {});
  await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "fuigo", model }, computer: "off", browser: false, composio: false, autoApprove: false, fullAccess: false });
  bot = (await api("GET", `/api/bots/${bot.id}`)).bot;
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "hello" });
  const busy = async () => (await api("GET", `/api/bots/${bot.id}`)).bot.busy === true;
  const events = () => readFileSync(join(fixture.info.dataDir, "events", bot.threadId + ".ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line)) as any[];
  const cards = async () => ((await api("GET", `/api/threads/${bot.threadId}/open-cards`)).openCards ?? []) as any[];
  return { bot, busy, events, cards };
}

const held = [{ name: "notes-sync", heldReason: "changed since you approved it", heldDigest: "d1" }];

describe("Fuigo 1.0.47 held MCP card and the idle guard through the booted server (ASTRA High on 9e3d2d5663)", () => {
  it("a silent engine with an open held-server card is still stopped by the idle guard (the card does not take the human wait)", async () => {
    const t = await start({ FAKE_ACP_MODE: "hang", FAKE_ACP_MCP_LIST: "all:ready", FAKE_ACP_MCP_LIST_HELD: JSON.stringify(held) });
    // the held card is opened (ambient) on the real route, and the turn is not the owner deciding
    await expect.poll(async () => t.events().some(e => e.type === "request.opened" && e.tool === "mcp_approval"), { timeout: 15_000, interval: 100 }).toBe(true);
    // the turn ends on the idle guard, well within a bound that a paused guard could never meet
    await expect.poll(async () => !(await t.busy()), { timeout: 20_000, interval: 200 }).toBe(true);
    await new Promise(resolveSleep => setTimeout(resolveSleep, 1000));
    // it ended as a failed turn (the engine was stopped), not as a clean reply
    const kinds = t.events().map(e => e.type + (e.ok === false ? ":failed" : "") + (e.type === "runtime.error" ? ":" + String(e.message).slice(0, 80) : ""));
    // and by the idle guard, not by a memory refusal (the mounts are ready; only the owner's own server is held)
    const said = ((await api("GET", `/api/threads/${t.bot.threadId}/messages?limit=100`)).messages as any[]).map(m => String(m.text ?? ""));
    expect(said.some(text => text.includes("context is no longer available"))).toBe(false);
    expect(kinds).toContain("turn.completed:failed");
    // the owner never answered the card: the turn did not end by the owner approving it
    expect(t.events().some(e => e.type === "request.resolved" && e.behavior === "answer")).toBe(false);
  }, 60_000);

  it("control: a real permission ask in the same setup is a decision, so the idle guard leaves the turn open until the owner answers", async () => {
    const outside = "/srv/elsewhere/old-build";
    const toolCall = { toolCallId: "rm-1", kind: "execute", rawInput: { command: `rm -rf ${outside}` },
      title: `rm -rf ${outside} — This would delete or change \`${outside}\`, which is outside the workspace and was not named by you` };
    const t = await start({ FAKE_ACP_MODE: "permission", FAKE_ACP_REQUIRE_PERMISSION_PROMPTS: "1", FAKE_ACP_MCP_LIST: "all:ready", FAKE_ACP_PERMISSION_TOOLCALL: JSON.stringify(toolCall) });
    let card: any;
    await expect.poll(async () => { card = (await t.cards())[0]; return Boolean(card); }, { timeout: 15_000, interval: 100 }).toBe(true);
    await new Promise(resolveSleep => setTimeout(resolveSleep, IDLE_MS * 3));
    expect(await t.busy()).toBe(true);
    expect(t.events().some(e => e.type === "turn.completed")).toBe(false);
    await api("POST", `/api/threads/${t.bot.threadId}/respond`, { requestHandle: card.requestHandle ?? card.card?.requestHandle, action: "deny" });
    await expect.poll(async () => !(await t.busy()), { timeout: 20_000, interval: 200 }).toBe(true);
  }, 60_000);
});
