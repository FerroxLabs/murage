import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// q1023-leftout W-CUT (MAIN-RULING 2026-11-26T23:34:31Z; owner of both sides: q1023-leftout, rulings: MAIN).
// Banner run 12d08fbe19, turns t0/t1 (and every later turn of those conversations): the word index was not there yet after the upgrade,
// so the owner turn's recall read the reader's own rows inside its time budget and was reported degraded and "missed"
// (search.ts, [memory] recall caller=turn cause=... index=missing). bundle.ts counted that as one omission, so every owner turn carried
// "Murage left remembered details out of this reply." and the server's fence line omitted=1 cause=bundle-fence.
// A recall that ended at memory's own pace withheld nothing it found. Through the real server and real owner turns, with the word index
// not built (the state of the store after the upgrade): the turn still gets what recall found, and nothing is noted as left out.
const LEFT_OUT_NOTES = ["Murage left remembered details out of this reply.", "Murage prepared this reply from your message, with remembered context left out."];
let fixture: VerificationServer, seen: string, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const given = (threadId: string): string[] => existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.threadId === threadId).map(row => String(row.given)) : [];
describe.skipIf(process.platform === "win32")("an owner turn is not noted for a recall cut at memory's own pace (q1023-leftout)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      // what the engine is handed, as the adapter receives it: the turn's own words (with its memory frame) and its replayed transcript
      const driver=makeLateTerminalDriver({ fencedDefaults: true }), create=driver.create, seen=path.join(process.env.MURAGE_DATA_DIR,'leftout-cut-seen');
      driver.create=async function(input){ const instance=await create.call(this,input), send=instance.adapter.sendTurn.bind(instance.adapter);
        instance.adapter.sendTurn=(turn,...rest)=>{ fs.appendFileSync(seen,JSON.stringify({threadId:turn.threadId,given:JSON.stringify([turn.text??null,turn.transcript??null])})+String.fromCharCode(10)); return send(turn,...rest); };
        return instance; };
      BUILT_IN_DRIVERS.push(driver);
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.plain={driver:'fakeLateTerminal',environment:{}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    seen = join(fixture.info.dataDir, "leftout-cut-seen");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });
  it("W-CUT direct owner turn: recall over a store whose word index is not built still recalls, and raises no left-out note or fence omission", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Cold index", modelSelection: { instanceId: "plain", model: "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const threadId = bot.threadId;
    const logFrom = readFileSync(fixture.info.logPath, "utf8").length;
    const turn = async (text: string, n: number) => {
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text });
      await expect.poll(() => given(threadId).length, { timeout: 20000 }).toBe(n);
      await expect.poll(async () => !(await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 20000 }).toBe(true);
    };
    await turn("the lighthouse shutters are painted green", 1);
    // Recall without the word index is a bounded read of the reader's newest rows inside the turn's own budget (best effort by design),
    // so the question is asked up to three times: every one of those turns must be free of the note, and one must have recalled the record.
    let turns = 1, recalled = false;
    while (turns < 4 && !recalled) {
      await turn("what colour are the lighthouse shutters", ++turns);
      recalled = /\(the owner said; source\)[^a-z]{0,8}the lighthouse shutters are painted green/.test(given(threadId)[turns - 1] ?? "");
    }
    const log = readFileSync(fixture.info.logPath, "utf8").slice(logFrom).split("\n");
    // setup proof (not the witness): the word index is not built, and the turn's recall said so itself (degraded, read without the index)
    expect({ index: existsSync(join(fixture.info.dataDir, "memory-index.db")), degraded: log.some(line => /\[memory\] recall caller=turn cause=\S+ outcome=\S+ hits=\d+ ms=\d+ index=(missing|blocked|unreadable)/.test(line)) })
      .toEqual({ index: false, degraded: true });
    const served = log.filter(line => line.includes(threadId));
    const omitted = served.flatMap(line => { const fence = /\[memory\] fence recovery tier=(\d+) .*omitted=(\d+) cause=(\S+)/.exec(line); return fence && Number(fence[2]) > 0 ? [`tier${fence[1]}:${fence[3]}`] : []; });
    const notes = ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[]).map(message => String(message.tool?.name ?? "")).filter(name => LEFT_OUT_NOTES.includes(name));
    // THE WITNESS: no left-out note in the transcript and no fence line that counts an omission (as the banner gate counts them), and
    // a later turn was still handed the record recall found of the first turn's words (the recall is kept, not dropped with its note)
    expect({ notes, omitted, dispatched: served.flatMap(line => /turn dispatch recall=(\S+)/.exec(line)?.[1] ?? []), recalled })
      .toEqual({ notes: [], omitted: [], dispatched: Array(turns).fill("full"), recalled: true });
  }, 90000);
});
