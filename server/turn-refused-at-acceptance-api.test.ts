// Regression for 727db85f (Q1-T5 §3.3): a turn refused at acceptance must not
// leak the workspace writer lease. The memory disclosure is delivered inside
// guardTurnDispatch's acceptance hook, after the provider has accepted the
// turn; when it is refused there (MEMORY_CONTEXT_REVOKED) the provider turn is
// stopped and the harness rethrows. The writer lease is already marked
// dispatched, so abandon() keeps it by design and only the stopped turn's
// terminal event can release it — which needs the lease bound to that
// provider turn id BEFORE the hook can throw. Unbound, every owner save in
// the bot's workspace answered 423 until restart.
//
// Deterministic through the real server: the fake pi engine holds its session
// handshake (FAKE_PI_SESSION_GATE) so the harness has called sendTurn but the
// provider has not accepted; creating a second bot then moves the memory
// policy revision; releasing the gate lets acceptance refuse the turn.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, gate: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const dumpRows = (): any[] => { const file = join(fixture.info.dataDir, "pi-dump.jsonl"); return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; };

posixOnly("a turn refused at acceptance releases the workspace writer lease", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piGate={driver:'piAgent',displayName:'Gated pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'pi-session-gate'),FAKE_PI_DUMP:path.join(process.env.MURAGE_DATA_DIR,'pi-dump.jsonl')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    gate = join(fixture.info.dataDir, "pi-session-gate");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("answers the owner's save with 200, not 423, after the refused turn", async () => {
    // A fresh installation runs memory active, so the turn goes through the
    // memory dispatch preparation and its acceptance-time disclosure.
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "piGate").models.options;
    const created = await api("POST", "/api/bots", { name: "Lease fixture", modelSelection: { instanceId: "piGate", model: models[0].id } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);

    // The harness has called sendTurn; the provider turn is not accepted yet.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "hold at the session handshake" })).status).toBe(202);
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
    expect((await botState(bot.id)).busy).toBe(true);
    // Inside that window the roster changes: the memory policy revision moves
    // and the prepared disclosure is no longer current.
    expect((await api("POST", "/api/bots", { name: "Roster change during dispatch", modelSelection: { instanceId: "piGate", model: models[0].id } })).status).toBe(201);
    writeFileSync(gate, "");

    // Acceptance refuses the turn; the stopped provider turn settles the bot.
    await expect.poll(async () => (await messages(bot.threadId)).some(message => typeof message.tool?.name === "string" && message.tool.name.includes("MEMORY_CONTEXT_REVOKED")), { timeout: 15000 }).toBe(true);
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 15000 }).toBe(false);
    // The handshake was answered, so the provider had accepted before the refusal.
    expect(dumpRows().some(row => row.setModel !== undefined || row.prompt !== undefined || row.thinkingLevel !== undefined)).toBe(true);

    // The owner's save over an existing file in that bot's workspace is
    // admitted: the refused turn released its writer lease through its
    // terminal event. (An exclusive create takes no restore lease, so the
    // note is created first and then saved over with its read revision —
    // the save the joined scenario found refused with 423.)
    const scope = { botId: bot.id, threadId: bot.threadId };
    const note = await api("POST", "/api/workspace-files/write", { scope, relativePath: "owner-note.md", baseRevision: null, requestId: "create-note", content: "# Owner note\n", bom: false });
    expect(note.status).toBe(200);
    const read = await api("GET", `/api/workspace-files/read?botId=${bot.id}&threadId=${bot.threadId}&path=owner-note.md`);
    expect(read.status).toBe(200);
    expect(read.body.content).toBe("# Owner note\n");
    const write = await api("POST", "/api/workspace-files/write", { scope, relativePath: "owner-note.md", baseRevision: read.body.revision, requestId: "after-refused-turn", content: "# Owner note\n\nEdited after the refused turn.\n", bom: false });
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({ requestId: "after-refused-turn", previousRevision: read.body.revision });
    const reread = await api("GET", `/api/workspace-files/read?botId=${bot.id}&threadId=${bot.threadId}&path=owner-note.md`);
    expect(reread.body.content).toBe("# Owner note\n\nEdited after the refused turn.\n");
    // and the folder is truly free: a later turn on the same thread runs to a reply.
    const replies = async () => (await messages(bot.threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text).length;
    const repliesBefore = await replies();
    rmSync(`${gate}.waiting`, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "runs after the refused turn" })).status).toBe(202);
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 15000 }).toBe(false);
    expect(await replies()).toBe(repliesBefore + 1);
  }, 60000);
});
