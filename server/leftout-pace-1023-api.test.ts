import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// q1023-leftout W-PACE (MAIN-RULING 2026-11-26T23:34:31Z; owner of both sides: q1023-leftout, rulings: MAIN).
// Banner run 12d08fbe19, turns t2/t3: the owner's turn was refused once at its send, and its rebuild then asked for its own built recall
// view (index.ts awaitRecallViewPublished -> recall-view.ts resolveRecallView). On a large store that build waits on the view build pace,
// so the rebuild ended "recall view not ready" and the reply went out from the message alone, with the left-out note.
// An owner turn's access is issued from the single index (ONEINDEX): there is no view to wait for. Through the real server and the real
// rebuild path, with the view build pace closed for the whole run (no built view can ever be published), the rebuilt turn keeps its
// recall (dispatch recall=full) and is never sent as the last resort (no message-only note).
// The last resort's own line (fence-recovery.ts MESSAGE_ONLY_NOTE). The revoke this test makes between the fences is a real one, so the
// rebuild's own first-tier line ("left remembered details out") is correct here and is not what this witness guards.
const MESSAGE_ONLY_NOTE = "Murage prepared this reply from your message, with remembered context left out.";
let fixture: VerificationServer, gate: string, dump: string, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const rows = () => existsSync(dump) ? readFileSync(dump, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
describe.skipIf(process.platform === "win32")("an owner turn's rebuild never waits on a recall view's build pace (q1023-leftout)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver({ fencedDefaults: true }));
      // The store of the banner run in one line: the view build pace has no room, so a queued view build publishes nothing.
      const views=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/memory/recall-view.ts")).href)});
      views.setRecallBuildPaceForTest(-1e15);
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.twofence={driver:'fakeLateTerminal',environment:{FAKE_LATE_TWO_FENCES:'1',FAKE_LATE_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'leftout-gate'),FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'leftout-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    gate = join(fixture.info.dataDir, "leftout-gate"); dump = join(fixture.info.dataDir, "leftout-dump");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });
  it("W-PACE direct owner turn: refused once at its send, rebuilt with its recall while no view can be built; never the last resort", async () => {
    for (const file of [gate, `${gate}.waiting`, dump]) rmSync(file, { force: true });
    const bot = (await api("POST", "/api/bots", { name: "Pace closed", modelSelection: { instanceId: "twofence", model: "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const threadId = bot.threadId;
    const logFrom = readFileSync(fixture.info.logPath, "utf8").length;
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "answer with what you remember" });
    // the launch fence passed and the engine holds the turn before its prompt's own fence
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
    // a revoke between the fences: the prompt's own fence refuses, the turn is proven unwritten and rebuilt
    await api("PATCH", `/api/bots/${bot.id}`, { section: "Revoke between the fences" });
    writeFileSync(gate, "");
    await expect.poll(() => rows().filter(row => row.threadId === threadId && row.prompt).length, { timeout: 20000 }).toBe(1);
    await expect.poll(async () => !(await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 20000 }).toBe(true);
    const served = readFileSync(fixture.info.logPath, "utf8").slice(logFrom).split("\n").filter(line => line.includes(threadId));
    // MAIN-RULING 2026-11-27T02:36:43Z REMOVAL (q1023-ownerfence, CHANGED-ASSERTIONS.md): this line asserted the owner's turn was refused
    // once at its prompt's own fence and rebuilt. The owner's own direct turn is now sent as built: the revoke between the fences applies
    // from the next turn, so it is never refused and never rebuilt (no view wait can arise either).
    expect(served.filter(line => line.includes("re-preparing ("))).toHaveLength(0);
    const dispatched = served.flatMap(line => /turn dispatch recall=(\S+)/.exec(line)?.[1] ?? []);
    const messages = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    const notes = messages.map(message => String(message.tool?.name ?? "")).filter(name => name === MESSAGE_ONLY_NOTE);
    // THE WITNESS: the rebuilt owner turn went out with its recall, never from the message alone
    expect({ dispatched, notes, viewWait: served.filter(line => line.includes("recall view not ready")).length })
      .toEqual({ dispatched: ["full"], notes: [], viewWait: 0 });
    expect(messages.filter(message => String(message.text ?? message.content ?? "").includes("Hello from late"))).toHaveLength(1);
  }, 60000);
});
