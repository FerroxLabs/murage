import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { prepareFixtureRecall } from "./testing/recall-ready-fixture.ts";

// Row 66 W1b on a booted server: the memory-changed row a reply writes when it ran as the last rebuild after memory changed
// (turnRefusedLine "without-memory", server/memory/dispatch.ts) names no engine. The engine here is displayed as "Claude".
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(r.ok, `${method} ${path}: ${r.status}`).toBe(true); return r.json() as Promise<any>;
};
const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=200`)).messages as any[];
const checkingLine = "Murage prepared this reply from your message, with remembered context left out.";
const changedLine = "This reply went ahead without remembered context after memory changed.";

describe("row 66 W1b memory-changed row through the real direct turn path", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs = await import('node:fs'); const path = await import('node:path');
      const root = process.env.MURAGE_DATA_DIR;
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, next) {
        if (!url.endsWith('/server/index.ts')) return next(url, context);
        let source = fs.readFileSync(new URL(url), 'utf8');
        // Refuse only the actual write at the submission boundary, keeping its production validation.
        for (const validate of ['validateDirectSubmission', 'validateRoomSubmission']) {
          const anchor = 'submissionBoundary.beforeSubmit(' + validate + ')';
          if (source.split(anchor).length !== 2) throw new Error('submission fixture anchor changed: ' + validate);
          source = source.replace(anchor, 'submissionBoundary.beforeSubmit(() => { globalThis.__changedRefusal?.(threadId); ' + validate + '(); })');
        }
        return { format: 'module-typescript', shortCircuit: true, source };
      } });
      await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/recall-ready-preload.mjs")).href)});
      const { EngineInputRevoked } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/engine-input.ts")).href)});
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const { makeLateTerminalDriver } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      const pending = new Set();
      // A withheld verdict (deny-line) is a "changed" memory cause; the rebuild after it runs with no settle wait.
      globalThis.__changedRefusal = thread => { if (!pending.delete(thread)) return; throw new EngineInputRevoked({ state: 'withheld', reason: 'deny-line' }); };
      const driver = makeLateTerminalDriver(); const create = driver.create;
      driver.create = async input => {
        const instance = await create(input); const send = instance.adapter.sendTurn;
        instance.adapter.sendTurn = async turn => {
          const file = path.join(root, 'scenario-' + turn.threadId + '.json');
          const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
          const step = scenario.steps.shift(); fs.writeFileSync(file, JSON.stringify(scenario));
          input.environment.FAKE_LATE_HANDBACK = '0';
          if (step?.refuse) pending.add(turn.threadId);
          fs.appendFileSync(path.join(root, 'attempts'), JSON.stringify({ thread: turn.threadId, step, memory: turn.memoryContext !== undefined }) + '\\n');
          return send(turn);
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const pre = path.join(root, 'pre'); fs.writeFileSync(pre, '');
      const file = path.join(root, 'config.json'); const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      cfg.instances.memchanged = { driver: 'fakeLateTerminal', displayName: 'Claude', environment: { FAKE_LATE_FENCED_WRITES: '1', FAKE_LATE_PRE_HANDBACK_GATE: pre } };
      fs.writeFileSync(file, JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as any;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 60000);
  afterAll(async () => {
    if (fixture) {
      console.warn(`ROW66 W1b server evidence\n${readFileSync(fixture.info.logPath, "utf8")}`);
      await fixture.close();
    }
  });
  // Only the direct turn writes this row (index.ts turnRefusalNotes, kind "without-memory"); a room member's refusal kind comes from
  // submissionRefusalKind, which never returns "without-memory", so rooms have no such row (SITES.md, row 66 round 3).
  it("direct: the last-rebuild reply after memory changed stores the engine-neutral row", async () => {
    const name = "Changed Row Direct";
    const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "memchanged", model: "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const thread = bot.threadId;
    await prepareFixtureRecall(fixture.info.dataDir, bot.id, thread);
    const route = `/api/bots/${bot.id}/messages`;
    const replies = async () => (await messages(thread)).filter(m => m.role === "bot" && m.kind === "text" && m.text === "Hello from late").length;
    // Two owner requests, each refused twice at its send over a withheld (changed) verdict, so each reply runs as the last rebuild with no
    // memory. The first carries the message-only fence line; the second repeats that line, so the fence note stays quiet and the reply's
    // end writes the memory-changed row (index.ts turnRefusalNotes note("without-memory") -> turnRefusedLine).
    for (const [i, text] of ["first request", "second request"].entries()) {
      writeFileSync(join(fixture.info.dataDir, `scenario-${thread}.json`), JSON.stringify({ steps: [{ refuse: true }, { refuse: true }, {}] }));
      await api("POST", route, { threadId: thread, text });
      await expect.poll(replies, { timeout: 60000, interval: 250 }).toBe(i + 1);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 30000 }).toBe(false);
    }
    const attempts = readFileSync(join(fixture.info.dataDir, "attempts"), "utf8").trim().split("\n").map(s => JSON.parse(s)).filter(a => a.thread === thread);
    expect(attempts.map(a => !!a.step?.refuse)).toEqual([true, true, false, true, true, false]);
    const rows = await messages(thread);
    console.warn(`ROW66 W1b transcript ${JSON.stringify(rows)}`);
    const notes = rows.filter(m => m.memoryNote === "without-memory").map(m => m.tool.name);
    // The first reply's fence line, then the second reply's memory-changed row, which names no engine.
    expect(notes).toEqual([checkingLine, changedLine]);
  }, 180000);
});
