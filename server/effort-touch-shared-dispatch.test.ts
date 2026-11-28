// ACP-EFFORT-PER-MODEL-1024 X6c: the shared-work dispatch origin (POST /api/internal/ask-bot -> startRequestOnOwnThread -> startTurn with
// sharedWorkRun) attaches the durable touch record too. X6b (effort-touch-dispatch.test.ts) proves the owner-chat origin only: a hook removed
// just for shared work leaves X6b green. Real booted server, real Store, real fake ACP process; a Chief of another team asks a shared worker.
// What is asserted: the session that carried the worker's shared-work prompt is recorded "clean" on the worker's shared-work task in the Store's
// own file after Murage restarts, which is the record a later turn of that task reads. Without the hook the driver falls back to its in-process map
// and nothing durable is written. (Not asserted here: a second shared ask resuming that session after a restart.)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer, headers: Record<string, string> = {};
const sleep = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
};
const signIn = async () => {
  const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
};
const dataFile = (name: string) => join(fixture.info.dataDir, name);
async function until<T>(read: () => T | null | undefined | false, what: string, ms = 40_000): Promise<T> {
  for (const started = Date.now(); Date.now() - started < ms; await sleep(150)) { const value = read(); if (value) return value; }
  throw new Error(`timed out waiting for ${what}`);
}
const receipts = () => {
  try { return readFileSync(dataFile("receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, any>); }
  catch { return []; }
};
const thinkingSets = () => receipts().filter(row => row.method === "session/set_config_option" && row.configId === "thinking");
const promptsFor = (tag: string) => receipts().filter(row => row.method === "session/prompt" && String(row.promptText).includes(tag));
/** The asker's turn whose prompt carries `marker`: its comms token, read from the instance's dump history. */
const askerToken = (tag: string, botId: string, marker: string) => {
  let lines: string[];
  try { lines = readFileSync(dataFile(`dumps${tag}.jsonl`), "utf8").split("\n").filter(Boolean); } catch { return null; }
  for (const line of lines) {
    try {
      const env = withTurnSecrets(JSON.parse(line)).mcpConfig.mcpServers.agents.env;
      if (env.MURAGE_BOT_ID === botId && JSON.stringify(JSON.parse(line).prompt ?? "").includes(marker)) return { token: env.MURAGE_COMMS_TOKEN as string, botId, threadId: env.MURAGE_THREAD_ID as string };
    } catch { /* a line being written */ }
  }
  return null;
};

describe.skipIf(process.platform === "win32")("X6c shared-work dispatch attaches the durable effort touch record", () => {
  beforeAll(async () => {
    const cli = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), "testing/fake-custom-acp-models.ts"))}`;
    fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 48_300, span: 90 }, readyTimeoutMs: 90_000, instrumentationSource: `
      const { customAcpSupport: localFixtureHost } = await import(${JSON.stringify(new URL("./drivers/acp/custom.ts", import.meta.url).href)}); localFixtureHost.fluxReach = () => "elsewhere";
      process.env.NODE_ENV = 'test';
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
      const fs = await import('node:fs'); const path = await import('node:path');
      const data = process.env.MURAGE_DATA_DIR; const file = path.join(data, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      cfg.instances.thinking = { driver: 'customAcp', displayName: 'Thinking fixture',
        config: { cli: ${JSON.stringify(cli)}, fullAuto: false },
        environment: { FAKE_CUSTOM_ACP_DIRECTORY: data } };
      const holdEnv = (tag) => ({ FAKE_CLAUDE_DUMP: path.join(data, 'dump' + tag + '.json'), FAKE_CLAUDE_DUMP_EACH_TURN: '1', FAKE_CLAUDE_DUMP_HISTORY: path.join(data, 'dumps' + tag + '.jsonl'), FAKE_CLAUDE_HOLD_MARKER: 'HOLD' + tag, FAKE_CLAUDE_HOLD_GATE: path.join(data, 'gate' + tag), FAKE_CLAUDE_HOLD_SEEN: path.join(data, 'seen' + tag) });
      for (const tag of ['A']) cfg.instances['hold' + tag] = { ...cfg.instances.verification, displayName: 'Hold ' + tag, environment: holdEnv(tag) };
      fs.writeFileSync(file, JSON.stringify(cfg));
    ` });
    await signIn();
  }, 120_000);
  afterAll(async () => {
    for (const tag of ["A"]) { try { writeFileSync(dataFile("gate" + tag), "go"); } catch { /* closing */ } }
    await fixture?.close();
  });

  it("a shared-work ask records the worker session it prompted as clean on the shared-work task", async () => {
    expect((await api("GET", "/api/instances?fresh=1")).status).toBe(200);
    const instances = (await api("GET", "/api/instances")).body.instances as any[];
    const make = async (name: string, section: string, selection: unknown) => {
      const made = await api("POST", "/api/bots", { name, modelSelection: selection });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect((await api("PATCH", `/api/bots/${made.body.bot.id}`, { section, computer: "off", browser: false, composio: false, approvePeerComms: false })).status).toBe(200);
      return made.body.bot as { id: string; threadId: string };
    };
    const asker = await make("Asker One", "Sales", { instanceId: "holdA", model: instances.find(i => i.instanceId === "holdA").models.options[0].id });
    const worker = await make("Worker", "Design", { instanceId: "thinking", model: "glm-5.3" });
    // the worker is shared with every team and the asker is the Chief, so a bot of another section reaches it as shared work
    await fixture.stop();
    const file = dataFile("bots.json"), bots = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(bots.find((b: any) => b.id === worker.id), { sharedWith: { mode: "all", teams: [] }, partitionedAt: Date.now() });
    Object.assign(bots.find((b: any) => b.id === asker.id), { chiefOfStaff: true });
    writeFileSync(file, JSON.stringify(bots));
    await fixture.restart();
    await signIn();

    const routine = await api("POST", "/api/routines", { name: "X6c one", prompt: "HOLDA sweep one", botId: asker.id, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask" });
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);
    expect((await api("POST", `/api/routines/${routine.body.routine.id}/run`)).status).toBe(201);
    const turn = await until(() => askerToken("A", asker.id, "sweep one"), "the asker turn");
    let askReply = "(pending)";
    const asking = fetch(fixture.info.url + "/api/internal/ask-bot", { method: "POST",
      headers: { authorization: `Bearer ${turn.token}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: turn.botId, fromThreadId: turn.threadId, toBotId: worker.id, message: "Do the work. ACPT_ONE" }) })
      .then(async reply => { askReply = `${reply.status} ${(await reply.text()).slice(0, 400)}`; }).catch(error => { askReply = String(error); });
    // the ask answers once the worker's turn settled: the worker was prompted exactly once, as shared work
    await Promise.race([asking, sleep(60_000)]);
    expect(promptsFor("ACPT_ONE").map(row => row.method), `ASK=${askReply}`).toEqual(["session/prompt"]);
    expect(askReply).toMatch(/^200 /);
    const prompt = promptsFor("ACPT_ONE")[0];
    // a restart then leaves only what the Store kept
    writeFileSync(dataFile("gateA"), "go");
    await fixture.restart();
    await signIn();
    const sharedTask = () => (JSON.parse(readFileSync(dataFile("bots.json"), "utf8")).find((b: any) => b.id === worker.id).tasks ?? []).find((task: any) => task.sharedWork);
    const settled = await until(() => { const task = sharedTask(); return task?.resumeCursors?.thinking ? task : null; }, "the shared-work task's saved session", 20_000)
      .catch(error => { throw new Error(`${error.message} ASK=${askReply} WORKER=${JSON.stringify((JSON.parse(readFileSync(dataFile("bots.json"), "utf8")).find((b: any) => b.id === worker.id).tasks ?? []).map((task: any) => ({ shared: Boolean(task.sharedWork), cursors: task.resumeCursors, touch: task.effortTouch })))}`); });
    // the prompt really ran on the shared-work task (not the worker's own chat), on the session that task kept
    expect(settled.resumeCursors.thinking).toBe(prompt.sessionId);
    for (let waited = 0; waited < 5_000 && !sharedTask()?.effortTouch; waited += 150) await sleep(150);
    expect(sharedTask().effortTouch?.thinking?.sessions?.[prompt.sessionId] ?? "(no durable record)").toBe("clean");
    expect(thinkingSets()).toHaveLength(0);
  }, 240_000);
});
