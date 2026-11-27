// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { readBotRecords } from "./bot-turn-state.ts";
import { MESSAGE_ONLY_NOTE } from "./memory/fence-recovery.ts";
import { sessionKeyOf } from "./memory/session-incarnation.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { isLegacyMessageOnlySession } from "./turn-context.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

describe.skipIf(process.platform === "win32")("engine command admission", () => {
  let fixture: VerificationServer;
  let proof: string;
  let model: string;

  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const create = async (instanceId = "verification", selectedModel = model, effort?: string) => {
    const response = await api("/api/bots", { name: "Moss", modelSelection: { instanceId, model: selectedModel, effort } });
    expect(response.status).toBe(201);
    const bot = response.body.bot as { id: string; threadId: string };
    expect((await api(`/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }, "PATCH")).status).toBe(200);
    return bot;
  };
  type Bot = Awaited<ReturnType<typeof create>>;
  const send = (bot: Bot, text: string, sendId = randomUUID()) =>
    api(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId });
  const thread = async (bot: Bot) => (await api(`/api/threads/${bot.threadId}/messages?limit=100`)).body;
  const wait = async () => expect.poll(async () =>
    (await api("/api/bots?messages=0")).body.bots.every((bot: any) => !bot.busy), { timeout: 20_000 }).toBe(true);
  const recognize = async (bot: Bot, name: string) => expect(
    (await api(`/api/bots/${bot.id}/engine-commands`)).body.commands.map((command: any) => command.label),
  ).toContain(name);
  const dumps = () => readFileSync(fixture.fixtureDumpLogPath, "utf8");
  const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { pid: number; argv: string[]; prompt: unknown; cwd: string };
  const sql = (query: string, ...args: string[]) => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try { return db.prepare(query).all(...args); }
    finally { db.close(); }
  };
  const receipt = (sendId: string) => sql("SELECT status, notice, message_id FROM owner_sends WHERE send_id=?", sendId)[0];
  const snapshot = (bot: Bot) => {
    const saved = readBotRecords(fixture.info.dataDir).find(entry => entry.id === bot.id)!;
    const task = saved.tasks!.find(entry => entry.threadId === bot.threadId)!;
    const { resumeCursors, resumeIncarnations, rewound, lastInstanceId, replayPending, effortSent, resumePolicies, externalUpdates, heldContinuations } = task;
    return { task: { resumeCursors, resumeIncarnations, rewound, lastInstanceId, replayPending, effortSent, resumePolicies, externalUpdates, heldContinuations },
      checks: sql("SELECT * FROM memory_session_checks WHERE thread_id=? ORDER BY driver_instance, native_session, reader_key", bot.threadId) };
  };
  const frames = () => {
    try { return readFileSync(`${fixture.info.dataDir}/codex-frames.log`, "utf8").trim().split("\n").map(line => line.split(" ")[1]); }
    catch { return []; }
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      dumpLog: true,
      instrumentationSource: `
        process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
        process.env.FAKE_CLAUDE_COMMANDS = "1";
        const fs = await import("node:fs"), path = await import("node:path");
        const { registerHooks } = await import("node:module");
        globalThis.n5CaptureReset = (threadId, sessionReset, command) => {
          fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR, "turn-resets"), JSON.stringify({ threadId, sessionReset, command: Boolean(command) }) + "\\n");
          return sessionReset;
        };
        const control = path.join(process.env.MURAGE_DATA_DIR, "queue-control.json");
        globalThis.n5QueueControl = (threadId, phase) => {
          if (!fs.existsSync(control)) return false;
          const mode = JSON.parse(fs.readFileSync(control, "utf8"));
          if (mode.threadId !== threadId) return false;
          if (phase === "refused") {
            fs.unlinkSync(control);
            if (mode.crash) process.exit(71);
          }
          return true;
        };
        const setupPlan = threadId => path.join(process.env.MURAGE_DATA_DIR, "setup-" + threadId);
        globalThis.n5ResetEffect = threadId => fs.appendFileSync(setupPlan(threadId) + ".reset-effects", "reset");
        globalThis.n5Fault = (threadId, stage) => {
          const plan = setupPlan(threadId);
          if (!fs.existsSync(plan) || fs.readFileSync(plan, "utf8") !== stage) return false;
          fs.writeFileSync(plan + ".hit", stage);
          return true;
        };
        globalThis.n5AwaitSetup = async threadId => {
          const plan = setupPlan(threadId);
          if (!fs.existsSync(plan)) return;
          fs.writeFileSync(plan + ".held", "");
          const deadline = Date.now() + 15000;
          while (!fs.existsSync(plan + ".resume")) {
            if (Date.now() >= deadline) throw new Error("fixture setup was not released");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        };
        const inject = (text, anchor, extra) => {
          if (!text.includes(anchor)) throw new Error("queue fixture injection point missing");
          return text.replace(anchor, anchor + extra);
        };
        registerHooks({ load(url, context, next) {
          const loaded = next(url, context);
          if (url.endsWith("/server/index.ts")) {
            let text = String(loaded.source);
            text = text.replace("        sessionReset,\\n", '        sessionReset: globalThis.n5CaptureReset(threadId, sessionReset, engineCommand),\\n');
            text = inject(text, "await pendingCancelledProviderHandshakes.waitForClear(threadId);",
              ' if (engineCommand) await globalThis.n5AwaitSetup(threadId);');
            text = inject(text, "const rebuildOf = opts?.rebuildOf;",
              ' if (rebuildOf && opts?.threadId) globalThis.n5ResetEffect(opts.threadId);');
            text = text.replace("let revoked=Boolean(resumeCursor && (packNeedsFreshSession",
              'let revoked=Boolean(resumeCursor && ((engineCommand && globalThis.n5Fault(threadId, "before-recall")) || packNeedsFreshSession');
            text = text.replace('if(pre.sync("after.recall",',
              'if((engineCommand && globalThis.n5Fault(threadId, "after-recall")) || pre.sync("after.recall",');
            text = text.replace("const offProof=resumeCursor?proveRetainedSession",
              'const offProof=engineCommand && globalThis.n5Fault(threadId, "memory-off") ? { kind:"fresh", reason:"session-revoked" } : resumeCursor?proveRetainedSession');
            text = text.replaceAll("deleteSessionChecks(database(),resumeKey());",
              "(() => { if (engineCommand) globalThis.n5ResetEffect(threadId); deleteSessionChecks(database(),resumeKey()); })();");
            text = inject(text, 'trace.mark("resources.admitted");',
              ' if (globalThis.n5Fault(threadId, "resource-admission")) throw new Error("fixture observed resource admission");');
            text = inject(text, "const pre = new PreDispatchTimer();",
              ' if (engineCommand && globalThis.n5Fault(threadId, "setup-revoked")) throw Object.assign(Error("MEMORY_CONTEXT_REVOKED"), { code:"MEMORY_CONTEXT_REVOKED" });');
            text = text.replace('if (engineCommand && ((opts?.drainedCommandInstance',
              'if (engineCommand && globalThis.n5Fault(threadId, "before-dispatch")) resumeCursor = undefined; if (engineCommand && ((opts?.drainedCommandInstance');
            text = inject(text, "const validateDirectSubmission = () => {",
              ' if (engineCommand && acceptedTurnId !== undefined && !directFencePreflight && !directFencePreparing && globalThis.n5Fault(threadId, "at-write")) throw Object.assign(Error("MEMORY_CONTEXT_REVOKED"), { code:"MEMORY_CONTEXT_REVOKED" });');
            const anchor = 'try { return commandAdmission(bot, task, instance, command, { origin: row.origin as MessageOrigin }); }';
            if (!text.includes(anchor)) return { ...loaded, source: text };
            return { ...loaded, source: text.replace(anchor, 'try { if (globalThis.n5QueueControl(row.threadId, "before")) store.patchTask(bot.id, row.threadId, { rewound: true }); return commandAdmission(bot, store.taskByThread(bot.id, row.threadId), instance, command, { origin: row.origin as MessageOrigin }); }') };
          }
          if (url.endsWith("/server/steer-queue.ts") && String(loaded.source).includes('try { sendStore.refuse(rows[0]!.seq, decision.notice); }')) {
            return { ...loaded, source: inject(String(loaded.source), 'try { sendStore.refuse(rows[0]!.seq, decision.notice); } catch { return false; }', ' globalThis.n5QueueControl(threadId, "refused");') };
          }
          return loaded;
        } });
        const file = path.join(process.env.MURAGE_DATA_DIR, "config.json");
        const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
        cfg.instances["fixture-codex"] = { driver: "codex", config: { cli: ${JSON.stringify(resolve("server/testing/fake-codex-app-server.ts"))}, fullAuto: true },
          environment: { FAKE_CODEX_MODE: "resume", FAKE_CODEX_CALL_LOG: path.join(process.env.MURAGE_DATA_DIR, "codex-frames.log"),
            FAKE_CODEX_SKILLS: JSON.stringify([{ name: "tidy-notes", description: "Tidy notes", path: "/skills/tidy-notes/SKILL.md", scope: "user", enabled: true }]) } };
        fs.writeFileSync(file, JSON.stringify(cfg));
      `,
    });
    proof = (await api("/api/desktop-secret")).body.secret;
    model = (await api("/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  async function seed(cwd?: string) {
    const bot = await create();
    if (cwd) expect((await api(`/api/bots/${bot.id}/tasks/${bot.threadId}`, { cwd }, "PATCH")).status).toBe(200);
    expect((await send(bot, "First allowed history line")).status).toBe(202);
    await wait();
    expect((await send(bot, "Second history line")).status).toBe(202);
    await wait();
    await recognize(bot, "compact");
    return bot;
  }

  it("A1 refuses a rewound Claude command before recording or invoking", async () => {
    const bot = await seed();
    const messages = (await thread(bot)).messages;
    expect((await api(`/api/bots/${bot.id}/active-branch`, { threadId: bot.threadId, messageId: messages[0].id })).status).toBe(200);
    const before = await thread(bot);
    const beforeSession = snapshot(bot);
    const dumpBefore = dumps();
    const sendId = randomUUID();
    expect(await send(bot, "/compact", sendId)).toMatchObject({ status: 409, body: { noticeCode: "compactNeedsSession" } });
    expect(receipt(sendId)).toMatchObject({ status: "refused", notice: "compactNeedsSession", message_id: null });
    expect(await thread(bot)).toEqual(before);
    expect(snapshot(bot)).toEqual(beforeSession);
    expect(dumps()).toBe(dumpBefore);
  }, 60_000);

  it("A2 refuses an edit into a Claude command without adding a fork", async () => {
    const bot = await seed();
    const before = await thread(bot);
    const beforeSession = snapshot(bot);
    const user = before.messages.find((message: any) => message.role === "user");
    const dumpBefore = dumps();
    expect(await api(`/api/bots/${bot.id}/messages/${user.id}/edit`, {
      threadId: bot.threadId, text: "/compact", sendId: randomUUID(),
    })).toMatchObject({ status: 409, body: { noticeCode: "compactNeedsSession" } });
    expect(await thread(bot)).toEqual(before);
    expect(snapshot(bot)).toEqual(beforeSession);
    expect(dumps()).toBe(dumpBefore);
  }, 60_000);

  it.each([
    ["A3", "compact", 409],
    ["A3s", "review", 202],
  ])("%s handles /%s as a new Codex chat's first send", async (_id, command, status) => {
    const bot = await create("fixture-codex", "gpt-fake-default");
    await recognize(bot, command);
    const before = frames().length;
    const beforeThread = await thread(bot);
    const result = await send(bot, `/${command}`);
    expect(result.status).toBe(status);
    if (status === 409) {
      expect(result.body.noticeCode).toBe("compactNeedsSession");
      expect(frames().slice(before)).toEqual([]);
      expect(await thread(bot)).toEqual(beforeThread);
    } else {
      await wait();
      expect(frames().slice(before)).toEqual(expect.arrayContaining(["thread/start", "review/start"]));
      await expect.poll(() => snapshot(bot).task.resumeCursors["fixture-codex"]).toEqual(expect.any(String));
      // the command's session is a known Default one: the next ordinary turn resumes it, no fresh start and no "back on Default" line
      expect(snapshot(bot).task.effortSent).toMatchObject({ instanceId: "fixture-codex", effort: "default" });
      const cursor = snapshot(bot).task.resumeCursors["fixture-codex"];
      const afterCommand = frames().length;
      expect((await send(bot, "An ordinary follow-up")).status).toBe(202);
      await wait();
      expect(frames().slice(afterCommand)).not.toContain("thread/start");
      expect(snapshot(bot).task.resumeCursors["fixture-codex"]).toBe(cursor);
      expect(JSON.stringify(await thread(bot))).not.toContain("back on Default");
    }
  }, 60_000);
  it("A3e keeps a new Codex chat on Default after a first /review that carried no effort", async () => {
    const bot = await create("fixture-codex", "gpt-fake-default", "high");
    await recognize(bot, "review");
    expect((await send(bot, "/review")).status).toBe(202);
    await wait();
    const cursor = snapshot(bot).task.resumeCursors["fixture-codex"];
    expect(cursor).toEqual(expect.any(String));
    expect((await api(`/api/bots/${bot.id}/tasks/${bot.threadId}`, {
      modelSelection: { instanceId: "fixture-codex", model: "gpt-fake-default" },
    }, "PATCH")).status).toBe(200);
    const afterCommand = frames().length;
    expect((await send(bot, "A Default follow-up")).status).toBe(202);
    await wait();
    // review/start sent no effort, so the review's thread holds no level: the Default turn resumes it
    expect(frames().slice(afterCommand)).not.toContain("thread/start");
    expect(snapshot(bot).task.resumeCursors["fixture-codex"]).toBe(cursor);
    expect(JSON.stringify(await thread(bot))).not.toContain("back on Default");
    expect(snapshot(bot).task.effortSent).toMatchObject({ instanceId: "fixture-codex", effort: "default" });
  }, 60_000);
  it("A3h leaves a held Codex session's level alone when /review carries no effort", async () => {
    const bot = await create("fixture-codex", "gpt-fake-default");
    expect((await send(bot, "Open a Default session")).status).toBe(202);
    await wait();
    const cursor = snapshot(bot).task.resumeCursors["fixture-codex"];
    expect(cursor).toEqual(expect.any(String));
    expect(snapshot(bot).task.effortSent).toMatchObject({ instanceId: "fixture-codex", effort: "default" });
    const selection = (effort?: string) => api(`/api/bots/${bot.id}/tasks/${bot.threadId}`, {
      modelSelection: { instanceId: "fixture-codex", model: "gpt-fake-default", effort },
    }, "PATCH");
    expect((await selection("high")).status).toBe(200);
    await recognize(bot, "review");
    expect((await send(bot, "/review")).status).toBe(202);
    await wait();
    expect((await selection()).status).toBe(200);
    const afterCommand = frames().length;
    expect((await send(bot, "Back on the default level")).status).toBe(202);
    await wait();
    expect(frames().slice(afterCommand)).not.toContain("thread/start");
    expect(snapshot(bot).task.resumeCursors["fixture-codex"]).toBe(cursor);
    expect(JSON.stringify(await thread(bot))).not.toContain("back on Default");
    expect(snapshot(bot).task.effortSent).toMatchObject({ instanceId: "fixture-codex", effort: "default" });
  }, 60_000);
  it("A3k stamps the level a new Codex chat's first skill command carried", async () => {
    const first = await create("fixture-codex", "gpt-fake-default", "high");
    // Codex reports its skills from a live session (skills/list), so the bot learns them on another chat first
    expect((await send(first, "Learn the skills")).status).toBe(202);
    await wait();
    await expect.poll(async () => (await api(`/api/bots/${first.id}/engine-commands`)).body.commands.map((command: any) => command.label)).toContain("tidy-notes");
    const created = await api(`/api/bots/${first.id}/tasks`, { title: "Fresh chat" });
    expect(created.status).toBeLessThan(300);
    const bot = { id: first.id, threadId: created.body.task.threadId as string };
    expect(snapshot(bot).task.resumeCursors["fixture-codex"]).toBeUndefined();
    const before = frames().length;
    expect((await send(bot, "/tidy-notes")).status).toBe(202);
    await wait();
    // a skill is a turn/start, which carries the selected effort
    expect(frames().slice(before)).toEqual(expect.arrayContaining(["thread/start", "turn/start"]));
    expect(snapshot(bot).task.effortSent).toMatchObject({ instanceId: "fixture-codex", effort: "high" });
  }, 60_000);
  // N5-DESIGN.md rows E5-E8: a skill's explicit level is stamped when its turn/start is written, never before (Astra afc44021f4).
  const heldDefaultWithSkills = async () => {
    const bot = await create("fixture-codex", "gpt-fake-default");
    expect((await send(bot, "Open a Default session")).status).toBe(202);
    await wait();
    await expect.poll(async () => (await api(`/api/bots/${bot.id}/engine-commands`)).body.commands.map((command: any) => command.label)).toContain("tidy-notes");
    const cursor = snapshot(bot).task.resumeCursors["fixture-codex"];
    expect(cursor).toEqual(expect.any(String));
    expect(snapshot(bot).task.effortSent).toMatchObject({ instanceId: "fixture-codex", effort: "default" });
    const selection = (effort?: string) => api(`/api/bots/${bot.id}/tasks/${bot.threadId}`, {
      modelSelection: { instanceId: "fixture-codex", model: "gpt-fake-default", effort },
    }, "PATCH");
    expect((await selection("high")).status).toBe(200);
    return { bot, cursor, selection };
  };
  const resumesOnDefault = async (bot: Bot, cursor: unknown, selection: (effort?: string) => Promise<unknown>, memoryRevoked = false) => {
    // the skill never reached Codex, so the session still holds Default: the next Default turn resumes it
    expect(snapshot(bot).task.effortSent).toMatchObject({ instanceId: "fixture-codex", effort: "default" });
    await selection();
    const count = frames().length;
    expect((await send(bot, "Back on the default level")).status).toBe(202);
    await wait();
    // a memory revocation at the write retires the session by its own rule (B2a); only K4's reset is asserted absent then
    if (!memoryRevoked) {
      expect(frames().slice(count)).not.toContain("thread/start");
      expect(snapshot(bot).task.resumeCursors["fixture-codex"]).toBe(cursor);
    }
    expect(JSON.stringify(await thread(bot))).not.toContain("back on Default");
  };
  it("A3m a skill Stopped in setup leaves a held Default session's level alone", async () => {
    const { bot, cursor, selection } = await heldDefaultWithSkills();
    const plan = join(fixture.info.dataDir, `setup-${bot.threadId}`);
    writeFileSync(plan, "hold", { mode: 0o600 });
    const count = frames().length;
    expect((await send(bot, "/tidy-notes")).status).toBe(202);
    await expect.poll(() => existsSync(plan + ".held"), { timeout: 15_000 }).toBe(true);
    const stop = api(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    writeFileSync(plan + ".resume", "", { mode: 0o600 });
    await stop;
    await wait();
    expect(frames().slice(count)).not.toContain("turn/start");
    await resumesOnDefault(bot, cursor, selection);
  }, 75_000);
  it("A3n a skill refused at its write leaves a held Default session's level alone", async () => {
    const { bot, cursor, selection } = await heldDefaultWithSkills();
    const plan = join(fixture.info.dataDir, `setup-${bot.threadId}`);
    writeFileSync(plan, "at-write", { mode: 0o600 });
    writeFileSync(plan + ".resume", "", { mode: 0o600 });
    const count = frames().length;
    expect((await send(bot, "/tidy-notes")).status).toBe(202);
    await wait();
    expect(readFileSync(plan + ".hit", "utf8")).toBe("at-write");
    expect(frames().slice(count)).not.toContain("turn/start");
    await resumesOnDefault(bot, cursor, selection, true);
  }, 75_000);
  it("A3p a skill written to a held Default session stamps the level it carried", async () => {
    const { bot, cursor } = await heldDefaultWithSkills();
    const count = frames().length;
    expect((await send(bot, "/tidy-notes")).status).toBe(202);
    await wait();
    expect(frames().slice(count)).toContain("turn/start");
    expect(snapshot(bot).task.resumeCursors["fixture-codex"]).toBe(cursor);
    expect(snapshot(bot).task.effortSent).toMatchObject({ instanceId: "fixture-codex", effort: "high" });
  }, 75_000);
  it("A3q a new chat's skill refused at its write is stamped Default, not the selected level", async () => {
    const first = await create("fixture-codex", "gpt-fake-default", "high");
    expect((await send(first, "Learn the skills")).status).toBe(202);
    await wait();
    await expect.poll(async () => (await api(`/api/bots/${first.id}/engine-commands`)).body.commands.map((command: any) => command.label)).toContain("tidy-notes");
    const created = await api(`/api/bots/${first.id}/tasks`, { title: "Fresh chat" });
    expect(created.status).toBeLessThan(300);
    const bot = { id: first.id, threadId: created.body.task.threadId as string };
    const plan = join(fixture.info.dataDir, `setup-${bot.threadId}`);
    writeFileSync(plan, "at-write", { mode: 0o600 });
    writeFileSync(plan + ".resume", "", { mode: 0o600 });
    const count = frames().length;
    expect((await send(bot, "/tidy-notes")).status).toBe(202);
    await wait();
    expect(readFileSync(plan + ".hit", "utf8")).toBe("at-write");
    expect(frames().slice(count)).not.toContain("turn/start");
    expect(snapshot(bot).task.effortSent).toMatchObject({ instanceId: "fixture-codex", effort: "default" });
  }, 75_000);
  it("A4 leaves Codex's stored effort and continuation in place", async () => {
    const bot = await create("fixture-codex", "gpt-fake-default", "high");
    expect((await send(bot, "Set a native effort level")).status).toBe(202);
    await wait();
    await recognize(bot, "compact");
    expect((await api(`/api/bots/${bot.id}/tasks/${bot.threadId}`, {
      modelSelection: { instanceId: "fixture-codex", model: "gpt-fake-default" },
    }, "PATCH")).status).toBe(200);
    const before = snapshot(bot);
    expect(before.task.effortSent).toMatchObject({ effort: "high" });
    expect(before.task.resumeCursors).toHaveProperty("fixture-codex");
    const count = frames().length;
    expect(await send(bot, "/compact")).toMatchObject({ status: 409, body: { noticeCode: "compactNeedsSession" } });
    expect(snapshot(bot)).toEqual(before);
    expect(frames()).toHaveLength(count);
    expect((await send(bot, "Use the default effort")).status).toBe(202);
    await wait();
    expect(frames().slice(count)).toContain("thread/start");
  }, 60_000);

  it("A9 deduplicates the original send and checks liveness on each replacement", async () => {
    const bot = await seed();
    const first = (await thread(bot)).messages[0];
    expect((await api(`/api/bots/${bot.id}/active-branch`, { messageId: first.id })).status).toBe(200);
    await recognize(bot, "compact");
    const sendId = randomUUID();
    const before = dumps();
    expect((await send(bot, "/compact", sendId)).status).toBe(409);
    expect((await send(bot, "/compact", sendId)).status).toBeLessThan(300);
    const resend = (actionId: string) => api(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "/compact", sendId, actionId, resend: true });
    const during = randomUUID();
    expect((await resend(during)).status).toBe(409);
    expect(receipt("r-" + during)).toMatchObject({ status: "refused", notice: "compactNeedsSession" });
    expect(dumps()).toBe(before);
    expect((await send(bot, "Live again")).status).toBe(202);
    await wait();
    const live = dumps();
    expect((await send(bot, "/compact", sendId)).status).toBeLessThan(300);
    expect(dumps()).toBe(live);
    expect((await resend(randomUUID())).status).toBe(202);
    await wait();
    expect(dumps().slice(live.length).trim().split("\n")).toHaveLength(1);
    expect(JSON.stringify(dump().prompt)).toContain("/compact");
  }, 60_000);

  it.each(["live", "rewound", "crash"])("Q1/Q2 drain commands separately through %s", async mode => {
    const bot = await seed();
    const other = await create();
    await recognize(bot, "compact");
    const held = "Hold this turn __fixture_hold_authority__";
    expect((await api(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: held, sendId: randomUUID(), noSteer: true })).status).toBe(202);
    await expect.poll(() => JSON.stringify(dump().prompt), { timeout: 20_000 }).toContain(held);
    const pid = dump().pid;
    const count = dumps().length;
    const commandId = randomUUID();
    const followId = randomUUID();
    const beforeId = randomUUID();
    expect((await send(bot, "Ordinary line before the command", beforeId)).status).toBe(202);
    expect(receipt(beforeId)).toMatchObject({ status: "queued" });
    if (mode !== "live") {
      writeFileSync(join(fixture.info.dataDir, "queue-control.json"), JSON.stringify({ threadId: bot.threadId, crash: mode === "crash" }), { mode: 0o600 });
    }
    expect((await send(bot, "/compact", commandId)).status).toBe(202);
    expect((await send(bot, "Ordinary line after the command", followId)).status).toBe(202);
    expect(receipt(commandId)).toMatchObject({ status: "queued" });
    writeFileSync(join(fixture.fixtureFinishGateDir, String(pid)), "finish");
    if (mode === "crash") {
      await expect.poll(() => fixture.child.exitCode, { timeout: 20_000 }).toBe(71);
      expect(receipt(commandId)).toMatchObject({ status: "refused", notice: "compactNeedsSession", message_id: null });
      await fixture.restart();
      proof = (await api("/api/desktop-secret")).body.secret;
    }
    await wait();
    await expect.poll(() => receipt(followId)?.status, { timeout: 20_000 }).toBe("delivered");
    const turns = dumps().slice(count).trim().split("\n").map(line => JSON.parse(line).prompt.message.content);
    const captured = turns.map(prompt => JSON.stringify(prompt));
    const compact = turns.filter(prompt => typeof prompt === "string" && /^\/compact(?:\s|$)/.test(prompt));
    if (mode === "live") {
      expect(compact).toHaveLength(1);
      expect(compact[0]).toBe("/compact");
    } else {
      expect(compact).toHaveLength(0);
      expect(receipt(commandId)).toMatchObject({ status: "refused", notice: "compactNeedsSession", message_id: null });
    }
    expect(captured.some(prompt => prompt.includes("Ordinary line before the command"))).toBe(true);
    expect(captured.filter(prompt => prompt.includes("Ordinary line after the command"))).toHaveLength(1);
    expect((await thread(other)).messages.some((message: any) => message.role === "user")).toBe(false);
    expect(existsSync(join(fixture.info.dataDir, "queue-control.json"))).toBe(false);
  }, 90_000);

  it.each([
    ["B1 initial", "before-recall", "active"],
    ["B1 recheck", "after-recall", "active"],
    ["B1 off", "memory-off", "off"],
    ["B2b", "setup-revoked", "off"],
    ["B3", "before-dispatch", "off"],
  ])("%s refuses a setup invalidation without spending the continuation", async (_witness, fault, memoryMode) => {
    expect((await api("/api/memory/action", { action: "configure", mode: memoryMode })).status).toBe(200);
    const project = fault === "before-dispatch" ? mkdtempSync(join(dirname(fixture.info.dataDir), "n5-project-")) : undefined;
    if (project) {
      onTestFinished(() => removeTempDir(project));
      writeFileSync(join(project, "work.txt"), "Project checkpoint");
    }
    const bot = await seed(project);
    if (project) expect(dump().cwd === realpathSync(project), "engine uses the pinned project folder").toBe(true);
    await recognize(bot, "compact");
    const before = snapshot(bot);
    const beforeMessages = (await thread(bot)).messages.length;
    const beforeDump = dumps();
    const plan = join(fixture.info.dataDir, `setup-${bot.threadId}`);
    writeFileSync(plan, fault, { mode: 0o600 });
    const sendId = randomUUID();
    expect((await send(bot, "/compact", sendId)).status).toBe(202);
    await expect.poll(() => existsSync(plan + ".held"), { timeout: 15_000 }).toBe(true);
    const followId = randomUUID();
    const follow = fault === "memory-off";
    if (follow) expect((await send(bot, "Run after the refused command", followId)).status).toBe(202);
    writeFileSync(plan + ".resume", "", { mode: 0o600 });
    await wait();
    expect(readFileSync(plan + ".hit", "utf8")).toBe(fault);
    expect(receipt(sendId)).toMatchObject({ status: "failed" });
    const rows = (await thread(bot)).messages.slice(beforeMessages);
    expect(rows.slice(0, 2)).toEqual([
      expect.objectContaining({ role: "user", text: "/compact" }),
      expect.objectContaining({ role: "bot", kind: "activity", tool: expect.objectContaining({ name: "send-notice:compactNeedsSession" }) }),
    ]);
    expect(snapshot(bot).task.resumeCursors).toEqual(before.task.resumeCursors);
    expect(dumps().slice(beforeDump.length)).not.toContain("/compact");
    expect(existsSync(plan + ".reset-effects")).toBe(false);
    const decisions = readFileSync(join(fixture.info.dataDir, "turn-resets"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(decisions.some(row => row.threadId === bot.threadId && row.command)).toBe(false);
    if (follow) expect(receipt(followId)).toMatchObject({ status: "delivered" });
    if (project) {
      const restore = await api("/api/bots/" + bot.id + "/checkpoints/restore", { cwd: project, hash: "0".repeat(40) });
      expect(restore).toMatchObject({ status: 400,
        body: { error: expect.stringMatching(/^(?:no checkpoints exist|no such checkpoint|checkpoints are disabled|git is not installed)/) } });
    }
  }, 75_000);

  it("B2a keeps the write-time memory refusal and reuses no replacement session", async () => {
    const bot = await create("fixture-codex", "gpt-fake-default", "high");
    expect((await send(bot, "Original Codex session")).status).toBe(202);
    await wait();
    await recognize(bot, "compact");
    const before = snapshot(bot);
    const beforeMessages = (await thread(bot)).messages.length;
    const count = frames().length;
    const plan = join(fixture.info.dataDir, `setup-${bot.threadId}`);
    writeFileSync(plan, "at-write", { mode: 0o600 });
    writeFileSync(plan + ".resume", "", { mode: 0o600 });
    const sendId = randomUUID();
    expect((await send(bot, "/compact", sendId)).status).toBe(202);
    await wait();
    expect(readFileSync(plan + ".hit", "utf8")).toBe("at-write");
    expect(receipt(sendId)).toMatchObject({ status: "failed" });
    expect(snapshot(bot).task.resumeCursors).toEqual(before.task.resumeCursors);
    expect(frames().slice(count)).not.toContain("thread/start");
    expect(frames().slice(count)).not.toContain("thread/compact/start");
    const rows = (await thread(bot)).messages.slice(beforeMessages);
    expect(rows.filter((message: any) => /MEMORY_CONTEXT_REVOKED/.test(message.tool?.errorDetails ?? ""))).toHaveLength(1);
  }, 75_000);

  it("A7 preserves the branch for the ordinary turn after the cursor is removed", async () => {
    const bot = await seed();
    const old = (await thread(bot)).messages.find((message: any) => message.text === "Second history line");
    expect((await api(`/api/bots/${bot.id}/messages/${old.id}/edit`, {
      threadId: bot.threadId, text: "Kept branch sentinel", sendId: randomUUID(),
    })).status).toBe(202);
    await wait();
    const file = join(fixture.info.dataDir, "bots.json");
    await fixture.stop();
    const roster = JSON.parse(readFileSync(file, "utf8"));
    const saved = readBotRecords(fixture.info.dataDir).find(entry => entry.id === bot.id)!;
    const task = saved.tasks!.find(entry => entry.threadId === bot.threadId)!;
    expect(task.resumeContracts?.verification).toBeTruthy();
    expect(task.resumeCursors.verification).toBeTruthy();
    delete task.resumeCursors.verification;
    delete saved.resumeCursors.verification;
    roster[roster.findIndex((entry: any) => entry.id === bot.id)] = { ...saved, turnStateBase: randomUUID() };
    writeFileSync(file, JSON.stringify(roster), { mode: 0o600 });
    await fixture.restart();
    proof = (await api("/api/desktop-secret")).body.secret;
    await recognize(bot, "compact");
    const before = snapshot(bot);
    const beforeDump = dumps();
    expect(await send(bot, "/compact")).toMatchObject({ status: 409, body: { noticeCode: "compactNeedsSession" } });
    expect(dumps()).toBe(beforeDump);
    await fixture.restart();
    proof = (await api("/api/desktop-secret")).body.secret;
    expect(snapshot(bot)).toEqual(before);
    expect((await send(bot, "Ordinary turn after refusal")).status).toBe(202);
    await wait();
    const captured = dump();
    expect(captured.argv).toContain("--session-id");
    const prompt = JSON.stringify(captured.prompt);
    expect(prompt).toContain("Kept branch sentinel");
    expect(prompt).not.toContain("Second history line");
    expect(prompt).not.toContain("/compact");
  }, 90_000);

  it("A10 refuses a rewound command before explicit cloud computer admission", async () => {
    const bot = await seed();
    const first = (await thread(bot)).messages[0];
    expect((await api(`/api/bots/${bot.id}/active-branch`, { messageId: first.id })).status).toBe(200);
    expect((await api(`/api/bots/${bot.id}`, { computer: "cloud" }, "PATCH")).status).toBe(200);
    await recognize(bot, "compact");
    const before = snapshot(bot);
    const plan = join(fixture.info.dataDir, `setup-${bot.threadId}`);
    writeFileSync(plan, "resource-admission", { mode: 0o600 });
    const sendId = randomUUID();
    expect(await send(bot, "/compact", sendId)).toMatchObject({ status: 409, body: { noticeCode: "compactNeedsSession" } });
    expect(existsSync(plan + ".hit")).toBe(false);
    expect(receipt(sendId)).toMatchObject({ status: "refused", message_id: null });
    expect(snapshot(bot)).toEqual(before);
  }, 60_000);

  it("C8 setup leaves a confirmed Stop or the command notice after revocation", async () => {
    // JOINT RULING STOP-VS-REFUSAL. If the confirmed Stop receipt exists before the refusal freezes,
    // the turn ends silent and the card shows the Stop. If the refusal freezes while Stop is HELD,
    // the refusal row is shown. A failed command must never lose both outcomes.
    const bot = await seed();
    await recognize(bot, "compact");
    const plan = join(fixture.info.dataDir, `setup-${bot.threadId}`);
    writeFileSync(plan, "setup-revoked", { mode: 0o600 });
    const previous = (await thread(bot)).messages.length;
    const sendId = randomUUID();
    expect((await send(bot, "/compact", sendId)).status).toBe(202);
    await expect.poll(() => existsSync(plan + ".held"), { timeout: 15_000 }).toBe(true);
    const stop = api(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    writeFileSync(plan + ".resume", "", { mode: 0o600 });
    await stop;
    await wait();
    const rows = (await thread(bot)).messages.slice(previous);
    const refusal = rows.filter((row: any) => row.tool?.name === "send-notice:compactNeedsSession");
    const stopped = rows.filter((row: any) => /Stopped by you/.test(row.tool?.name ?? ""));
    expect(refusal.length + stopped.length).toBeGreaterThan(0);
    expect(refusal.length).toBeLessThanOrEqual(1);
  }, 75_000);

  it("A8 uses the ordinary dispatch's continuation decision for command admission", async () => {
    const cases = await Promise.all(["cursor", "rewound", "engine", "audience", "contract", "legacy", "taint", "external"].map(async fact => ({
      fact, bot: await create(),
    })));
    for (const { bot } of cases) {
      expect((await send(bot, "Seed a retained session")).status).toBe(202);
      await wait();
    }
    await fixture.stop();
    const file = join(fixture.info.dataDir, "bots.json");
    const roster = JSON.parse(readFileSync(file, "utf8"));
    const durable = readBotRecords(fixture.info.dataDir);
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      for (const { fact, bot } of cases) {
        const profile = durable.find(entry => entry.id === bot.id)!;
        const task = profile.tasks!.find(entry => entry.threadId === bot.threadId)!;
        expect(task.resumeCursors.verification, fact).toEqual(expect.any(String));
        switch (fact) {
          case "cursor": delete task.resumeCursors.verification; profile.resumeCursors = task.resumeCursors; break;
          case "rewound": task.rewound = profile.rewound = true; break;
          case "engine": task.lastInstanceId = "earlier-engine"; break;
          case "audience": task.resumeAudiences = { ...task.resumeAudiences, verification: "earlier-audience" }; break;
          case "contract": task.resumeContracts = { ...task.resumeContracts, verification: -1 }; break;
          case "taint": task.sealGeneration = 1; break;
          case "external": {
            const latest = db.prepare("SELECT id FROM messages WHERE thread_id=? AND role='bot' AND kind='text' ORDER BY rowid DESC LIMIT 1").get(bot.threadId);
            if (typeof latest?.id !== "string") throw new Error("Fixture has no prior external row");
            task.externalUpdates = [latest.id];
            break;
          }
          case "legacy": {
            const { nativeSession } = sessionKeyOf(bot.threadId, "verification", String(task.resumeCursors.verification), task.resumeIncarnations?.verification);
            const retained = db.prepare("SELECT first_lsn FROM memory_session_lineage WHERE thread_id=? AND driver_instance='verification' AND native_session=?").get(bot.threadId, nativeSession);
            if (typeof retained?.first_lsn !== "number") throw new Error("Fixture has no lineage for its retained session");
            const lines = db.prepare("SELECT l.thread_no,l.lsn,m.id,m.role,json_extract(m.json,'$.turnId') AS turn_id FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no JOIN messages m ON m.thread_id=t.thread_id AND m.id=l.message_id WHERE t.thread_id=? ORDER BY l.lsn").all(bot.threadId);
            const input = lines.find(line => line.role === "user");
            const output = lines.find(line => line.role === "bot" && typeof line.turn_id === "string");
            if (typeof input?.id !== "string" || typeof input.lsn !== "number" || !output) throw new Error("Fixture has no legacy turn to stamp");
            db.prepare("UPDATE memory_session_lineage SET first_lsn=? WHERE thread_id=? AND driver_instance='verification' AND native_session=?")
              .run(input.lsn, bot.threadId, nativeSession);
            db.prepare("UPDATE memory_line_lineage SET turn_lsn=? WHERE thread_no=? AND lsn=?").run(input.lsn, output.thread_no!, output.lsn!);
            const id = "memory-note-" + createHash("sha256").update(bot.threadId + "\0" + input.id).digest("hex");
            const at = Date.now();
            db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot','activity',NULL,?)").run(bot.threadId, id, at,
              JSON.stringify({ id, at, role: "bot", kind: "activity", murageLine: true, memoryNote: "without-memory",
                turnId: output.turn_id, tool: { name: MESSAGE_ONLY_NOTE } }));
            expect(isLegacyMessageOnlySession(db, bot.threadId, "verification", nativeSession)).toBe(true);
            break;
          }
        }
        roster[roster.findIndex((entry: any) => entry.id === bot.id)] = { ...profile, turnStateBase: randomUUID() };
      }
    } finally { db.close(); }
    writeFileSync(file, JSON.stringify(roster), { mode: 0o600 });
    await fixture.restart();
    proof = (await api("/api/desktop-secret")).body.secret;
    for (const { fact, bot } of cases) {
      await recognize(bot, "compact");
      const command = await send(bot, "/compact");
      const rebuild = fact !== "external";
      expect(command.status, fact).toBe(rebuild ? 409 : 202);
      await wait();
      expect((await send(bot, "Ordinary continuation")).status, fact).toBe(202);
      await wait();
      const decisions = readFileSync(join(fixture.info.dataDir, "turn-resets"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(decisions.filter(row => row.threadId === bot.threadId).at(-1), fact).toMatchObject({ sessionReset: rebuild });
    }
  }, 120_000);

  it("B4 a recalled session remains eligible after the server restarts", async () => {
    expect((await api("/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
    const bot = await create();
    const folder = join(fixture.info.dataDir, "workspaces", bot.id, "memory");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "garden.md"), "Water the garden on Friday morning.\n", { mode: 0o600 });
    const preview = await api("/api/memory/action", { action: "import-preview", selections: [{ kind: "bot", botId: bot.id, topic: "garden.md" }] });
    expect(preview.status).toBe(200);
    const committed = await api("/api/memory/action", { action: "import-commit", previewId: preview.body.previewId, track: false });
    expect(committed.body.recordIds).not.toHaveLength(0);
    for (const id of committed.body.recordIds) {
      expect((await api("/api/memory/action", { action: "pin", id, version: 1, pinned: true })).status).toBe(200);
    }
    for (const text of ["When should I water the garden?", "How about next week?"]) {
      expect((await send(bot, text)).status).toBe(202);
      await wait();
    }
    expect(sql("SELECT 1 FROM memory_disclosures WHERE thread_id=? AND record_versions <> '[]' AND state='delivered' LIMIT 1", bot.threadId)).toHaveLength(1);
    const before = snapshot(bot);
    await fixture.restart();
    proof = (await api("/api/desktop-secret")).body.secret;
    await recognize(bot, "compact");
    const count = dumps().length;
    expect((await send(bot, "/compact")).status).toBe(202);
    await wait();
    expect(dumps().length).toBeGreaterThan(count);
    const captured = dump();
    const resume = captured.argv.indexOf("--resume");
    expect(resume).toBeGreaterThanOrEqual(0);
    expect(captured.argv[resume + 1]).toBe(before.task.resumeCursors.verification);
    expect(JSON.stringify(captured.prompt)).toContain("/compact");
  }, 90_000);

});
