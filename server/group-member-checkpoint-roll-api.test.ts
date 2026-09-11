// RED2E follow-up to Q1-T5 §4.1 (server/turn-refused-at-acceptance-api.test.ts)
// for group chats: the checkpoint of a group thread rolls on every captured
// message in that thread, a member bot's own prompt and reply included. When
// the memory worker finishes that capture inside the member's dispatch
// window, the version its bundle selected is archived with a newer active
// successor — staleness, not revocation (server/memory/bundle.ts
// supersededThreadCheckpoint): the member turn runs to its reply instead of
// ending with "error: MEMORY_CONTEXT_REVOKED", and that reply stays
// replayable for the next member turn.
//
// Deterministic through the real server: the fake pi engine holds its session
// handshake (FAKE_PI_SESSION_GATE) after the bundle selected the checkpoint,
// and the worker rolls the checkpoint before the gate is released.
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
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const dumpRows = (): any[] => { const file = join(fixture.info.dataDir, "pi-dump.jsonl"); return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; };

posixOnly("a group member's turn survives its own capture rolling the group checkpoint", () => {
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

  it("runs the member turn to a reply and keeps that reply replayable", async () => {
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "piGate").models.options;
    const bot = async (name: string) => {
      const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "piGate", model: models[0].id } });
      expect(created.status).toBe(201);
      const bot = created.body.bot as { id: string; threadId: string };
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
      return bot;
    };
    const member = await bot("Member A"), other = await bot("Member B");
    const created = await api("POST", "/api/groups", { name: "Checkpoint roll room", memberIds: [member.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
    expect(created.status).toBe(201);
    const room = created.body.group as { id: string; threadId: string };
    expect(room.threadId).not.toBe(member.threadId);

    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      const checkpoint = () => db.prepare("SELECT r.id,r.version,r.state FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='checkpoint' AND s.kind='conversation' AND s.owner_key=? ORDER BY r.version DESC LIMIT 1").get(room.threadId) as { id: string; version: number; state: string } | undefined;
      // Only the group thread's captures move its checkpoint; a bot thread's
      // welcome-message capture can still hold a worker lease and is not waited on.
      const pendingJobs = () => Number((db.prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status NOT IN ('complete','cancelled','failed')").get(room.threadId) as { n: number }).n);
      const replies = async () => (await messages(room.threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text);
      const revoked = async () => (await messages(room.threadId)).some(message => typeof message.tool?.name === "string" && message.tool.name.includes("MEMORY_CONTEXT_REVOKED"));
      const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };

      // A first, ungated member turn gives the group thread a checkpoint;
      // wait for the worker to settle so the next bundle selects a stable
      // version.
      writeFileSync(gate, "");
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first turn, captured into the group checkpoint" })).status).toBe(202);
      await expect.poll(idle, { timeout: 15000 }).toBe(true);
      await expect.poll(async () => (await replies()).length, { timeout: 15000 }).toBe(1);
      expect((await replies())[0].from.botId).toBe(member.id);
      await expect.poll(() => checkpoint()?.state, { timeout: 20000 }).toBe("active");
      await expect.poll(() => pendingJobs(), { timeout: 20000 }).toBe(0);
      const selected = checkpoint()!;
      // The checkpoint the bundle selected is the group thread's own
      // (consolidate.ts keys it by the group thread id), not the member's.
      expect(selected.id).not.toBe((db.prepare("SELECT r.id FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='checkpoint' AND s.kind='conversation' AND s.owner_key=?").get(member.threadId) as { id: string } | undefined)?.id);

      // The second member turn is held at the provider handshake, after its
      // bundle selected `selected`; its own prompt capture completes
      // meanwhile and rolls the group checkpoint.
      rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "second turn, whose own capture rolls the group checkpoint" })).status).toBe(202);
      await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
      expect((await groupState(room.id)).busyBotId).toBe(member.id);
      await expect.poll(() => checkpoint()?.version, { timeout: 20000 }).toBeGreaterThan(selected.version);
      expect(db.prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(selected.id, selected.version)).toMatchObject({ state: "archived" });
      const disclosed = db.prepare("SELECT record_versions FROM memory_disclosures WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").get(room.threadId) as { record_versions: string };
      expect(JSON.parse(disclosed.record_versions)).toContainEqual({ id: selected.id, version: selected.version });
      writeFileSync(gate, "");

      // Accepted and run to a reply; nothing revoked.
      await expect.poll(idle, { timeout: 20000 }).toBe(true);
      expect(await revoked()).toBe(false);
      expect((await replies()).length).toBe(2);
      expect(dumpRows().filter(row => row.prompt !== undefined).length).toBeGreaterThanOrEqual(2);
      const disclosure = db.prepare("SELECT state FROM memory_disclosures WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").get(room.threadId) as { state: string };
      expect(disclosure.state).toBe("delivered");

      // The reply's capture rolls the checkpoint again; the next member turn
      // still replays that reply: filterMemoryReplay marks a disclosure it
      // drops as revoked, so the second turn's receipt staying delivered with
      // the reply among its outputs is the replay proof.
      await expect.poll(() => pendingJobs(), { timeout: 20000 }).toBe(0);
      expect(checkpoint()!.version).toBeGreaterThan(selected.version + 1);
      const secondReply = (await replies())[1];
      const secondReceipt = db.prepare("SELECT bundle_id,state,output_message_ids FROM memory_disclosures WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").get(room.threadId) as { bundle_id: string; state: string; output_message_ids: string };
      expect(JSON.parse(secondReceipt.output_message_ids)).toContain(secondReply.id);
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "third turn, replaying the second reply" })).status).toBe(202);
      await expect.poll(idle, { timeout: 20000 }).toBe(true);
      expect(await revoked()).toBe(false);
      expect((await replies()).length).toBe(3);
      expect(db.prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(secondReceipt.bundle_id)).toMatchObject({ state: "delivered" });
    } finally { db.close(); }
  }, 120000);
});
