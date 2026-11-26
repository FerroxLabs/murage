// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane q1022-idleburn-opus owns this witness; observe.ts owns the stall watch and its park/wake; index.ts owns the busy predicate
// (setLoopWatchBusy(() => !serverIdle())) and the wake sites (the store's bot/room change stream, the turn owner maps, a routine run going live).
//
// 1.0.22 idle burn (HIDDEN-COST-opus row 8, Astra H1/H2): on the REAL server entry (server/index.ts, booted with fake engines), an idle server
// has no stall-watch timer and the loop-delay histogram off; a turn arms the fine tick (woken from the turn start, not by polling), and once
// the turn settles the watch parks again. Observed from inside the server's main thread: the instrumentation (loaded before index.ts) logs
// every interval observe.ts starts or clears and every enable/disable of the histogram, as `[watch-probe]` lines in the server log.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

const PROBE = String.raw`
const __mod = await import("node:module"), __req = __mod.createRequire(import.meta.url);
const __ph = __req("node:perf_hooks"), __monitor = __ph.monitorEventLoopDelay;
const __say = s => process.stderr.write("[watch-probe] " + s + "\n");
__ph.monitorEventLoopDelay = options => {
  const h = __monitor(options), on = h.enable.bind(h), off = h.disable.bind(h);
  h.enable = () => { __say("hist on"); return on(); };
  h.disable = () => { __say("hist off"); return off(); };
  return h;
};
__mod.syncBuiltinESMExports();
const __si = globalThis.setInterval, __ci = globalThis.clearInterval, __watch = new Set();
globalThis.setInterval = (fn, ms, ...rest) => {
  const h = __si(fn, ms, ...rest);
  // the caller's frame (frame 0 is this wrapper): observe.ts's own timers only
  if (/server[\/\\]observe\.ts:/.test((new Error().stack ?? "").split("\n")[2] ?? "")) { __watch.add(h); __say("arm " + ms); }
  return h;
};
globalThis.clearInterval = h => { if (__watch.delete(h)) __say("park"); return __ci(h); };
// a Fuigo fixture engine for the Chief's hidden proposal turn (as project-proposal-api.test.ts sets it up)
const { customAcpSupport: __host } = await import(${JSON.stringify(new URL("./drivers/acp/custom.ts", import.meta.url).href)}); __host.fluxReach = () => "elsewhere";
const __fs = await import("node:fs"), __path = await import("node:path");
const __file = __path.join(process.env.MURAGE_DATA_DIR, "config.json"), __cfg = JSON.parse(__fs.readFileSync(__file, "utf8"));
__fs.mkdirSync(__path.join(process.env.HOME, ".fuigo"), { recursive: true }); __fs.writeFileSync(__path.join(process.env.HOME, ".fuigo", "auth.json"), "{}");
__cfg.instances.fuigo = { driver: "fuigoAgent", displayName: "Fuigo fixture", environment: { FAKE_ACP_MODE: "project-propose", FAKE_ACP_MCP_READY: "1", FAKE_PROPOSE_LOG: __path.join(process.env.MURAGE_DATA_DIR, "propose.jsonl") }, config: { cli: ${JSON.stringify(fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)))} } };
__fs.writeFileSync(__file, JSON.stringify(__cfg));
`;

/** The watch as the probe lines leave it: armed timers live (arms minus parks) and whether the histogram is on, from line `from` on. */
function watchState(lines: string[], from = 0) {
  let live = 0, hist = false;
  const arms: number[] = [];
  lines.forEach((line, at) => {
    if (/^arm /.test(line)) { live++; if (at >= from) arms.push(Number(line.slice(4))); } else if (line === "park") live--;
    else if (line === "hist on") hist = true; else if (line === "hist off") hist = false;
  });
  return { live, hist, arms };
}

