// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { CloudSessions } from "../cloud-sessions.ts";
import { completeRequest, insertRoomRequest } from "../room-requests.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "../testing/power-block-test.ts";

const origin = "https://home.example.test";
const notice = "Getting Fuigo ready. Your bots run on Fuigo with your Flux credit. This takes a minute or two. You can keep looking around.";
const pending = { id: randomUUID(), threadId: randomUUID(), name: "Pending", modelSelection: { instanceId: "fuigo-fixture", model: "" } };
const chief = { id: randomUUID(), threadId: randomUUID(), name: "Chief", chiefOfStaff: true, chiefScope: "workspace", modelSelection: { instanceId: "fuigo-fixture", model: "" } };
const ready = { id: randomUUID(), threadId: randomUUID(), name: "Ready", modelSelection: { instanceId: "ready-fixture", model: "late-1" } };
// roomsQueue off is the in-memory queue; on (the default) a send that waits is a persisted room request row.
for (const roomsQueue of [false, true]) describe(`pending Fuigo dispatch, roomsQueue ${roomsQueue}`, () => {
  let fixture: VerificationServer;
  let authorization: string;

  async function api(method: string, path: string, body?: unknown) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = request(fixture.info.url + path, { method, headers: {
        host: new URL(origin).host, origin, authorization, "content-type": "application/json",
        ...(encoded ? { "content-length": String(Buffer.byteLength(encoded)) } : {}),
      } }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(encoded);
    });
  }

  type Dispatch = { instanceId: string; threadId: string; model: string };
  function dispatches(threadId: string): Dispatch[] {
    const receipt = join(fixture.info.dataDir, "dispatch.jsonl");
    return existsSync(receipt)
      ? readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line) as Dispatch).filter(turn => turn.threadId === threadId)
      : [];
  }

  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      env: { NODE_ENV: "test" },
      cloud: { publicOrigin: origin, bootstrapSecret: randomBytes(32).toString("hex") },
      instrumentationSource: `
        ${POWER_BLOCK_UNWRAP_SOURCE}
        import { appendFileSync, existsSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        const control = await import(${JSON.stringify(new URL("./control-state-verification.fixture.mjs", import.meta.url).href)});
        control.installVerificationControl(${JSON.stringify(origin)});
        globalThis.__murageVerificationControlInputs.readSnapshot();
        const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL("../drivers/builtIn.ts", import.meta.url).href)});
        const { makeLateTerminalDriver } = await import(${JSON.stringify(new URL("../testing/fake-late-terminal-driver.ts", import.meta.url).href)});
        const driver = makeLateTerminalDriver();
        const data = process.env.MURAGE_DATA_DIR;
        const bots = ${JSON.stringify([pending, ready, chief])}.map(bot => ({
          ...bot, title: "", description: "", resumeCursors: {}, createdAt: Date.now(),
          computer: "off", browser: false, composio: false, autoReview: "off", autoLearning: false,
        }));
        writeFileSync(join(data, "bots.json"), JSON.stringify(bots));
        writeFileSync(join(data, "config.json"), JSON.stringify({
          engineDiscovery: "explicit",
          features: { roomsQueue: ${roomsQueue} },
          instances: {
            "fuigo-fixture": { driver: "fuigoAgent" },
            "ready-fixture": { driver: "fuigoAgent" },
          },
        }));
        // Substitute only the engine transport. Record the actual selection handed to its adapter.
        const index = BUILT_IN_DRIVERS.findIndex(candidate => candidate.driverKind === "fuigoAgent");
        BUILT_IN_DRIVERS[index] = { ...driver, driverKind: "fuigoAgent", async create(input) {
            const instance = await driver.create(input);
            const adapter = {
              ...instance.adapter, provider: "fuigoAgent",
              onEvent(listener) {
                return instance.adapter.onEvent((event, source) => listener({ ...event, provider: "fuigoAgent" }, source));
              },
              async sendTurn(turn) {
                appendFileSync(join(data, "dispatch.jsonl"), JSON.stringify({
                  instanceId: input.instanceId, threadId: turn.threadId, model: turn.model,
                }) + "\\n");
                while (existsSync(join(data, "hold-" + turn.threadId)) && !existsSync(join(data, "release-" + turn.threadId))) {
                  await new Promise(resolve => setTimeout(resolve, 25));
                }
                return instance.adapter.sendTurn(turn);
              },
            };
            return { ...instance, driverKind: "fuigoAgent", adapter };
        }};
      `,
    });
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const sessions = new CloudSessions(db, undefined, origin);
      const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
      const device = randomUUID(), now = Date.now();
      db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','fixture-owner')").run();
      db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)")
        .run(device, "fixture-owner", "owner-desktop", key, key, now, now);
      authorization = `Bearer ${sessions.issue(device).accessToken}`;
      await vi.waitFor(() => expect(db.prepare("SELECT 1 FROM cloud_meta WHERE key='lease-hold'").get()).toBeUndefined(), { timeout: 10_000 });
    } finally { db.close(); }
    const state = await api("GET", "/api/bots?messages=0");
    expect(state.status).toBe(200);
    expect(state.body.bots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pending.id, modelSelection: pending.modelSelection }),
      expect.objectContaining({ id: ready.id, modelSelection: ready.modelSelection }),
    ]));
  }, 120_000);

  afterAll(async () => { await fixture?.close(); });

  async function room() {
    const created = await api("POST", "/api/groups", {
      name: "Dispatch room", memberIds: [pending.id, ready.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.group as { id: string; threadId: string };
  }

  const transcript = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<{
    requestId?: string; text?: string; tool?: { name?: string }; from?: { botId: string };
  }>;
  const sendRoom = (group: { id: string; threadId: string }, text: string, responderId?: string, sendId = randomUUID()) => api("POST", `/api/groups/${group.id}/messages`, {
    threadId: group.threadId, text, mode: "chat", sendId, ...(responderId ? { responderId } : {}),
  });
  const waitIdle = async (group: { id: string }) => expect.poll(async () => {
    const state = (await api("GET", "/api/bots?messages=0")).body.groups.find((item: { id: string }) => item.id === group.id);
    return state && !state.working && !state.busyBotId;
  }, { timeout: 20_000 }).toBe(true);
  const hasNotice = (messages: Awaited<ReturnType<typeof transcript>>) => messages.filter(message => message.tool?.name === notice);

  it("a room send skips the blank Fuigo selection, shows the ready notice, and lets the next member answer", async () => {
    const group = await room();
    expect((await sendRoom(group, "Can both of you answer?")).status).toBe(202);
    await waitIdle(group);
    const turns = dispatches(group.threadId);
    expect(turns, JSON.stringify(await transcript(group.threadId))).toEqual([{ instanceId: ready.modelSelection.instanceId, threadId: group.threadId, model: ready.modelSelection.model }]);
    expect((await transcript(group.threadId)).some(message => message.from?.botId === ready.id && Boolean(message.text))).toBe(true);
    expect(hasNotice(await transcript(group.threadId))).toHaveLength(1);
  }, 35_000);

  it("the room member Retry send shows the ready notice without launching an engine", async () => {
    const group = await room();
    expect((await sendRoom(group, "Retry these words", pending.id)).status).toBe(202);
    await waitIdle(group);
    expect(dispatches(group.threadId), JSON.stringify(await transcript(group.threadId))).toEqual([]);
    expect(hasNotice(await transcript(group.threadId))).toHaveLength(1);
  }, 30_000);

  it("a pinned Retry queued behind another member settles its attempt without invoking Fuigo", async () => {
    const group = await room();
    const sendId = randomUUID();
    const release = join(fixture.info.dataDir, `release-${group.threadId}`);
    writeFileSync(join(fixture.info.dataDir, `hold-${group.threadId}`), "");
    try {
      expect((await sendRoom(group, "Keep this turn open", ready.id)).status).toBe(202);
      await expect.poll(() => dispatches(group.threadId), { timeout: 10_000 }).toHaveLength(1);
      const queued = await sendRoom(group, "Retry from the queue", pending.id, sendId);
      expect(queued).toMatchObject({ status: 202, body: { queued: true } });
    } finally { writeFileSync(release, ""); }
    await expect.poll(async () => hasNotice(await transcript(group.threadId)).length, { timeout: 10_000 }).toBe(1);
    await waitIdle(group);
    expect(dispatches(group.threadId).map(turn => turn.instanceId)).toEqual([ready.modelSelection.instanceId]);
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      if (!roomsQueue) {
        expect(db.prepare("SELECT phase, delivery, terminal_outcome, cleanup_owed FROM send_attempts WHERE send_id=?").get(sendId))
          .toEqual({ phase: "terminal", delivery: "not_submitted", terminal_outcome: "failed", cleanup_owed: 0 });
      } else {
        // the persisted queue: the queued owner_send row is done, and the pending member's own request fails without an attempt row
        const requests = (await api("GET", `/api/groups/${group.id}/requests`)).body.requests as Array<{ verb: string; state: string; toBotId?: string }>;
        expect(requests.filter(item => item.verb === "room_turn" && item.toBotId === pending.id).map(item => item.state)).toEqual(["failed"]);
        expect(requests.filter(item => item.verb === "owner_send").map(item => item.state)).toEqual(["done", "done"]);
      }
    } finally { db.close(); }
  }, 30_000);

  it("Retry on a terminal member request settles the new request and skips its pending member", async () => {
    const group = await room();
    const sent = await sendRoom(group, "Initial context for the retried request", ready.id);
    expect(sent.status).toBe(202);
    await waitIdle(group);
    const rootId = sent.body.message.requestId;
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    let oldId: string;
    try {
      db.exec("PRAGMA busy_timeout=5000");
      oldId = insertRoomRequest(db, {
        groupId: group.id, verb: "room_turn", fromKind: "owner", toBotId: pending.id,
        targetThreadId: group.threadId, parentId: rootId, admissionKey: "previous-member-request",
        payloadText: "Retry this member request", priority: "coordinator", state: "running", now: Date.now(),
      }).request.id;
      completeRequest(db, oldId, { state: "failed", now: Date.now() });
    } finally { db.close(); }
    const earlier = dispatches(group.threadId);
    const retried = await api("POST", `/api/groups/${group.id}/requests/${oldId}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const id = retried.body.request.id;
    await expect.poll(async () => {
      const result = await api("GET", `/api/groups/${group.id}/requests`);
      return result.body.requests.find((item: { id: string }) => item.id === id)?.state;
    }, { timeout: 20_000 }).toMatch(/^(done|failed)$/);
    expect(dispatches(group.threadId).slice(earlier.length)).toEqual([]);
    expect(hasNotice(await transcript(group.threadId))).toHaveLength(1);
  }, 30_000);

  it("a routine triggered for a pending bot fails with the same notice before dispatch", async () => {
    const created = await api("POST", "/api/routines", {
      botId: pending.id, name: "Fixture routine", prompt: "Run the fixture", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const started = await api("POST", `/api/routines/${created.body.routine.id}/run`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId = started.body.run.id;
    let run: { threadId?: string; status?: string; error?: string } | undefined;
    await expect.poll(async () => {
      run = (await api("GET", "/api/routines")).body.runs.find((item: { id: string }) => item.id === runId);
      return run?.status;
    }, { timeout: 20_000 }).toMatch(/^(completed|failed)$/);
    expect(dispatches(run!.threadId!)).toEqual([]);
    expect(run).toMatchObject({ status: "failed", error: notice });
  }, 30_000);

  it("a direct send gets the ready notice and no refused send chip", async () => {
    const sendId = randomUUID();
    const response = await api("POST", `/api/bots/${pending.id}/messages`, { threadId: pending.threadId, text: "Please plan my week", sendId });
    expect(response).toEqual({ status: 409, body: { code: "fuigo_pending", error: notice } });
    expect(await api("GET", `/api/sends/${pending.threadId}/${sendId}`)).toEqual({ status: 200, body: { status: "cancelled" } });
    expect(dispatches(pending.threadId)).toEqual([]);
  }, 25_000);

  it("a project proposal for a pending Chief answers the ready notice over HTTP and launches no engine", async () => {
    const response = await api("POST", "/api/projects/proposal", { purpose: "Plan the autumn launch" });
    expect(response).toEqual({ status: 200, body: { reason: notice } });
    expect(dispatches(chief.threadId)).toEqual([]);
  }, 25_000);
});
