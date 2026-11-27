// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
import { openSse } from "../testing/sse.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "../testing/power-block-test.ts";

const fakeCli = fileURLToPath(new URL("../testing/fake-acp-cli.ts", import.meta.url));
const shellCommand = "echo fixture-shell-action";
// A stop-line database delete under full access: its card offers the task scope (the fake engine never runs it).
const stopCommand = "sqlite3 fixture.db 'DROP TABLE fixture_old'";
const taskTitle = "fixture private Inbox label";
const resultSummary = "fixture private Inbox result";
const companionProof = "b".repeat(64);
type InboxResults = { total: number; items: unknown[] };
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let desktop: Record<string, string>;
let inboxThread: string;
let controlThread: string;

async function api<T = unknown>(path: string, body?: unknown, headers = desktop, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as T };
}

async function seal(threadId: string, complete: boolean, requestId?: string) {
  const signal = join(fixture.info.dataDir, `seal-${threadId}-${complete ? "complete" : "pending"}`);
  writeFileSync(signal + ".tmp", JSON.stringify({ threadId, complete, requestId }));
  // The child reads only the committed SQLite seal, via a fixture-local signal.
  renameSync(signal + ".tmp", signal);
  await expect.poll(() => existsSync(signal + ".done")).toBe(true);
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    env: { MURAGE_COMPANION_TOKEN: companionProof },
    instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      const fs = await import('node:fs');
      const { join } = await import('node:path');
      const dir = process.env.MURAGE_DATA_DIR;
      const { createAcpDriver } = await import(${JSON.stringify(new URL("../drivers/acp/core.ts", import.meta.url).href)});
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL("../drivers/builtIn.ts", import.meta.url).href)});
      BUILT_IN_DRIVERS.push(createAcpDriver({
        driverKind: 'mailboxApprovalFixture', displayName: 'Approval fixture', defaultCli: process.execPath,
        models: { default: 'fixture', options: [{ id: 'fixture', label: 'Fixture' }] },
        nativeSource: 'approval-fixture.acp', loginNote: 'Fixture only',
        spawnArgs: () => ['--experimental-strip-types', ${JSON.stringify(fakeCli)}],
        pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true, fluxReach: () => 'elsewhere'
      }));
      const configPath = join(dir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.instances.approval = { driver: 'mailboxApprovalFixture', config: { cli: process.execPath, fullAuto: false },
        environment: { FAKE_ACP_MODE: 'permission', FAKE_ACP_PERMISSION_COMMAND: ${JSON.stringify(shellCommand)} } };
      config.instances.approvalStop = { driver: 'mailboxApprovalFixture', config: { cli: process.execPath, fullAuto: true },
        environment: { FAKE_ACP_MODE: 'permission', FAKE_ACP_PERMISSION_COMMAND: ${JSON.stringify(stopCommand)} } };
      fs.writeFileSync(configPath, JSON.stringify(config));
      const { registerHooks } = await import('node:module');
      const serverUrl = ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
      registerHooks({ load(url, context, next) {
        const loaded = next(url, context);
        if (url !== serverUrl) return loaded;
        const anchor = 'const askMessageByRequest = new Map<string, string>();';
        const source = String(loaded.source);
        if (!source.includes(anchor)) throw Error('missing fixture approval hint');
        return { ...loaded, source: source.replace(anchor, anchor +
          " globalThis[Symbol.for('murage.fixture.sealThread')] = (threadId, requestId) => {"
          + " store.beginMailboxSeal(threadId);"
          + " if (requestId && !askMessageByRequest.delete(threadId + ':' + requestId)) throw Error('missing live fixture hint');"
          + " };") };
      } });
      const { Store } = await import(${JSON.stringify(new URL("../store.ts", import.meta.url).href)});
      const { database } = await import(${JSON.stringify(new URL("../database.ts", import.meta.url).href)});
      const { migrateMailboxMessageBatch } = await import(${JSON.stringify(new URL("../message-db.ts", import.meta.url).href)});
      const store = new Store(() => ({ instanceId: 'approval', model: 'fixture' }));
      const bot = store.createBot({ name: 'Inbox fixture' }, { seedMessages: false });
      const task = store.createTask(bot.id, ${JSON.stringify(taskTitle)}, false);
      store.appendMessage(task.threadId, { role: 'bot', kind: 'routine.run', routineRun: {
        runId: 'fixture-private-run', routineName: 'Private run', status: 'completed', summary: ${JSON.stringify(resultSummary)}
      } });
      store.appendMessage(bot.threadId, { role: 'bot', kind: 'routine.run', routineRun: {
        runId: 'fixture-control-run', routineName: 'Control run', status: 'completed', summary: 'control result'
      } });
      fs.writeFileSync(join(dir, 'inbox-fixture.json'), JSON.stringify({ inboxThread: task.threadId, controlThread: bot.threadId }));
      const watch = setInterval(() => {
        for (const file of fs.readdirSync(dir).filter(name => /^seal-[\\w-]+$/.test(name))) {
          const path = join(dir, file);
          const { threadId, complete, requestId } = JSON.parse(fs.readFileSync(path, 'utf8'));
          globalThis[Symbol.for('murage.fixture.sealThread')](threadId, requestId);
          if (complete) {
            if (!migrateMailboxMessageBatch(threadId).done) throw Error('unexpected fixture migration size');
            database().prepare("UPDATE mailbox_sealed_threads SET state='complete' WHERE thread_id=?").run(threadId);
          }
          fs.renameSync(path, path + '.done');
        }
      }, 20);
      watch.unref();
    `,
  });
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api<{ secret: string }>("/api/desktop-secret", undefined, {})).body.secret };
  ({ inboxThread, controlThread } = JSON.parse(readFileSync(join(fixture.info.dataDir, "inbox-fixture.json"), "utf8")));
}, 30_000);

afterAll(async () => { await fixture?.close(); });

it.skipIf(process.platform === "win32").each([
  ["handle", "deny", "rejected", false], ["request ID", "deny", "rejected", false], ["handle", "allow", "allowed-once", false],
  // "Allow for this task" is authorized by the signed card's own offered scope, never by the sealed projection.
  ["handle", "allow", "allowed-once", true], ["request ID", "allow", "allowed-once", true],
] as const)(
  "the desktop answers a registered shell approval in a sealed transcript by %s (%s, %s, for the task: %s)",
  async (identifier, behavior, outcome, forTask) => {
    const stream = await openSse(fixture.info.url + "/api/events", desktop);
    try {
      const command = forTask ? stopCommand : shellCommand;
      const created = await api<{ bot: { id: string; threadId: string } }>("/api/bots", { name: "Approval fixture", modelSelection: { instanceId: forTask ? "approvalStop" : "approval", model: "fixture" } });
      expect(created.status).toBe(201);
      const bot = created.body.bot;
      expect((await api(`/api/bots/${bot.id}`, forTask ? { computer: "off", browser: false, composio: false } : { autoApprove: false, autoReview: "off", computer: "off" }, desktop, "PATCH")).status).toBe(200);
      if (forTask) expect((await api(`/api/bots/${bot.id}/tasks/${bot.threadId}`, { fullAccess: true, acknowledgeFullAccess: true }, desktop, "PATCH")).status).toBe(200);
      await stream.until(frame => frame.kind === "hello");
      expect((await api(`/api/bots/${bot.id}/messages`, { text: "Ask for a shell approval", threadId: bot.threadId })).status).toBe(202);
      const opened = await stream.until(frame => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.card?.requestHandle, 40_000);
      const requestHandle = opened.message.card.requestHandle;
      using db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
      const cardId = requestHandle.slice(2);
      const read = () => db.prepare("SELECT id,state,delivery,presented_action FROM approval_records WHERE thread_id=? AND chat_message_id=?").get(bot.threadId, cardId);
      const signed = read();
      expect(signed).toMatchObject({ state: "open", presented_action: expect.stringContaining(command) });
      const card = () => JSON.parse(String(db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(bot.threadId, cardId)?.json)).card;
      const pending = card();
      const path = `/api/threads/${bot.threadId}`;
      const answer = { ...(identifier === "handle" ? { requestHandle, action: behavior } : { requestId: pending.requestId, behavior }),
        ...(forTask ? { allowForTask: true } : {}) };
      // The signed card offers this exact task scope; it is what a task answer may add.
      if (forTask) expect(pending.taskAllowKey).toEqual(expect.any(String));
      if (behavior === "allow") {
        await seal(bot.threadId, false);
        // Fail closed while the signed card cannot be read: nothing is delivered or granted.
        expect(await api(path + "/respond", answer)).toEqual(forTask && identifier === "request ID"
          ? { status: 400, body: { error: "This approval can only be allowed once." } }
          : { status: 409, body: { error: "request_unavailable" } });
        expect(read()).toMatchObject({ state: "open", delivery: "none" });
      }
      // The request-ID route must resolve the signed record even after its
      // transient message hint is lost. The decision registration stays live.
      await seal(bot.threadId, true, identifier === "request ID" ? pending.requestId : undefined);
      expect(card()).toEqual(pending);
      const thread = await api(path + "/messages");
      expect(JSON.stringify(thread.body)).not.toContain(command);
      const response = await api(path + "/respond", answer);
      expect(response).toEqual({ status: 200, body: { ok: true, outcome, ...(forTask ? { taskAdded: [pending.taskAllowKey] } : {}) } });
      expect(read()).toMatchObject({ id: signed?.id, state: "answered", delivery: "accepted", presented_action: signed?.presented_action });
    } catch (error) {
      console.error(readFileSync(fixture.info.logPath, "utf8").slice(-8000));
      throw error;
    } finally { stream.close(); }
  },
  60_000,
);

it("a paired Inbox drops cached results, their task labels and counts at the pending seal", async () => {
  const phone = { "x-murage-companion": "1", "x-murage-companion-token": companionProof, "x-murage-door-token": companionProof };
  const path = "/api/inbox?view=results";
  const read = () => api<InboxResults>(path, undefined, phone);
  await expect.poll(async () => (await read()).body.total, { timeout: 6000 }).toBe(2);
  expect((await api<InboxResults>(path)).body.total).toBe(2);
  const before = await read();
  expect(before.status).toBe(200);
  expect(before.body.items).toContainEqual(expect.objectContaining({
    sourceLabel: expect.stringContaining(taskTitle), summary: resultSummary, link: expect.objectContaining({ threadId: inboxThread }),
  }));

  await seal(inboxThread, false);

  using db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  expect(db.prepare("SELECT state,cursor FROM mailbox_sealed_threads WHERE thread_id=?").get(inboxThread)).toEqual({ state: "pending", cursor: 0 });
  const after = await read();
  expect(after).toMatchObject({ status: 200, body: { total: 1, items: [{ summary: "control result", link: { threadId: controlThread } }] } });
  expect(JSON.stringify(after.body)).not.toContain(taskTitle);
  expect(JSON.stringify(after.body)).not.toContain(resultSummary);
  const genericDesktop = await api(path);
  expect(genericDesktop).toMatchObject({ status: 200, body: { total: 1, items: [{ summary: "control result", link: { threadId: controlThread } }] } });
  expect(JSON.stringify(genericDesktop.body)).not.toContain(taskTitle);
  expect(JSON.stringify(genericDesktop.body)).not.toContain(resultSummary);
}, 15_000);
