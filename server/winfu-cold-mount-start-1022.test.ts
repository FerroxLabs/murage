// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: the mounted readiness gate = server/drivers/acp/core.ts (boundMounted) with its windows in server/drivers/mcp-readiness.ts;
// the refusal row and the lease = server/index.ts (admitLedgerLease, the direct turn's late ticket). Consumer: the owner's first Fuigo turn.
//
// 1.0.22 winfu (the Windows gate box, also on shipped 1.0.21): the first Fuigo turn of a fresh install ended with "Murage couldn't
// start this reply. Send it again." and server.log read `native fence refusal engine=lease site=lease.ledger kind=turn`,
// `ledger refusal cause=checking:not-built`, `context revoked at a late submission ...; re-preparing (1 of 2)`, then
// `ledger refusal cause=consuming-http-denied` twice. That is the mounted gate refusing the turn itself: on a cold computer the engine
// still listed Murage's mounts as starting when the 15 to 20 s window ended, and each mount's proxy reached the release door just after
// its turn was refused. A mount still starting is waited for (mcpBoundStartingWaitMs); one that never comes up stays refused.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Message } from "./store.ts";

const acpReply = "hello from fake acp";
const question = "Fixture question";
const CARD = "Murage couldn't start this reply. Send it again.";
/** Longer than the turn's ordinary window (MCP_TURN_RECOVERY_MS, 20 s), shorter than the bound-starting wait (45 s). */
const COLD_START_MS = 25_000;

function replyAfterQuestion(messages: Message[]): Message | undefined {
  const index = messages.findIndex(m => m.role === "user" && m.kind === "text" && m.text === question);
  if (index < 0) return undefined;
  return messages.slice(index + 1).find(m => m.role === "bot" && m.kind === "text" && m.provenance === "provider" && !m.murageLine && m.text?.trim());
}

/** A fresh data directory, a new bot, its first turn: POST /api/bots/:id/messages on the booted server, the Fuigo driver. */
async function firstTurn(engineEnv: Record<string, string>) {
  const { proofWorld } = await import("./session-proof-world.ts");
  const world = await proofWorld("fuigo", "none", Object.entries(engineEnv).map(([key, value]) => `process.env.${key}=${JSON.stringify(value)};`).join(""));
  try {
    const bot = await world.bot();
    const start = world.log().length;
    await world.api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: question });
    await expect.poll(async () => (await world.api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 150_000, interval: 1000 }).not.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const { messages } = await world.api("GET", `/api/threads/${bot.threadId}/messages?limit=100`) as { messages: Message[] };
    const log = world.log().slice(start);
    const asked = messages.find(m => m.role === "user" && m.text === question)!;
    const card = messages.find(m => m.kind === "activity" && m.tool?.name === `error: ${CARD}`);
    console.log(`WINFU env=${JSON.stringify(engineEnv)} reply=${JSON.stringify(replyAfterQuestion(messages)?.text ?? null)} card=${card ? card.at - asked.at : "none"}\n${log.split("\n").filter(l => /ledger refusal|native fence refusal|context revoked|acp mcp gate/.test(l)).slice(0, 12).join("\n")}`);
    // the engine's own record of what it was sent (session-proof-world.ts FAKE_ACP_RPC_FULL_LOG): was this turn ever prompted?
    const rpcLog = join(world.fixture.info.dataDir, "warm-rpc.jsonl");
    const prompted = existsSync(rpcLog) && readFileSync(rpcLog, "utf8").includes("session/prompt");
    return { messages, log, rows: JSON.stringify(messages), cardAfterMs: card ? card.at - asked.at : undefined, prompted };
  } finally { await world.fixture.close(); }
}

for (const [shape, engineEnv] of [
  // the engine's own list says "initializing" for 25 s (its readiness notice comes at once): the gate's read loop decides (core.ts refusalDue)
  ["its list says starting", { FAKE_ACP_MCP_LIST_READY_AFTER_MS: String(COLD_START_MS) }],
  // real Fuigo's shape: the readiness notice comes only once the mounts settled, so the ready wait itself runs out first (core.ts "timeout")
  ["its readiness notice is late too", { FAKE_ACP_MCP_LIST_READY_AFTER_MS: String(COLD_START_MS), FAKE_ACP_MCP_READY_DELAY_MS: String(COLD_START_MS) }],
] as const)
it(`[cold start, ${shape}] the first Fuigo turn of a fresh install answers when its mounts need ${COLD_START_MS / 1000} s to come up`, async () => {
  const turn = await firstTurn(engineEnv);
  expect(replyAfterQuestion(turn.messages)?.text, "the engine's reply after the owner's question").toBe(acpReply);
  expect(turn.prompted, "the engine was sent the prompt").toBe(true);
  expect(turn.rows).not.toContain(CARD);
  expect(turn.rows).not.toContain("MEMORY_CONTEXT_REVOKED");
  expect(turn.log).not.toContain("ledger refusal");
}, 240_000);