type Row = { name: string; start: (ctx: Ctx) => Promise<void> };
type Ctx = { call: (args: string[]) => Promise<any>; api: (method: string, path: string, body?: unknown) => Promise<any>; botId: string; chiefId: string };
// one row per start path into serverIdle()'s inputs (SITES.md r3): a direct turn (dispatch claim + bot activity), a room turn (the room's busy
// member, its turn operations + bot activity), a routine run (a live run, onRunLive + its turn)
const ROWS: Row[] = [
  { name: "direct turn", start: async ({ call, botId }) => {
    await call(["send", "--bot", botId, "--text", "Say hello."]);
    expect((await call(["wait", "--bot", botId, "--timeout", "60"])).status).toBe("settled");
  } },
  { name: "room turn", start: async ({ api, botId }) => {
    const room = (await api("POST", "/api/groups", { name: "Watch room", memberIds: [botId], setup: { bulletin: "", defaultResponder: { kind: "member", botId } } })).group as { id: string; threadId: string };
    await api("POST", `/api/groups/${room.id}/messages`, { text: "Say hello to the room.", sendId: "watch_room_123456" });
    await expect.poll(async () => {
      const group = ((await api("GET", "/api/bots?messages=0")).groups as any[]).find(candidate => candidate.id === room.id);
      const replies = ((await api("GET", `/api/threads/${room.threadId}/messages?limit=100`)).messages as any[]).filter(m => m.role === "bot" && m.kind === "text" && m.text);
      return replies.length > 0 && !group?.working && !group?.busyBotId;
    }, { timeout: 60_000, interval: 250 }).toBe(true);
  } },
  // the Chief's hidden proposal turn: a thread with no task or room (index.ts runChiefProposalTurn), owned only by internalTurnOwners
  { name: "chief proposal turn", start: async ({ api }) => {
    const result = await api("POST", "/api/projects/proposal", { purpose: "Write the quarterly report" });
    expect(result.proposal ?? result.reason, JSON.stringify(result)).toBeDefined();
  } },
  { name: "routine run", start: async ({ api, botId }) => {
    const routine = (await api("POST", "/api/routines", { botId, name: "Watch routine", prompt: "Please answer briefly.", schedule: { type: "once", at: Date.now() + 3_600_000 } })).routine as { id: string };
    await api("POST", `/api/routines/${routine.id}/run`, {});
    await expect.poll(async () => ((await api("GET", "/api/routines")).runs as Array<{ routineId: string; status: string }>)
      .filter(run => run.routineId === routine.id).map(run => run.status).join(","), { timeout: 60_000, interval: 250 }).toMatch(/^(completed|failed)$/);
  } },
];

describe("W-WATCH-BOOT on a booted server", () => {
  let session: Awaited<ReturnType<typeof launchVerificationServer>>, ctx: Ctx;
  const probe = () => readFileSync(session.info.logPath, "utf8").split("\n").filter(line => line.startsWith("[watch-probe] ")).map(line => line.slice(14).trim());
  beforeAll(async () => {
    session = await launchVerificationServer(process.env, undefined, { instrumentationSource: PROBE });
    const env = { MURAGE_URL: session.info.url };
    const call = async (args: string[]) => await runControlMurage([...args, "--url", session.info.url], { env }) as any;
    const proof = await (await fetch(`${session.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const api = async (method: string, path: string, body?: unknown) => await (await fetch(`${session.info.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })).json() as any;
    const botId = (await call(["new-bot", "--name", "Watch probe"])).bot.id;
    const models = new Map<string, string>();
    for (const engine of (await api("GET", "/api/instances")).instances) models.set(engine.instanceId, engine.models.options[0]?.id || engine.models.default || "fixture-model");
    const chiefId = (await api("POST", "/api/bots", { name: "Watch chief", modelSelection: { instanceId: "fuigo", model: models.get("fuigo") } })).bot.id as string;
    await api("PATCH", `/api/bots/${chiefId}`, { computer: "off", browser: false, composio: false });
    await api("PATCH", `/api/bots/${chiefId}`, { chiefOfStaff: true, chiefScope: "workspace" });
    ctx = { call, api, botId, chiefId };
  }, 120_000);
  afterAll(async () => { await session?.close(); });

  it("idle after boot: no stall-watch timer, histogram off (H2: the production busy predicate; H1: no idle tick)", async () => {
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const idle = probe();
    console.log(`[W-WATCH-BOOT] idle probe: ${idle.join(" | ")}`);
    // base and an always-busy predicate keep a live observe.ts interval here
    const atIdle = watchState(idle);
    expect({ live: atIdle.live, hist: atIdle.hist }).toEqual({ live: 0, hist: false });
  }, 30_000);

  it.each(ROWS)("$name: parked before, its start arms the fine tick with the histogram, parked again once it settles", async row => {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const before = probe();
    const parked = watchState(before);
    expect({ live: parked.live, hist: parked.hist }, `${row.name}: parked before the start`).toEqual({ live: 0, hist: false });
    await row.start(ctx);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const after = probe();
    console.log(`[W-WATCH-BOOT] ${row.name} probe: ${after.slice(before.length).join(" | ")}`);
    const turn = watchState(after, before.length);
    expect(turn.arms.length, `${row.name}: its start armed the stall watch`).toBeGreaterThanOrEqual(1);
    expect(Math.max(...turn.arms)).toBeLessThanOrEqual(250);
    expect(after.slice(before.length)).toContain("hist on");
    expect({ live: turn.live, hist: turn.hist }, `${row.name}: parked again`).toEqual({ live: 0, hist: false });
  }, 120_000);
});
