// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WINTERRY (1.0.22, Astra 2f0bf1f54b/2aec0899e4 H1): an engine stuck before it answers often shows nothing but Murage's own chip about
// it ("Preparing Codex...", a hooks or MCP wait, pi's "taking longer than usual to start this chat" notice). That chip is Murage's, not the engine's
// first response: a routine run whose engine shows it and then nothing more is still stopped at the first-response limit (five
// minutes) with the named line, not left to sit out the whole silence limit.
//
// The real server runs the real pi driver against the fake pi CLI whose session handshake is never answered (FAKE_PI_SESSION_GATE on
// a file that never appears), so the driver emits its own session-wait chip (origin "murage") at PI_SESSION_SLOW_MS, 20 real seconds.
// The watchdog clock runs 10 times fast, so that chip lands at about 3.3 simulated minutes, before the five-minute limit.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";
import { fixtureDisplayApi } from "./testing/display-fixture.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const SPEED = 10;
/** Real milliseconds for simulated minutes. */
const sim = (minutes: number) => minutes * 60_000 / SPEED;
let fixture: VerificationServer;
let headers: Record<string, string>;
const api = fixtureDisplayApi(() => join(fixture.info.dataDir, "messages.db"), async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
});

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
    const fs=await import('node:fs');const path=await import('node:path');
    const SPEED=${SPEED};const t0=Date.now();
    const {TurnWatchdog}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "turn-watchdog.ts")).href)});
    TurnWatchdog.prototype.now=function(){return t0+(Date.now()-t0)*SPEED};
    const watch=TurnWatchdog.prototype.start;
    TurnWatchdog.prototype.start=function(){this.opts={...this.opts,checkMs:100};return watch.call(this)};
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.engineStuck={driver:'piAgent',displayName:'engineStuck',config:{cli:${JSON.stringify(join(serverDir, "testing/fake-pi-cli.ts"))},fullAuto:true},
      environment:{FAKE_PI_MODE:'hold',FAKE_PI_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'session-never-answered')}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30_000);
afterAll(async () => { await fixture?.close(); });

it("a routine run whose engine shows only Murage's own session-wait chip is still stopped at five minutes with the no first response line", async () => {
  const created = await api("POST", "/api/bots", { name: "Stuck routine", modelSelection: { instanceId: "engineStuck", model: "ollama-cloud/glm-5.2" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const routine = await api("POST", "/api/routines", { botId: bot.id, name: "Stuck report", prompt: "Write the morning report", schedule: { type: "once", at: Date.now() + 3_600_000 } });
  expect(routine.status).toBeLessThan(300);
  const sentAt = Date.now();
  expect((await api("POST", `/api/routines/${routine.body.routine.id}/run`, {})).status).toBeLessThan(300);
  const runThread = async () => ((await api("GET", "/api/routines")).body.runs as any[]).find((run) => run.botId === bot.id && run.threadId)?.threadId as string | undefined;
  const lines = async () => {
    const threadId = await runThread();
    return threadId ? ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[]).map((message) => String(message.tool?.name ?? "")) : [];
  };
  // precondition: Murage's own chip about the engine is on the routine's thread before the limit (it is what used to end the clock)
  await expect.poll(async () => (await lines()).some((line) => line.includes("taking longer than usual to start this chat")), { timeout: sim(4.8), interval: 100 }).toBe(true);
  expect((await lines()).some((line) => line.includes("no first response"))).toBe(false);
  // the behaviour: the chip did not count, so the five-minute limit still stops the run, named
  await expect.poll(async () => (await lines()).filter((line) => /no activity|no first response|inactive thread|exceeded/.test(line)), { timeout: sim(9), interval: 100 }).toEqual([
    "error: the engine gave no first response for 5 minutes: the turn was stopped",
  ]);
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(sim(4.5));
}, 120_000);
