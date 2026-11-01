// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LONGWORK-STALL-60-ROOMS. A room runs one turn at a time, so its no activity limit stays short for a silent engine and rises to at
// least an hour only while the engine has a tool open. The real server runs against the fake engines with the stall clock sped up
// 120 times, as room-turn-silence-api.test.ts does: half a real second is one simulated minute.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const SPEED = 120;
const sim = (minutes: number) => minutes * 60_000 / SPEED;
const FAKE_CODEX = join(serverDir, "testing", "fake-codex-app-server.ts");
const FAKE_ACP = join(serverDir, "testing", "fake-acp-cli.ts");
let fixture: VerificationServer;
let headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const stopLines = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[])
  .filter((message) => message.kind === "activity" && String(message.tool?.name ?? "").includes("no activity"))
  .map((message) => String(message.tool?.name));
const stopLine = (minutes: number) => `error: no activity for ${minutes} minutes: stopping; waiting for the engine to confirm close`;

async function roomWith(name: string, instanceId: string, model: string) {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const group = await api("POST", "/api/groups", { name: `${name} room`, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(group.status).toBe(201);
  return group.body.group as { id: string; threadId: string };
}

/** Sends one message and returns how many simulated minutes passed before the room stopped it, with the line it wrote. */
async function stoppedAfter(group: { id: string; threadId: string }, longestMinutes: number) {
  const sentAt = Date.now();
  expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "Work quietly" })).status).toBe(202);
  await expect.poll(() => stopLines(group.threadId), { timeout: sim(longestMinutes) + 20_000, interval: 100 }).toHaveLength(1);
  return { minutes: (Date.now() - sentAt) / sim(1), lines: await stopLines(group.threadId) };
}

// fake-codex-app-server.ts and fake-acp-cli.ts have POSIX shebangs
describe.skipIf(process.platform === "win32")("a room's no activity limit while a tool is open", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const SPEED=${SPEED};const t0=Date.now();
      const {TurnWatchdog}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "turn-watchdog.ts")).href)});
      TurnWatchdog.prototype.now=function(){return t0+(Date.now()-t0)*SPEED};
      const watch=TurnWatchdog.prototype.start;
      TurnWatchdog.prototype.start=function(){this.opts={...this.opts,checkMs:100};return watch.call(this)};
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      const codex=(mode)=>({driver:'codex',displayName:mode,config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true},environment:{FAKE_CODEX_MODE:mode}});
      cfg.instances.codexTool=codex('tool-hold');
      cfg.instances.codexClosed=codex('tool-close-then-hold');
      cfg.instances.acpTool={driver:'customAcp',displayName:'acpTool',config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true},environment:{FAKE_ACP_MODE:'stall-after-tool',FAKE_ACP_TOOL_NEVER_FINISHES:'1'}};
      cfg.instances.piSilent={driver:'piAgent',displayName:'piSilent',config:{cli:${JSON.stringify(join(serverDir, "testing/fake-pi-cli.ts"))},fullAuto:true},environment:{FAKE_PI_MODE:'hold'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it("Codex: a quiet command runs past 20 minutes and stops at 60", async () => {
    const { minutes, lines } = await stoppedAfter(await roomWith("Codex tool", "codexTool", "gpt-fake-default"), 60);
    expect(lines).toEqual([stopLine(60)]);
    expect(minutes).toBeGreaterThanOrEqual(58);
  }, 70_000);

  it("ACP: a quiet tool runs past 20 minutes and stops at 60", async () => {
    const { minutes, lines } = await stoppedAfter(await roomWith("ACP tool", "acpTool", "fake-acp-model"), 60);
    expect(lines).toEqual([stopLine(60)]);
    expect(minutes).toBeGreaterThanOrEqual(58);
  }, 70_000);

  it("an engine that goes silent with no tool still stops at 20", async () => {
    const { minutes, lines } = await stoppedAfter(await roomWith("Silent", "piSilent", "ollama-cloud/glm-5.2"), 20);
    expect(lines).toEqual([stopLine(20)]);
    expect(minutes).toBeGreaterThanOrEqual(18);
    expect(minutes).toBeLessThan(40);
  }, 50_000);

  it("the limit falls back to 20 once the tool has finished", async () => {
    const { minutes, lines } = await stoppedAfter(await roomWith("Closed tool", "codexClosed", "gpt-fake-default"), 20);
    expect(lines).toEqual([stopLine(20)]);
    expect(minutes).toBeGreaterThanOrEqual(18);
    expect(minutes).toBeLessThan(40);
  }, 50_000);

  it("a saved limit above 60 is kept with a tool open", async () => {
    expect((await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 70 } })).status).toBe(200);
    try {
      const { minutes, lines } = await stoppedAfter(await roomWith("Long limit", "codexTool", "gpt-fake-default"), 70);
      expect(lines).toEqual([stopLine(70)]);
      expect(minutes).toBeGreaterThanOrEqual(68);
    } finally {
      await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 20 } });
    }
  }, 80_000);
});
