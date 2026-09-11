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
import { DatabaseSync } from "node:sqlite";
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

    // Acceptance refuses the turn and the provider turn is stopped. Since
    // RED2G-3 the harness then re-prepares the context under the moved
    // authority and dispatches the same user message once more, so the person
    // sees a reply, not "error: MEMORY_CONTEXT_REVOKED"; the refused attempt
    // still happened (the server log names it) and its lease must still go.
    const replies = async () => (await messages(bot.threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text).length;
    const repliesBefore = await replies();
    await expect.poll(() => readFileSync(fixture.info.logPath, "utf8").includes(`[memory] context revoked during dispatch on thread ${bot.threadId}`), { timeout: 15000 }).toBe(true);
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 15000 }).toBe(false);
    await expect.poll(async () => await replies(), { timeout: 15000 }).toBe(repliesBefore + 1);
    expect((await messages(bot.threadId)).some(message => typeof message.tool?.name === "string" && message.tool.name.includes("MEMORY_CONTEXT_REVOKED"))).toBe(false);
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
    const repliesAfterRefusal = await replies();
    rmSync(`${gate}.waiting`, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "runs after the refused turn" })).status).toBe(202);
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 15000 }).toBe(false);
    expect(await replies()).toBe(repliesAfterRefusal + 1);
  }, 60000);

  // RED2G-3 (RED2B verifier): creating a task for a bot while a sibling turn
  // sits in its dispatch window changes the bot's thread set, which the roster
  // policy treats as a revocation (p02 "existing-task" still revokes), so the
  // sibling turn is refused at acceptance. p02 holds — the refused provider
  // turn is stopped — but the person's message must not be lost: the harness
  // re-prepares the memory context under the new policy revision and
  // dispatches the same user message once.
  it("runs a user turn whose sibling task was created inside the dispatch window, on fresh memory context", async () => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "piGate").models.options;
    const created = await api("POST", "/api/bots", { name: "Sibling task fixture", modelSelection: { instanceId: "piGate", model: models[0].id } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      const policyRevision = () => Number((db.prepare("SELECT policy_revision FROM memory_meta WHERE id=1").get() as { policy_revision: number }).policy_revision);
      const disclosures = () => db.prepare("SELECT state,policy_revision FROM memory_disclosures WHERE thread_id=? ORDER BY created_at").all(bot.threadId) as Array<{ state: string; policy_revision: number }>;
      const replies = async () => (await messages(bot.threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text);

      // The turn is held at the provider handshake: dispatched, not accepted.
      rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
      // (a new bot greets its thread with one bot text before any turn)
      const repliesBefore = (await replies()).length;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "sibling turn held in its dispatch window" })).status).toBe(202);
      await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
      expect((await botState(bot.id)).busy).toBe(true);
      const revisionAtDispatch = policyRevision();
      expect(disclosures()).toEqual([{ state: "prepared", policy_revision: revisionAtDispatch }]);

      // A task created for the same bot inside that window moves the policy
      // revision and revokes the prepared disclosure.
      const task = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Created mid-dispatch" });
      expect(task.status).toBe(201);
      expect(task.body.task).toMatchObject({ title: "Created mid-dispatch", busy: false });
      expect(task.body.task.threadId).not.toBe(bot.threadId);
      expect(policyRevision()).toBeGreaterThan(revisionAtDispatch);
      expect(disclosures()).toEqual([{ state: "revoked", policy_revision: revisionAtDispatch }]);
      writeFileSync(gate, "");

      // Acceptance refuses the held turn; the same user message is dispatched
      // again under the moved authority and runs to its reply.
      await expect.poll(() => readFileSync(fixture.info.logPath, "utf8").includes(`[memory] context revoked during dispatch on thread ${bot.threadId}`), { timeout: 15000 }).toBe(true);
      await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 20000 }).toBe(false);
      await expect.poll(async () => (await replies()).length, { timeout: 15000 }).toBe(repliesBefore + 1);
      const thread = await messages(bot.threadId);
      expect(thread.filter(message => message.role === "user" && message.kind === "text").map(message => message.text)).toEqual(["sibling turn held in its dispatch window"]);
      expect((await replies()).at(-1)?.text).toBe("Hello from pi");
      expect(thread.some(message => typeof message.tool?.name === "string" && message.tool.name.startsWith("error:"))).toBe(false);
      expect(thread.some(message => typeof message.tool?.name === "string" && message.tool.name.includes("MEMORY_CONTEXT_REVOKED"))).toBe(false);
      // The reply ran on a disclosure prepared and delivered under the new
      // revision; the one prepared before the task existed stayed revoked.
      expect(disclosures()).toEqual([
        { state: "revoked", policy_revision: revisionAtDispatch },
        { state: "delivered", policy_revision: policyRevision() },
      ]);
      // The sibling task is admitted and untouched by the turn.
      const current = await botState(bot.id);
      expect(current.tasks.find((candidate: any) => candidate.threadId === task.body.task.threadId)).toMatchObject({ title: "Created mid-dispatch", busy: false });
    } finally { db.close(); }
  }, 90000);

  // Q1-T5 §4.1 through the real server: the memory worker finishes capturing
  // the turn's own prompt inside the dispatch window, which rolls the
  // thread's checkpoint that the bundle selected. That is staleness, not
  // revocation (server/memory/bundle.ts supersededThreadCheckpoint): the
  // accepted turn runs to its reply instead of ending with
  // "error: MEMORY_CONTEXT_REVOKED".
  it("runs a turn whose own prompt capture rolls the thread checkpoint inside the dispatch window", async () => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "piGate").models.options;
    const created = await api("POST", "/api/bots", { name: "Checkpoint roll fixture", modelSelection: { instanceId: "piGate", model: models[0].id } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      const checkpoint = () => db.prepare("SELECT r.id,r.version,r.state FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='checkpoint' AND s.kind='conversation' AND s.owner_key=? ORDER BY r.version DESC LIMIT 1").get(bot.threadId) as { id: string; version: number; state: string } | undefined;
      const pendingJobs = () => Number((db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status NOT IN ('complete','cancelled','failed')").get() as { n: number }).n);
      const replies = async () => (await messages(bot.threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text).length;
      const revoked = async () => (await messages(bot.threadId)).some(message => typeof message.tool?.name === "string" && message.tool.name.includes("MEMORY_CONTEXT_REVOKED"));

      // A first, ungated turn gives the thread a checkpoint; wait for the
      // worker to settle so the next bundle selects a stable version.
      writeFileSync(gate, "");
      const before = await replies();
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "first turn, captured into the thread checkpoint" })).status).toBe(202);
      await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 15000 }).toBe(false);
      await expect.poll(async () => await replies(), { timeout: 15000 }).toBe(before + 1);
      await expect.poll(() => checkpoint()?.state, { timeout: 20000 }).toBe("active");
      await expect.poll(() => pendingJobs(), { timeout: 20000 }).toBe(0);
      const selected = checkpoint()!;

      // The second turn is held at the provider handshake, after the bundle
      // selected `selected`; its own prompt capture completes meanwhile.
      rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "second turn, whose own capture rolls the checkpoint" })).status).toBe(202);
      await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
      await expect.poll(() => checkpoint()?.version, { timeout: 20000 }).toBeGreaterThan(selected.version);
      expect(db.prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(selected.id, selected.version)).toMatchObject({ state: "archived" });
      writeFileSync(gate, "");

      // Accepted and run to a reply; nothing revoked.
      await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 20000 }).toBe(false);
      expect(await revoked()).toBe(false);
      expect(await replies()).toBe(before + 2);
    } finally { db.close(); }
  }, 90000);
});
