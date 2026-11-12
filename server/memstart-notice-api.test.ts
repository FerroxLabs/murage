import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(r.ok, `${method} ${path}: ${r.status}`).toBe(true); return r.json() as Promise<any>;
};
const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=200`)).messages as any[];
const checkingLine = "Murage prepared this reply from your message, with remembered context left out.";

describe("MEMSTART B / T10 real direct and room notice paths", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs = await import('node:fs'); const path = await import('node:path');
      const root = process.env.MURAGE_DATA_DIR;
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, next) {
        if (url.endsWith('/memory/memory-revocation.ts')) {
          const source = fs.readFileSync(new URL(url), 'utf8');
          const anchor = 'export async function settleRevokesForTurn(db: DatabaseSync, maxMs = REDISPATCH_SETTLE_MS): Promise<boolean> {';
          if (!source.includes(anchor)) throw new Error('settle fixture anchor changed');
          return { format: 'module-typescript', shortCircuit: true, source: source.replace(anchor, anchor + 'await globalThis.__memstartSettle?.();') };
        }
        if (!url.endsWith('/server/index.ts')) return next(url, context);
        let source = fs.readFileSync(new URL(url), 'utf8');
        const ledger = 'const memoryRefusalCauses = new MemoryRefusalCauses(TURN_REFUSAL_NOTES_MAX);';
        source = source.replace(ledger, ledger + 'setInterval(() => { try { requireCauseSnapshot(); } catch {} }, 10).unref(); function requireCauseSnapshot() { globalThis.__memstartSnapshot(memoryRefusalCauses.causes.size); }');
        // Preparation now has its own callback. Refuse only the actual write, while retaining its production validation.
        for (const validate of ['validateDirectSubmission', 'validateRoomSubmission']) {
          const anchor = 'submissionBoundary.beforeSubmit(' + validate + ')';
          if (source.split(anchor).length !== 2) throw new Error('submission fixture anchor changed: ' + validate);
          source = source.replace(anchor, 'submissionBoundary.beforeSubmit(() => { globalThis.__memstartRefusal?.(threadId); ' + validate + '(); })');
        }
        return { format: 'module-typescript', shortCircuit: true, source };
      } });
      const { EngineInputRevoked } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/engine-input.ts")).href)});
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const { makeLateTerminalDriver } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      fs.writeFileSync(path.join(root, 'cause-count'), '0');
      globalThis.__memstartSnapshot = size => fs.writeFileSync(path.join(root, 'cause-count'), String(size));
      let settleGate;
      globalThis.__memstartSettle = async () => {
        const gate = settleGate; settleGate = undefined;
        if (!gate) return;
        fs.writeFileSync(gate + '.waiting', '');
        await new Promise(resolve => { const poll = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(poll); resolve(); } }, 10); });
      };
      const pending = new Map();
      globalThis.__memstartRefusal = thread => {
        const kind = pending.get(thread); pending.delete(thread);
        if (!kind) return;
        if (kind === 'stop-rebuild') settleGate = path.join(root, 'settle-' + thread);
        if (kind === 'failed') throw new Error('fixture engine failure');
        if (kind === 'unknown') throw new Error('MEMORY_CONTEXT_REVOKED');
        if (kind === 'frame') throw Object.assign(new Error('MEMORY_CONTEXT_REVOKED'), { unproven: 'memory-frame-checking' });
        if (kind === 'session') throw Object.assign(new Error('MEMORY_CONTEXT_REVOKED'), { unproven: 'lineage-warming' });
        if (kind === 'raw') throw Object.assign(new Error('MEMORY_CONTEXT_REVOKED'), { fence: { state: 'checking', reason: 'lookup-error' } });
        throw new EngineInputRevoked(kind === 'withheld' ? { state: 'withheld', reason: 'deny-line' } : { state: 'checking', reason: 'pending' });
      };
      const driver = makeLateTerminalDriver(); const create = driver.create;
      driver.create = async input => {
        const instance = await create(input); const send = instance.adapter.sendTurn;
        instance.adapter.sendTurn = async turn => {
          const file = path.join(root, 'scenario-' + turn.threadId + '.json');
          const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (settleGate) { const gate=settleGate;settleGate=undefined;fs.writeFileSync(gate+'.waiting','');await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);resolve();}},10);}); }
          const step = scenario.steps.shift(); fs.writeFileSync(file, JSON.stringify(scenario));
          input.environment.FAKE_LATE_HANDBACK = step?.site === 'late' ? '1' : '0';
          if (step?.kind === 'stop') {
            const gate = path.join(root, 'stop-' + turn.threadId);
            fs.writeFileSync(gate + '.waiting', '');
            await new Promise(resolve => { const poll = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(poll); resolve(); } }, 10); });
          } else if (step?.kind) pending.set(turn.threadId, step.kind);
          fs.appendFileSync(path.join(root, 'attempts'), JSON.stringify({ thread: turn.threadId, step, memory: turn.memoryContext !== undefined }) + '\\n');
          return send(turn);
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const pre = path.join(root, 'pre'); fs.writeFileSync(pre, '');
      const file = path.join(root, 'config.json'); const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      cfg.instances.memstart = { driver: 'fakeLateTerminal', displayName: 'Claude', environment: { FAKE_LATE_FENCED_WRITES: '1', FAKE_LATE_PRE_HANDBACK_GATE: pre } };
      fs.writeFileSync(file, JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as any;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    console.warn(`MEMSTART isolated fixture ${JSON.stringify(fixture.info)}`);
  }, 60000);
  afterAll(async () => {
    if (fixture) {
      const log = readFileSync(fixture.info.logPath, "utf8");
      console.warn(`MEMSTART server evidence\n${log}`);
      await fixture.close();
      const settlements = log.split("\n").filter(line => line.includes("[memory] settle outcome="));
      expect(settlements).toEqual([]);
      for (const line of settlements) expect(line.slice(line.indexOf("[memory] settle"))).toMatch(/^\[memory\] settle outcome=(cleared|deadline|budget|error|in-tx) ms=\d+ slices=\d+ activeJobs=-?\d+$/);
    }
  });
  for (const room of [false, true]) for (const [name, causes, sites, ending, expected] of [
    ["setup to late checking", ["pending", "raw", "session"], ["setup", "late", "setup"], "success", checkingLine],
    ["late to setup checking", ["pending", "frame", "pending"], ["late", "setup", "late"], "success", checkingLine],
    ["mixed cause", ["withheld", "pending", "pending"], ["late", "setup", "late"], "success", "Memory changed while Claude was starting, so this reply ran without remembered context."],
    ["unknown cause", ["unknown", "pending", "pending"], ["setup", "late", "setup"], "success", "This reply ran without remembered context."],
    ["failed fallback", ["pending", "pending", "pending"], ["late", "setup", "late"], "failed", undefined],
    ["stopped fallback", ["pending", "pending", "pending"], ["setup", "late", "setup"], "stop", undefined],
  ] as const) it(`${room ? "room" : "direct"}: ${name}`, async () => {
    const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "memstart", model: "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const group = room ? (await api("POST", "/api/groups", { name, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group : undefined;
    const thread = group?.threadId ?? bot.threadId;
    const scenario = join(fixture.info.dataDir, `scenario-${thread}.json`);
    writeFileSync(scenario, JSON.stringify({ steps: [...causes.slice(0, 2).map((kind, i) => ({ kind, site: sites[i] })), { kind: ending === "success" ? undefined : ending, site: "setup" }] }));
    const route = room ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages`;
    await api("POST", route, { threadId: thread, text: `fixture ${name}` });
    if (ending === "stop") {
      const gate = join(fixture.info.dataDir, `stop-${thread}`);
      await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 30000 }).toBe(true);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}); writeFileSync(gate, "");
    }
    await expect.poll(async () => {
      const state = await api("GET", "/api/bots?messages=0");
      return room ? !!state.groups.find((g: any) => g.id === group.id)?.busyBotId : state.bots.find((b: any) => b.id === bot.id)?.busy;
    }, { timeout: 30000 }).toBe(false);
    const rows = await messages(thread);
    console.warn(`MEMSTART transcript ${JSON.stringify({ room, name, rows })}`);
    const notes = rows.filter(m => m.memoryNote === "without-memory");
    expect(notes.map(m => m.tool.name)).toEqual(expected ? [checkingLine] : []);
    const attempts = readFileSync(join(fixture.info.dataDir, "attempts"), "utf8").trim().split("\n").map(s => JSON.parse(s)).filter(a => a.thread === thread);
    expect(attempts).toHaveLength(3); expect(attempts.at(-1).memory).toBe(false);
    expect(rows.filter(m => m.role === "bot" && m.kind === "text" && m.text === "Hello from late")).toHaveLength(expected ? 1 : 0);
    await expect.poll(() => readFileSync(join(fixture.info.dataDir, "cause-count"), "utf8"), { timeout: 5000 }).toBe("0");
    // A separate request on the same member/thread never inherits its previous cause or notice.
    writeFileSync(scenario, JSON.stringify({ steps: [{}] }));
    await api("POST", route, { threadId: thread, text: "a separate request" });
    await expect.poll(async () => (await messages(thread)).filter(m => m.role === "bot" && m.kind === "text" && m.text === "Hello from late").length, { timeout: 30000 }).toBe(expected ? 2 : 1);
    const laterNotes = (await messages(thread)).filter(m => m.memoryNote === "without-memory");
    expect(laterNotes.slice(notes.length).map(m => m.tool.name)).toEqual(["Murage left remembered details out of this reply."]);
    expect(laterNotes).toHaveLength(notes.length + 1);
  }, 90000);
  for (const room of [false, true]) it(`${room ? "room" : "direct"}: cancellation while rebuilding cleans the logical cause`, async () => {
    const bot = (await api("POST", "/api/bots", { name: "Stop during settle", modelSelection: { instanceId: "memstart", model: "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const group = room ? (await api("POST", "/api/groups", { name: "Stop settling", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group : undefined;
    const thread = group?.threadId ?? bot.threadId;
    writeFileSync(join(fixture.info.dataDir, `scenario-${thread}.json`), JSON.stringify({ steps: [{ kind: "stop-rebuild", site: "setup" }] }));
    await api("POST", room ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages`, { threadId: thread, text: "stop inside settle" });
    const gate = join(fixture.info.dataDir, `settle-${thread}`);
    await expect.poll(() => existsSync(gate + ".waiting"), { timeout: 30000 }).toBe(true);
    await api("POST", `/api/bots/${bot.id}/interrupt`, {}); writeFileSync(gate, "");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 30000 }).toBe(false);
    await expect.poll(() => readFileSync(join(fixture.info.dataDir, "cause-count"), "utf8"), { timeout: 5000 }).toBe("0");
    expect((await messages(thread)).filter(m => m.memoryNote === "without-memory")).toEqual([]);
    expect(readFileSync(join(fixture.info.dataDir, "attempts"), "utf8").trim().split("\n").map(s => JSON.parse(s)).filter(a => a.thread === thread)).toHaveLength(2);
  }, 60000);
  it("separate members of the same room keep separate cause histories", async () => {
    const bots = [];
    for (const name of ["Memstart Alder", "Memstart Birch"]) {
      const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "memstart", model: "late-1" } })).bot;
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }); bots.push(bot);
    }
    const group = (await api("POST", "/api/groups", { name: "Separate histories", memberIds: bots.map(b => b.id), setup: { bulletin: "", defaultResponder: { kind: "member", botId: bots[0].id } } })).group;
    for (const [i, bot] of bots.entries()) {
      writeFileSync(join(fixture.info.dataDir, `scenario-${group.threadId}.json`), JSON.stringify({ steps: [
        { kind: i === 0 ? "withheld" : "pending", site: "setup" }, { kind: "pending", site: "late" }, {},
      ] }));
      await api("POST", `/api/groups/${group.id}/messages`, { text: `@${bot.name} answer this request` });
      await expect.poll(async () => (await messages(group.threadId)).filter(m => m.memoryNote === "without-memory").length, { timeout: 30000 }).toBe(i + 1);
      await expect.poll(async () => !!(await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.id === group.id)?.busyBotId, { timeout: 30000 }).toBe(false);
    }
    const notes = (await messages(group.threadId)).filter(m => m.memoryNote === "without-memory");
    expect(notes.map(n => [n.from.botId, n.tool.name])).toEqual([
      [bots[0].id, checkingLine], [bots[1].id, checkingLine],
    ]);
  }, 90000);
});
