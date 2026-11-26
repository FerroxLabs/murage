// 1.0.23 queuedsend: a line steered into a turn that the memory fence then refuses at its send, and that is HELD FOR ITS REBUILD, must
// still be sent: the turn never read it (it wrote nothing). Two rows, one per way the held turn ends:
//   setup: the refusal comes before the engine took the turn (startTurnAdmitting's catch, heldForRebuild, index.ts requeue call there);
//   late:  the engine started the turn and its late write is refused, the terminal event (submission_refused) reaches the terminal fold
//          (foldRuntimeEvent, lateRedispatch + directRuns.holdForRebuild, requeue call at server/index.ts:13793).
// Real server (launchVerificationServer) + the fixture engine with steering (FAKE_LATE_STEER); the line goes in through
// POST /api/bots/:id/messages while the send waits (hold point or session gate), the revoke lands, and the send is refused.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const until = async (probe: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`${what} never happened.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
type Row = { id: "setup" | "late"; instance: string };
const ROWS: Row[] = [{ id: "setup", instance: "qsheld" }, { id: "late", instance: "qslate" }];
const holdFile = (row: Row, n: number) => row.id === "late" ? join(fixture.info.dataDir, `${row.instance}-gate`) : join(fixture.info.dataDir, `${row.instance}-hold-${n}`);
/** the send is waiting: at the engine's hold point (setup), or at its session gate before the late write (late; the gate is taken again per send) */
const waiting = (row: Row, n: number) => existsSync(`${holdFile(row, n)}.waiting`);
const dump = (row: Row): Array<Record<string, any>> => {
  const file = join(fixture.info.dataDir, `${row.instance}-dump`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
/** lets the n-th send of the instance through once it waits at its hold point, landing a revoke on the bot first when asked */
const pass = async (row: Row, n: number, botId?: string, revoke?: string) => {
  await until(() => waiting(row, n), `send ${n} at the hold point`);
  if (botId && revoke) expect((await api("PATCH", `/api/bots/${botId}`, { section: revoke })).status).toBeLessThan(300);
  writeFileSync(holdFile(row, n), "");
};

describe.skipIf(process.platform === "win32")("a line steered into a turn that is refused at its send and held for its rebuild is sent", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const driver=makeLateTerminalDriver();
      // every sendTurn of the instance waits, after its prompt was built and before the engine submits it, for <prefix><n>
      const create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input);
        if(!input.environment.HOLD_PREFIX)return instance;
        const send=instance.adapter.sendTurn.bind(instance.adapter); let n=0;
        instance.adapter.sendTurn=async turn=>{
          const base=path.join(process.env.MURAGE_DATA_DIR,input.environment.HOLD_PREFIX+(++n));
          fs.writeFileSync(base+'.waiting',turn.threadId);
          await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(base))return;clearInterval(poll);resolve();},20);});
          return send(turn);
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const dir=process.env.MURAGE_DATA_DIR;
      const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.qslate={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION:'1',FAKE_LATE_SESSION_GATE:path.join(dir,'qslate-gate'),FAKE_LATE_MEMORY_MCP:'1',FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_STEER:'1',FAKE_LATE_DUMP_FRAME:'1',FAKE_LATE_DUMP:path.join(dir,'qslate-dump')}};
      cfg.instances.qsheld={driver:'fakeLateTerminal',environment:{HOLD_PREFIX:'qsheld-hold-',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_MEMORY_MCP:'1',FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_STEER:'1',FAKE_LATE_DUMP_FRAME:'1',FAKE_LATE_DUMP:path.join(dir,'qsheld-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  for (const row of ROWS) it(`${row.id}: the steered words go back in line when the refused turn is held, and run once as a turn of their own`, async () => {
    const bot = (await api("POST", "/api/bots", { name: `Held steer ${row.id}`, modelSelection: { instanceId: row.instance, model: "late-1" } })).body.bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const typed = `typed into the turn that was refused ${row.id}`;
    // a first answered turn, then the question that will be refused at its send
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "an earlier question" })).status).toBe(202);
    await pass(row, 1);
    await until(async () => (await messages(bot.threadId)).some((m) => m.role === "bot" && m.text === "Hello from late"), "the first reply");
    await until(async () => (await api("GET", `/api/bots/${bot.id}/tasks/${bot.threadId}`)).body.task?.busy === false, "the thread idle");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "the question refused at its send" })).status).toBe(202);
    await until(() => waiting(row, 2), "the question waiting to be written");
    // the line is taken into the running turn (the engine steers), before the engine wrote the question
    const steered = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: typed });
    expect(steered.status, JSON.stringify(steered.body)).toBe(202);
    expect(steered.body.steered, JSON.stringify(steered.body)).toBe(true);
    // the revoke lands and the send is refused: the turn ends refused and is held for its rebuild
    await pass(row, 2, bot.id, `Revoke before the ${row.instance} submission`);
    // every later send (the rebuild, then the steered line's own turn) is let through as it reaches its wait
    let released = 2;
    const pump = setInterval(() => {
      if (row.id === "late") { if (waiting(row, 0) && !existsSync(holdFile(row, 0))) writeFileSync(holdFile(row, 0), ""); return; }
      while (waiting(row, released + 1)) writeFileSync(holdFile(row, ++released), "");
    }, 100);
    const sentWith = () => dump(row).filter((entry) => entry.prompt === true && String(entry.frame ?? "").includes(typed));
    try {
      await expect.poll(() => sentWith().length, { timeout: 30_000, interval: 200, message: "a turn of the engine carried the steered line" }).toBe(1);
      // the question was rebuilt (so the held path ran), and the steered line left the queue and is shown once
      expect(dump(row).filter((entry) => entry.prompt === true && String(entry.frame ?? "").includes("the question refused at its send")).length).toBeGreaterThanOrEqual(1);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(sentWith()).toHaveLength(1);
      const lines = (await messages(bot.threadId)).filter((m) => m.role === "user" && m.text === typed);
      expect(lines).toHaveLength(1);
      expect(lines[0].queued).not.toBe(true);
      // the order: the rebuilt question reached the engine first, the steered line after it (never in front of it, never twice)
      const at = (needle: string) => dump(row).findIndex((entry) => entry.prompt === true && String(entry.frame ?? "").includes(needle));
      expect(at("the question refused at its send")).toBeGreaterThanOrEqual(0);
      expect(at("the question refused at its send")).toBeLessThan(at(typed));
    } finally { clearInterval(pump); }
  }, 240_000);
});