it("[never ready] mounts that never come up keep the refusal (fail closed), after the whole bound-starting wait, and the gate says what it saw", async () => {
  const turn = await firstTurn({ FAKE_ACP_MCP_LIST_READY_AFTER_MS: "600000" });
  // fail closed: nothing was prompted, the owner gets the one card
  expect(turn.messages.some(m => m.role === "bot" && m.kind === "text" && !m.murageLine), "an engine reply on a turn whose mounts never came up").toBe(false);
  expect(turn.prompted, "a prompt sent to an engine whose mounts never came up").toBe(false);
  expect(turn.rows).toContain(CARD);
  // the gate box's lines, in its order
  const at = (needle: string) => turn.log.indexOf(needle);
  expect(at("native fence refusal engine=lease site=lease.ledger kind=turn")).toBeGreaterThan(-1);
  expect(at("ledger refusal cause=checking:not-built")).toBeGreaterThan(at("native fence refusal engine=lease site=lease.ledger kind=turn"));
  // the refusal waited for mounts the engine kept reporting as starting: not at the first window (15 to 20 s)
  expect(turn.cardAfterMs, "ms from the question to the refusal card").toBeGreaterThanOrEqual(40_000);
  // the refused gate names what it saw: server names and fixed status words only
  const gate = /acp mcp gate thread=\S+ engine=fuigoAgent waitedMs=(\d+) readiness=\S+ .*notConnected=[\w.@-]+:initializing/.exec(turn.log);
  expect(gate, "the refused gate's own line").not.toBeNull();
  expect(Number(gate![1]), "ms the gate waited for the starting mounts").toBeGreaterThanOrEqual(40_000);
}, 240_000);

// The same cold start on the turn that consumes memory over HTTP (Astra pre-check): the real fuigoAgent driver, its bound memory mount,
// the relay, the real memory proxy and POST /api/internal/memory/search (the harness of server/winfu-fresh-fuigo-memory-1022.test.ts,
// owner q1022-winfu-opus, here with the turn's default windows and mounts that need 25 s). The reply must rest on the route's JSON answer.
it("[cold start, memory over HTTP] the first Fuigo turn of a fresh install reads memory through its bound mount and replies when the mounts need 25 s", async () => {
  const { chmodSync } = await import("node:fs");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { launchMemoryVerificationServer } = await import("./testing/memory-verification-fixture.ts");
  const fakeAcp = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
  chmodSync(fakeAcp, 0o755);
  const fixture = await launchMemoryVerificationServer({}, undefined, { instrumentationSource: `
    await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./testing/claude-retained-session-preload.mjs", import.meta.url))).href)});
    const fs=await import('node:fs');const path=await import('node:path');
    const dir=process.env.MURAGE_DATA_DIR;const cfgFile=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
    fs.mkdirSync(path.join(process.env.HOME,'.fuigo'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.fuigo','auth.json'),'{}');
    cfg.instances['winfu-cold']={driver:'fuigoAgent',displayName:'Fuigo fixture',config:{cli:${JSON.stringify(fakeAcp)}},environment:{FAKE_ACP_MODE:'memory-search',
      FAKE_ACP_MCP_READY:'1',FAKE_ACP_MEMORY_LOG:path.join(dir,'acp-memory.log'),FAKE_ACP_MCP_READY_DELAY_MS:'${COLD_START_MS}',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_LIST_READY_AFTER_MS:'${COLD_START_MS}'}};
    fs.writeFileSync(cfgFile,JSON.stringify(cfg));` });
  try {
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(fixture.info.url + path, { method, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json().catch(() => null) as any };
    };
    const instance = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "winfu-cold");
    const made = await call("POST", "/api/bots", { name: "Winfu cold", modelSelection: { instanceId: "winfu-cold", model: instance.models.options[0]?.id || instance.models.default || "fixture-model" } });
    expect(made.status).toBe(201);
    const bot = made.body.bot;
    await call("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const text = "MSEARCH: weekly client report";
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
    let rows: any[] = [];
    await expect.poll(async () => {
      const view = (await call("GET", "/api/bots?messages=60")).body.bots.find((entry: any) => entry.id === bot.id);
      const all: any[] = view?.messages ?? [];
      const at = all.findIndex(row => row.role === "user" && row.text === text);
      rows = at >= 0 ? all.slice(at + 1) : [];
      return view?.busy !== true && rows.some(row => row.role === "bot" && (row.kind === "text" || String(row.tool?.name ?? "").includes(CARD)));
    }, { timeout: 150_000, interval: 500 }).toBe(true);
    const said = rows.map(row => `${row.kind}:${row.text ?? row.tool?.name ?? ""}`);
    console.log(`WINFU http rows=${JSON.stringify(said).slice(0, 600)}`);
    expect(rows.some(row => row.role === "bot" && row.kind === "text" && /memory search answered/.test(row.text)), `the reply resting on the memory answer; rows ${JSON.stringify(said)}`).toBe(true);
    expect(said.filter(line => line.includes(CARD))).toEqual([]);
    // the reply rests on the server's own answer to POST /api/internal/memory/search (a JSON body with a hits list)
    const log = join(fixture.info.dataDir, "acp-memory.log");
    const answers = (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(answers.at(-1), JSON.stringify(answers)).toMatchObject({ hits: expect.any(Number) });
  } finally { await fixture.close(); }
}, 240_000);
