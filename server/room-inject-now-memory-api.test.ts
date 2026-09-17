// "Inject now" in a channel: a message sent while a member is speaking is
// queued by the server; the composer's inject control stops the room
// (POST /api/groups/:id/interrupt) so the queued words drain at once. With
// memory active, the drained member turn could end as a red
// "error: MEMORY_UNAUTHORIZED" and the queued message was never answered.
//
// One inject never revokes the drained turn. A second room stop does: the
// inject control and the Stop control share one composer slot, so a repeated
// click that lands after the queued message started reaches
// cancelGroupTurnOperations → revokeInternalThread while the drained member
// is inside its memory preparation, and the revoked memory capability
// surfaced as the raw error. Now an inject names the queued messages it is
// for and is a no-op once they have started, and a stop or revocation during
// setup ends quietly (Stop) or as the host-stopped notice (revocation).
//
// Real server, memory active, the repository's fake Claude CLI. The drained
// member is held inside its memory preparation by a fixture hold on the
// engine's session reset (buildMemoryBundleAfterReset awaits it between two
// authority checks).
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { hostStoppedReason } from "../shared/host-stop.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const errorChips = (thread: any[]) => thread.filter(message => typeof message.tool?.name === "string" && message.tool.name.startsWith("error:")).map(message => message.tool.name);
const stoppedNotices = (thread: any[]) => thread.filter(message => message.kind === "activity" && hostStoppedReason(message.tool?.name));
const createBot = async (name: string) => {
  const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "hold").models.options;
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "hold", model: models[0].id } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};

/** A room whose lead is held on one message with a follow-up queued behind
 * it; the inject has run and the drained member is held in memory setup. */
const heldRoomWithQueuedFollowUp = async (label: string) => {
  const lead = await createBot(`${label} lead`), other = await createBot(`${label} other`);
  const createdRoom = await api("POST", "/api/groups", { name: `${label} room`, memberIds: [lead.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
  expect(createdRoom.status).toBe(201);
  const room = createdRoom.body.group as { id: string; threadId: string };
  const dumpFile = join(fixture.info.dataDir, "fake-claude-dump.json");
  /** The fake CLI's pid when its latest prompt contains `needle`. */
  const prompted = (needle: string): number | undefined => {
    if (!existsSync(dumpFile)) return undefined;
    const dump = JSON.parse(readFileSync(dumpFile, "utf8")) as { pid: number; prompt: unknown };
    return JSON.stringify(dump.prompt).includes(needle) ? dump.pid : undefined;
  };
  const release = (pid: number) => writeFileSync(join(fixture.info.dataDir, "finish-fake", String(pid)), "");
  const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
  const resetHold = join(fixture.info.dataDir, "reset-hold");
  for (const suffix of ["", ".armed", ".waiting"]) rmSync(resetHold + suffix, { force: true });

  // An earlier completed turn, so the lead's engine holds a retained session.
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: `${label} warm up` })).status).toBe(202);
  await expect.poll(() => prompted(`${label} warm up`), { timeout: 20000 }).toEqual(expect.any(Number));
  release(prompted(`${label} warm up`)!);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);

  const first = await api("POST", `/api/groups/${room.id}/messages`, { text: `${label} held turn` });
  expect(first.status).toBe(202);
  expect(first.body.queued).toBeUndefined();
  await expect.poll(() => prompted(`${label} held turn`), { timeout: 20000 }).toEqual(expect.any(Number));
  expect((await groupState(room.id)).busyBotId).toBe(lead.id);
  const followUp = `${label} follow-up`;
  const queued = await api("POST", `/api/groups/${room.id}/messages`, { text: followUp });
  expect(queued.status).toBe(202);
  expect(queued.body.queued).toBe(true);
  const queueId = queued.body.queueId as string;

  // The composer's inject: stop the held turn for exactly this queued send.
  writeFileSync(resetHold + ".armed", "");
  expect((await api("POST", `/api/groups/${room.id}/interrupt`, { queueIds: [queueId] })).status).toBe(200);
  await expect.poll(() => existsSync(resetHold + ".waiting"), { timeout: 20000 }).toBe(true);
  const drained = (await messages(room.threadId)).find(message => message.role === "user" && message.text === followUp);
  expect(drained?.queueId).toBe(queueId);
  return { lead, room, followUp, queueId, drainedId: drained!.id as string, prompted, release, idle, releasePreparation: () => writeFileSync(resetHold, "") };
};

/** A room stop records a memory settlement keyed by the thread's active leaf. */
const groupStopSettlements = (threadId: string): string[] => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT turn_id FROM memory_sources WHERE thread_id=? AND turn_id LIKE 'group-stop:%'").all(threadId).map(row => String((row as { turn_id: string }).turn_id)); }
  finally { db.close(); }
};

