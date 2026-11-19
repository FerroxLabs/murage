// design1019-approval-attention section 5 (H): an app that crashes while a project card run waits on the owner restarts with no
// attention left over. The engine is the fake Claude CLI: its permission fixture asks about one command and then waits for the
// answer, so the card run is genuinely WAITING (board card parked on the owner, bot waiting on you) when the server is killed.
// The restart reads the same data directory; nothing in memory survives, exactly as after a real crash.
import type { ChildProcess } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { waitForExit } from "./testing/cleanup.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const MARKER = "attention-boot-fixture";

interface MessageView { id: string; card?: { tool?: string; routineRequest?: unknown; requestId?: string; requestHandle?: string; answered?: string } }
interface BotView { id: string; threadId: string; busy: boolean; activity?: string }
interface BoardCard { id: string; state: string; waitingOn?: { kind: string } | null; deskThreadId?: string }
interface Server { fixture: VerificationServer; child: ChildProcess; base: string; headers: Record<string, string> }

async function boot(previous?: Server): Promise<Server> {
  chmodSync(FAKE_ACP, 0o755);
  const fixture = previous?.fixture ?? await launchVerificationServer(process.env, undefined, {
    env: {
      FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command: `touch ./${MARKER}` }),
      MURAGE_MODEL_PROVIDER_CONNECTIONS: JSON.stringify([{ id: "image-fixture", preset: "openai", label: "Fixture", enabled: true, key: "offline fixture", revision: "r1" }]),
    } as Record<string, string>,
    instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "attention-boot-probe.mjs")).href)});
      const fs = await import("node:fs");
      const file = (await import("node:path")).join(process.env.MURAGE_DATA_DIR, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.instances.imager = { driver: "grokAgent", environment: { FAKE_ACP_MODE: "project-image", FAKE_ACP_MCP_TIMEOUT_MS: "90000", FAKE_ACP_MCP_READY: "1" }, config: { cli: ${JSON.stringify(FAKE_ACP)}, fullAuto: true } };
      fs.writeFileSync(file, JSON.stringify(config));
    `,
  });
  if (previous) await fixture.restart();
  const base = fixture.info.url;
  const proof = await (await fetch(`${base}/api/desktop-secret`)).json() as { secret: string };
  expect(proof.secret).toMatch(/^[a-f0-9]{64}$/);
  return { fixture, child: fixture.child, base, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } };
}

/** An unclean end: no shutdown step runs, so no retirement, board resume or card patch can happen in this process. */
async function crash(server: Server): Promise<void> {
  if (server.child.exitCode === null && server.child.signalCode === null) await waitForExit(server.child, { signal: "SIGKILL" });
}

const call = async (server: Server, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.base}${path}`, { method, headers: { ...server.headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() as any };
};
const botView = async (server: Server, id: string): Promise<BotView | undefined> =>
  (await call(server, "GET", "/api/bots?messages=0")).body.bots.find((bot: BotView) => bot.id === id);
const messagesOf = async (server: Server, threadId: string): Promise<MessageView[]> =>
  (await call(server, "GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as MessageView[];
const boardCard = async (server: Server, groupId: string, cardId: string): Promise<BoardCard | undefined> =>
  (await call(server, "GET", `/api/groups/${groupId}/board`)).body.cards.find((entry: BoardCard) => entry.id === cardId);

/** The durable card row and its run request, read from the stopped server's database. */
function durable(home: string, cardId: string) {
  const db = new DatabaseSync(join(home, "messages.db"));
  try {
    const card = db.prepare("SELECT state, waiting_on, request_id, revision FROM project_work_items WHERE id=?").get(cardId) as { state: string; waiting_on: string | null; request_id: string | null; revision: number };
    return { card: { ...card, waiting: card.waiting_on ? JSON.parse(card.waiting_on).kind as string : undefined } };
  } finally { db.close(); }
}

/** A WAITING project card run: an Ask bot (no reviewer) runs the one card whose step asks about the fixture command. */
async function waitingCardRun(server: Server, name: string, image = false) {
  const instance = image && (await call(server, "GET", "/api/instances")).body.instances.find((item: { instanceId: string }) => item.instanceId === "imager");
  const modelSelection = image ? { instanceId: "imager", model: instance.models.options[0]?.id || instance.models.default || "fixture-model" } : { instanceId: "verification", model: "claude-sonnet-5" };
  const created = await call(server, "POST", "/api/bots", { name, modelSelection, requireAvailableModel: !image });
  expect(created.status).toBe(201);
  const bot = created.body.bot as BotView;
  expect((await call(server, "PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off", autoApprove: false, autoReview: "off" })).status).toBe(200);
  const made = await call(server, "POST", "/api/groups", { name: `${name} room`, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const groupId = (made.body.group as { id: string }).id;
  expect((await call(server, "PATCH", `/api/groups/${groupId}`, { channelProject: { goal: "Touch one file" } })).status).toBe(200);
  const added = await call(server, "POST", `/api/groups/${groupId}/board/cards`, { clientId: `${name.toLowerCase().replaceAll(" ", "-")}-card`, title: "Touch the file", description: `__fixture_permission_tool__ ${MARKER}`, assigneeBotId: bot.id, writes: false });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const card = added.body.card as BoardCard & { revision: number };
  const started = await call(server, "PATCH", `/api/groups/${groupId}/board/cards/${card.id}`, { expectedRevision: card.revision, action: "start" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  // WAITING: the owner was asked, so the board card is parked on the owner and the bot waits on you.
  await expect.poll(async () => (await boardCard(server, groupId, card.id))?.waitingOn?.kind, { timeout: 30_000 }).toBe("owner_approval");
  await expect.poll(async () => (await botView(server, bot.id))?.activity, { timeout: 10_000 }).toBe("waiting-on-you");
  const desk = (await boardCard(server, groupId, card.id))!.deskThreadId!;
  const approval = (await messagesOf(server, desk)).find(message => (image ? message.card?.tool === "generate_image" : message.card?.requestHandle) && !message.card!.answered);
  expect(approval, "the open approval card").toBeTruthy();
  return { bot, groupId, cardId: card.id, desk, approvalId: approval!.id };
}

/** The safe terminal outcome after a crash: the old approval closed without being allowed, the board card on the restart wait
 * (Retry or Skip, not on the owner, not a Stop), the bot not waiting on you and not busy. */
async function expectRecovered(server: Server, run: Awaited<ReturnType<typeof waitingCardRun>>) {
  await expect.poll(async () => (await boardCard(server, run.groupId, run.cardId))?.waitingOn?.kind, { timeout: 20_000 }).toBe("restart");
  expect((await boardCard(server, run.groupId, run.cardId))?.state).toBe("waiting");
  await expect.poll(async () => (await messagesOf(server, run.desk)).find(message => message.id === run.approvalId)?.card?.answered, { timeout: 20_000 }).toBeTruthy();
  const answered = (await messagesOf(server, run.desk)).find(message => message.id === run.approvalId)!.card!.answered!;
  expect(answered, "the dead run's permission was never delivered as an Allow").not.toMatch(/^(Allowed|Approved)$/);
  const bot = await botView(server, run.bot.id);
  expect(bot?.activity).not.toBe("waiting-on-you");
  expect(bot?.busy).toBe(false);
  return answered;
}

interface Probe {
  current?: string;
  message?: string;
  stats: { waits: number; holds: number; cards: number };
  entries: Array<{ generation: string; message: string; accepting: boolean; state?: string }>;
}
function probe(server: Server, operation: string, threadId: string, requestId?: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    server.child.once("message", value => {
      const reply = value as unknown as Probe & { error?: string };
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply);
    });
    server.child.send({ operation, threadId, requestId }, error => { if (error) reject(error); });
  });
}

describe("approval attention after a crash and restart", () => {
  it("W28 crash recovery releases old attention without replaying permission", async () => {
    let server: Server | undefined;
    try {
      server = await boot(server);
      const run = await waitingCardRun(server, "Crashed while waiting");
      const service = await waitingCardRun(server, "Image waiting", true);
      await crash(server);
      // The dead process left its owner wait saved on the board card.
      expect(durable(server.fixture.info.dataDir, run.cardId).card).toMatchObject({ state: "waiting", waiting: "owner_approval" });
      server = await boot(server);
      const answered = await expectRecovered(server, run);
      const closed = await expectRecovered(server, service);
      expect(closed).toMatch(/expired|cancelled|unavailable/i);
      expect((await probe(server, "inspect", run.desk)).stats).toMatchObject({ holds: 0, waits: 0 });
      // Repeated recovery (a second unclean restart) changes nothing: same card row, same closed approval, no new owner wait.
      await crash(server);
      const db = new DatabaseSync(join(server.fixture.info.dataDir, "messages.db"));
      try {
        expect(db.prepare("SELECT state, delivery, answer_id FROM approval_records WHERE chat_message_id=?").get(run.approvalId))
          .toMatchObject({ state: "expired", delivery: "none", answer_id: null });
      } finally { db.close(); }
      const first = durable(server.fixture.info.dataDir, run.cardId).card;
      expect(first).toMatchObject({ state: "waiting", waiting: "restart", request_id: null });
      server = await boot(server);
      expect(await expectRecovered(server, run)).toBe(answered);
      expect(await expectRecovered(server, service)).toBe(closed);
      await crash(server);
      expect(durable(server.fixture.info.dataDir, run.cardId).card).toEqual(first);
    } finally { await server?.fixture.close(); }
  }, 240_000);

  it("W29 crash during retirement repairs partial durable effects", async () => {
    let server: Server | undefined;
    try {
      server = await boot(server);
      const run = await waitingCardRun(server, "Crashed while retiring");
      // Interrupt the actual board write while the coordinator fences this generation and releases its waits.
      const disk = new DatabaseSync(join(server.fixture.info.dataDir, "messages.db"));
      try {
        disk.exec("CREATE TRIGGER hold_board BEFORE UPDATE ON project_work_items WHEN OLD.state='waiting' AND NEW.state='doing' BEGIN SELECT RAISE(ABORT,'fixture board write interrupted'); END");
        const retiring = await probe(server, "retire", run.desk);
        expect(retiring.entries).toHaveLength(1);
        expect(retiring.entries[0].accepting).toBe(false);
        expect(retiring.stats.waits).toBe(0);
        expect((await boardCard(server, run.groupId, run.cardId))?.waitingOn?.kind).toBe("owner_approval");
        await crash(server);
        disk.exec("DROP TRIGGER hold_board");
      } finally { disk.close(); }
      // The crash window of a retirement: the run's request reached its terminal record (fence and flag release are process-local
      // and died with the process), but the board card cleanup never ran, so the card still says it waits on the owner.
      const saved = durable(server.fixture.info.dataDir, run.cardId).card;
      expect(saved).toMatchObject({ state: "waiting", waiting: "owner_approval" });
      expect(saved.request_id).toBeTruthy();
      const db = new DatabaseSync(join(server.fixture.info.dataDir, "messages.db"));
      try { expect(db.prepare("UPDATE room_requests SET state='cancelled', finished_at=?, waiting_since=NULL WHERE id=? AND state IN ('running','waiting_owner')").run(Date.now(), saved.request_id).changes).toBe(1); }
      finally { db.close(); }
      server = await boot(server);
      // Same safe outcome as W28: the saved owner wait is not proof of a live old generation, and no Stop is invented.
      const answered = await expectRecovered(server, run);
      expect((await boardCard(server, run.groupId, run.cardId))?.waitingOn?.kind).not.toBe("stopped");
      await crash(server);
      const first = durable(server.fixture.info.dataDir, run.cardId).card;
      expect(first).toMatchObject({ state: "waiting", waiting: "restart", request_id: null });
      server = await boot(server);
      expect(await expectRecovered(server, run)).toBe(answered);
      await crash(server);
      expect(durable(server.fixture.info.dataDir, run.cardId).card).toEqual(first);
    } finally { await server?.fixture.close(); }
  }, 240_000);
  it("an unbound engine resolution leaves the live card and its execution wait alone", async () => {
    let server: Server | undefined;
    try {
      server = await boot(server);
      const run = await waitingCardRun(server, "Unbound resolution");
      const card = (await messagesOf(server, run.desk)).find(row => row.id === run.approvalId)!.card!;
      const db = new DatabaseSync(join(server.fixture.info.dataDir, "messages.db"), { readOnly: true });
      let requestId: string;
      try { requestId = db.prepare("SELECT request_id FROM approval_records WHERE chat_message_id=?").get(run.approvalId)!.request_id as string; }
      finally { db.close(); }
      const before = await probe(server, "inspect", run.desk, requestId);
      expect(before.message).toBe(run.approvalId);
      expect(before.stats.waits).toBeGreaterThan(0);
      expect(await probe(server, "unbound", run.desk, requestId)).toEqual(before);
      expect((await messagesOf(server, run.desk)).find(row => row.id === run.approvalId)?.card).toEqual(card);
      const bound = await probe(server, "bound", run.desk, requestId);
      expect(bound.stats.waits).toBe(0);
      expect(bound.message).toBeUndefined();
      expect(bound.entries[0].state).toBe("SETTLED");
    } finally { await server?.fixture.close(); }
  }, 90_000);

  it("W30 a surviving routine proposal gets fresh scoped attention and keeps its queue authority", async () => {
    let server: Server | undefined;
    try {
      server = await boot(server);
      const modelSelection = { instanceId: "verification", model: "claude-sonnet-5" };
      const made = await call(server, "POST", "/api/bots", { name: "Routine recovery", modelSelection });
      expect(made.status).toBe(201);
      const bot = made.body.bot as BotView;
      const thread = bot.threadId;
      expect((await call(server, "PATCH", `/api/bots/${bot.id}`, { autoReview: "off", autoApprove: false, computer: "off" })).status).toBe(200);
      expect((await call(server, "POST", `/api/bots/${bot.id}/messages`, { threadId: thread, text: "__fixture_hold_authority__" })).status).toBe(202);
      const token = () => {
        try { return withTurnSecrets(JSON.parse(readFileSync(server!.fixture.fixtureDumpPath, "utf8"))).mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN; }
        catch { return undefined; }
      };
      await expect.poll(() => Boolean(token()), { timeout: 30_000 }).toBe(true);
      const proposed = await fetch(server.base + "/api/internal/routine-requests", { method: "POST",
        headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
        body: JSON.stringify({ fromBotId: bot.id, fromThreadId: thread, action: "create", routine: {
          name: "Restart proposal", instructions: "Fixture work", schedule: { type: "interval", everyMinutes: 60 },
        } }) });
      expect(proposed.status).toBe(201);
      const open = (await messagesOf(server, thread)).filter(row => row.card?.routineRequest && !row.card.answered);
      expect(open).toHaveLength(1);
      const row = open[0];
      const old = (await probe(server, "inspect", thread)).current;
      expect(old).toBeTruthy();
      await crash(server);
      let previous = old;
      for (let bootNumber = 0; bootNumber < 2; bootNumber++) {
        server = await boot(server);
        const same = (await messagesOf(server, thread)).filter(message => message.card?.routineRequest && !message.card.answered);
        expect(same.map(message => message.id)).toEqual([row.id]);
        expect(same[0].card?.answered).toBeFalsy();
        const recovered = await probe(server, "inspect", thread);
        expect(recovered.entries).toHaveLength(1);
        const entry = recovered.entries[0];
        expect(entry).toMatchObject({ state: "PRESENTED", message: row.id, accepting: true });
        expect(entry.generation).toBeTruthy();
        expect(entry.generation).not.toBe(previous);
        expect(recovered.stats).toMatchObject({ cards: 1, waits: 0, holds: 0 });
        expect((await botView(server, bot.id))?.busy).toBe(false);
        expect(await probe(server, "recover", thread)).toEqual(recovered);
        previous = entry.generation;
        if (!bootNumber) await crash(server);
      }
      expect((await call(server, "POST", `/api/bots/${bot.id}/messages`, { threadId: thread, text: "__fixture_hold_authority__" })).status).toBe(202);
      await expect.poll(async () => (await probe(server!, "inspect", thread)).entries[0].accepting, { timeout: 10_000 }).toBe(false);
      expect((await messagesOf(server, thread)).find(message => message.id === row.id)?.card?.answered).toBeFalsy();
      const current = (await messagesOf(server, thread)).find(message => message.id === row.id);
      const handle = current?.card?.requestHandle;
      expect(handle).toBe(`p.${row.id}`);
      const deny = await call(server, "POST", `/api/threads/${thread}/respond`, { requestHandle: handle, action: "deny" });
      expect(deny.status, JSON.stringify(deny.body)).toBe(200);
      expect((await messagesOf(server, thread)).find(message => message.id === row.id)?.card?.answered).toMatch(/den/i);
    } finally { await server?.fixture.close(); }
  }, 180_000);

});