posixOnly("channel inject-now with memory active", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 44_000, span: 900 },
      instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const dataDir=process.env.MURAGE_DATA_DIR;
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      // Held turns (released per CLI pid through finish-fake/<pid>), a slow
      // close after Stop like the real CLI, and one prompt dump per turn.
      cfg.instances.hold={driver:'claudeAgent',displayName:'Hold fixture',config:{cli:${JSON.stringify(join(SERVER_DIR, "testing", "fake-claude-cli.ts"))}},
        environment:{FAKE_CLAUDE_MODE:'hang',FAKE_CLAUDE_DUMP_EACH_TURN:'1',FAKE_CLAUDE_SIGTERM_DELAY_MS:'1000'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
      // Fixture hold inside the drained member's memory preparation: the
      // engine's session reset, one-shot while <reset-hold>.armed exists,
      // released by <reset-hold>.
      const { ClaudeDriver } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "drivers", "claude.ts")).href)});
      const resetHold=path.join(dataDir,'reset-hold');
      const create=ClaudeDriver.create;
      ClaudeDriver.create=async function(input){
        const instance=await create.call(this,input);
        const reset=instance.adapter.resetSession.bind(instance.adapter);
        instance.adapter.resetSession=async threadId=>{
          if(fs.existsSync(resetHold+'.armed')){
            fs.rmSync(resetHold+'.armed',{force:true});fs.writeFileSync(resetHold+'.waiting',threadId);
            await new Promise(resolve=>{const poll=setInterval(()=>{if(!fs.existsSync(resetHold))return;clearInterval(poll);resolve();},20);});
          }
          return reset(threadId);
        };
        return instance;
      };
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("one inject stops the held turn and the queued message is dispatched and settles", async () => {
    const turn = await heldRoomWithQueuedFollowUp("Inject once");
    // Well past the stopped child's close: nothing else revokes the drained turn.
    await new Promise(resolve => setTimeout(resolve, 2500));
    turn.releasePreparation();
    await expect.poll(() => turn.prompted(turn.followUp), { timeout: 20000 }).toEqual(expect.any(Number));
    turn.release(turn.prompted(turn.followUp)!);
    await expect.poll(turn.idle, { timeout: 20000 }).toBe(true);
    const thread = await messages(turn.room.threadId);
    expect(errorChips(thread)).toEqual([]);
    expect(stoppedNotices(thread)).toEqual([]);
    expect(groupStopSettlements(turn.room.threadId)).not.toContain(`group-stop:${turn.drainedId}`);
  }, 90000);

  it("a repeated inject that lands after the queued message started does not stop it", async () => {
    const turn = await heldRoomWithQueuedFollowUp("Inject twice");
    expect((await api("POST", `/api/groups/${turn.room.id}/interrupt`, { queueIds: [turn.queueId] })).status).toBe(200);
    turn.releasePreparation();
    await expect.poll(() => turn.prompted(turn.followUp), { timeout: 20000 }).toEqual(expect.any(Number));
    expect((await groupState(turn.room.id)).busyBotId).toBe(turn.lead.id);
    turn.release(turn.prompted(turn.followUp)!);
    await expect.poll(turn.idle, { timeout: 20000 }).toBe(true);
    const thread = await messages(turn.room.threadId);
    expect(errorChips(thread)).toEqual([]);
    expect(stoppedNotices(thread)).toEqual([]);
    expect(groupStopSettlements(turn.room.threadId)).not.toContain(`group-stop:${turn.drainedId}`);
  }, 90000);

  it("a Stop that lands while the drained member prepares memory ends without an error card", async () => {
    const turn = await heldRoomWithQueuedFollowUp("Stop during setup");
    expect((await api("POST", `/api/groups/${turn.room.id}/interrupt`, {})).status).toBe(200);
    // The settlement a second room stop leaves behind (keyed by the drained message).
    expect(groupStopSettlements(turn.room.threadId)).toContain(`group-stop:${turn.drainedId}`);
    turn.releasePreparation();
    await expect.poll(turn.idle, { timeout: 20000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(errorChips(await messages(turn.room.threadId))).toEqual([]);
    expect(turn.prompted(turn.followUp)).toBeUndefined();
    // and the room answers the next message.
    expect((await api("POST", `/api/groups/${turn.room.id}/messages`, { text: "Stop during setup next" })).status).toBe(202);
    await expect.poll(() => turn.prompted("Stop during setup next"), { timeout: 20000 }).toEqual(expect.any(Number));
    turn.release(turn.prompted("Stop during setup next")!);
    await expect.poll(turn.idle, { timeout: 20000 }).toBe(true);
    expect(errorChips(await messages(turn.room.threadId))).toEqual([]);
  }, 90000);

  it("an access change while the drained member prepares memory ends as the host-stopped notice", async () => {
    const turn = await heldRoomWithQueuedFollowUp("Revoked setup");
    const view = await api("GET", `/api/bots/${turn.lead.id}/access`);
    expect(view.status).toBe(200);
    expect((await api("PUT", `/api/bots/${turn.lead.id}/access`, { action: "configure", revision: view.body.policy.revision, mode: "unrestricted", allowWrites: true, grants: [] })).status).toBe(200);
    turn.releasePreparation();
    await expect.poll(turn.idle, { timeout: 20000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    const thread = await messages(turn.room.threadId);
    expect(errorChips(thread)).toEqual([]);
    const notices = stoppedNotices(thread);
    expect(notices).toHaveLength(1);
    expect(notices[0].from?.botId).toBe(turn.lead.id);
    expect(hostStoppedReason(notices[0].tool.name)).toBe("the bot's settings or access changed while its turn was being set up, so it was not started");
    expect(turn.prompted(turn.followUp)).toBeUndefined();
  }, 90000);
});
