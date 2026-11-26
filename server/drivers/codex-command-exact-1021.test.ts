// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readBotRecords } from "../bot-turn-state.ts";
import { COMMAND_STOP_FIXTURE_SOURCE, finishCommandStopRace } from "../testing/command-stop-fixture.ts";
import { LEDGER_REFUSAL_LINE } from "../ledger-refusal-line.ts";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

describe.skipIf(process.platform === "win32")("Codex command session identity", () => {
  let fixture: VerificationServer;
  let proof: string;
  const savedSession = (botId: string, threadId: string) => {
    const task = readBotRecords(fixture.info.dataDir).find(bot => bot.id === botId)!.tasks!.find(task => task.threadId === threadId)!;
    const { resumeCursors, resumeIncarnations, rewound, lastInstanceId, replayPending, effortSent, resumePolicies, externalUpdates, heldContinuations } = task;
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      return { resumeCursors, resumeIncarnations, rewound, lastInstanceId, replayPending, effortSent, resumePolicies, externalUpdates, heldContinuations,
        checks: db.prepare("SELECT * FROM memory_session_checks WHERE thread_id=? ORDER BY driver_instance,native_session,reader_key").all(threadId) };
    } finally { db.close(); }
  };
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const stats = async (botId: string) => (await api("/api/bots?messages=100")).body.bots.find((bot: any) => bot.id === botId);
  const wait = async (botId: string) => expect.poll(async () => (await stats(botId)).busy, { timeout: 20_000 }).toBe(false);
  const methods = () => readFileSync(`${fixture.info.dataDir}/codex-frames.log`, "utf8").trim().split("\n").map(line => line.split(" ")[1]);
  const inputs = () => JSON.parse(readFileSync(`${fixture.info.dataDir}/codex-dump.json`, "utf8")).calls;
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      instrumentationSource: `
        const fs = await import("node:fs"), path = await import("node:path");
        const { registerHooks } = await import("node:module");
        globalThis.n5SealAtTerminal = threadId => fs.existsSync(path.join(process.env.MURAGE_DATA_DIR, "seal-" + threadId));
        ${COMMAND_STOP_FIXTURE_SOURCE}
        registerHooks({ load(url, context, next) {
          const loaded = next(url, context);
          const source = String(loaded.source);
          if (url.endsWith("/server/index.ts")) {
            const start = 'const foldRuntimeEvent = (executionEvent: RuntimeEvent) => {';
            if (!source.includes(start)) throw new Error("ledger witness host anchor missing");
            const sourceWithSeal = source.replace(start, 'globalThis.n5SealLease = (threadId: string) => { const run = directRuns.get(threadId); if (run) admittedLedgerLeases.get(run.generation)?.onLedgerRefused({ state: "checking", reason: "retained-over" }); }; ' + start);
            return { ...loaded, source: n5ServerStop(sourceWithSeal) };
          }
          if (url.endsWith("/server/drivers/codex.ts")) {
            const start = "// Capture before cleanup calls stop();";
            if (!source.includes(start)) throw new Error("ledger witness driver anchor missing");
            const before = 'if (state.settled) return;\\n        // P1 (r4 item';
            const during = 'completeStoppedTurn = complete;';
            return { ...loaded, source: source
              .replace(before, 'if (state.settled) return; if (stopReason === "command_needs_session" && ["before", "rejected"].includes(globalThis.n5RaceStage(threadId))) { await globalThis.n5WaitAtRefusal(threadId); if (globalThis.n5RaceStage(threadId) === "before") { gate.ask(threadId, turnId); void stop("asked"); } }\\n        // P1 (r4 item')
              .replace(start, 'if (stopReason === "command_needs_session" && globalThis.n5SealAtTerminal(threadId)) globalThis.n5SealLease(threadId); ' + start)
              .replace(during, during + ' if (stopReason === "command_needs_session" && globalThis.n5RaceStage(threadId) === "during") { await globalThis.n5WaitAtRefusal(threadId); gate.ask(threadId, turnId); }') };
          }
          return loaded;
        } });
        const file = path.join(process.env.MURAGE_DATA_DIR, "config.json");
        const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const scenario of ["missing", "different", "model"]) {
          cfg.instances[scenario] = { driver: "codex", config: { cli: ${JSON.stringify(resolve("server/testing/fake-codex-app-server.ts"))}, fullAuto: true },
            environment: { FAKE_CODEX_MODE: scenario === "missing" ? "happy" : "resume",
              ...(scenario === "different" ? { FAKE_CODEX_RESUME_THREAD_ID: "another-thread" } : {}),
              ...(scenario === "model" ? { FAKE_CODEX_RESUME_MODEL: "stale" } : {}),
              FAKE_CODEX_CALL_LOG: path.join(process.env.MURAGE_DATA_DIR, "codex-frames.log"),
              FAKE_CODEX_DUMP: path.join(process.env.MURAGE_DATA_DIR, "codex-dump.json") } };
        }
        fs.writeFileSync(file, JSON.stringify(cfg));
      `,
    });
    proof = (await api("/api/desktop-secret")).body.secret;
    expect((await api("/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });
  it.each([
    ["C1", "missing", "compactNeedsSession"],
    ["C2", "different", "compactNeedsSession"],
    ["C4", "model", "commandModelChanged"],
  ])("%s keeps the original session when resume is %s", async (_case, instanceId, notice) => {
    const { bot } = (await api("/api/bots", { name: "Moss", modelSelection: { instanceId, model: "gpt-fake-default", effort: "high" } })).body;
    expect((await api(`/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }, "PATCH")).status).toBe(200);
    const send = (text: string, sendId = randomUUID()) => api(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId });
    if (instanceId === "missing") {
      expect((await send("Abandoned history sentinel")).status).toBe(202);
      await wait(bot.id);
      const old = (await stats(bot.id)).messages.find((message: any) => message.text === "Abandoned history sentinel");
      expect(old?.id).toEqual(expect.any(String));
      const editPath = "/api/bots/" + bot.id + "/messages/" + old.id + "/edit";
      expect((await api(editPath, { threadId: bot.threadId, text: "Allowed history sentinel", sendId: randomUUID() })).status).toBe(202);
    } else {
      expect((await send("Allowed history sentinel")).status).toBe(202);
    }
    await wait(bot.id);
    expect((await api(`/api/bots/${bot.id}/engine-commands`)).body.commands).toEqual(expect.arrayContaining([expect.objectContaining({ label: "compact" })]));
    const before = await stats(bot.id);
    const beforeSession = savedSession(bot.id, bot.threadId);
    const count = methods().length;
    const sendId = randomUUID();
    expect((await send("/compact", sendId)).status).toBe(202);
    await wait(bot.id);
    const after = await stats(bot.id);
    expect(methods().slice(count).filter(method => /^(thread|turn)\//.test(method))).toEqual(["thread/resume"]);
    expect(savedSession(bot.id, bot.threadId)).toEqual(beforeSession);
    expect(after.messages.slice(before.messages.length)).toEqual([
      expect.objectContaining({ role: "user", text: "/compact" }),
      expect.objectContaining({ role: "bot", kind: "activity", tool: expect.objectContaining({ name: `send-notice:${notice}` }) }),
    ]);
    if (instanceId === "missing") {
      const message = after.messages.find((entry: any) => entry.sendId === sendId);
      expect(message?.id).toEqual(expect.any(String));
      const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
      try {
        expect(db.prepare("SELECT status, message_id FROM owner_sends WHERE send_id=?").get(sendId)).toMatchObject({ status: "failed", message_id: message.id });
        expect(db.prepare("SELECT 1 AS excluded FROM send_replay_exclusions WHERE thread_id=? AND message_id=?").get(bot.threadId, message.id))
          .toEqual({ excluded: 1 });
      } finally { db.close(); }
      const followStart = methods().length;
      expect((await send("Follow up after refusal")).status).toBe(202);
      await wait(bot.id);
      const followMethods = methods().slice(followStart).filter(method => /^(thread|turn)\//.test(method));
      const resets = readFileSync(fixture.info.logPath, "utf8").split("\n")
        .filter(line => line.includes("continuation reset") && line.includes(bot.threadId));
      expect(followMethods, resets.join("\n")).toEqual(["thread/resume", "thread/start", "turn/start"]);
      const prompt = inputs().filter((call: any) => call.method === "turn/start").at(-1).params.input
        .map((block: { text?: string }) => block.text ?? "").join("\n");
      expect(prompt.includes("[Your previous session could not be restored")).toBe(true);
      expect(prompt).toContain("Allowed history sentinel");
      expect(prompt).not.toContain("Abandoned history sentinel");
      expect(prompt).not.toContain("/compact");
      expect(prompt).not.toContain("Nothing to compact yet");
    }
  }, 90_000);
  // JOINT RULING STOP-VS-REFUSAL: "If the confirmed Stop receipt exists before the refusal freezes, the turn ends silent and the card shows the Stop."
  // "If the refusal freezes while the Stop is still HELD (unconfirmed), the refusal row is shown."
  it.each(["confirmed", "before", "during", "rejected"])("C8 keeps the command refusal through a %s Stop", async stage => {
    const created = await api("/api/bots", { name: "Moss", modelSelection: { instanceId: "missing", model: "gpt-fake-default", effort: "high" } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect((await api("/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
    expect((await api(`/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }, "PATCH")).status).toBe(200);
    const send = (text: string) => api(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: randomUUID() });
    expect((await send("Existing session")).status).toBe(202);
    await wait(bot.id);
    const before = (await stats(bot.id)).messages.length;
    writeFileSync(join(fixture.info.dataDir, "race-" + bot.threadId), stage, { mode: 0o600 });
    expect((await send("/compact")).status).toBe(202);
    const reason = await finishCommandStopRace(fixture.info.dataDir, bot.threadId, stage,
      () => api(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }), () => wait(bot.id));
    expect(reason).toBe("command_needs_session");
    const rows = (await stats(bot.id)).messages.slice(before);
    expect(rows.filter((message: any) => message.role === "bot").map((message: any) => message.tool?.name)).toEqual([
      ...(stage === "rejected" ? [expect.stringMatching(/^error: provider stop is unconfirmed;/)] : []),
      stage === "confirmed" ? expect.stringMatching(/Stopped by you/) : "send-notice:compactNeedsSession",
    ]);
    if (stage === "rejected") expect(rows[1]).not.toHaveProperty("turnId");
  }, 75_000);

  it("C9 the sealed ledger lease owns the terminal explanation and release", async () => {
    const created = await api("/api/bots", { name: "Moss", modelSelection: { instanceId: "missing", model: "gpt-fake-default", effort: "high" } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect((await api(`/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }, "PATCH")).status).toBe(200);
    const send = (text: string, sendId = randomUUID()) => api(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId });
    expect((await send("Existing session")).status).toBe(202);
    await wait(bot.id);
    expect((await api(`/api/bots/${bot.id}/engine-commands`)).body.commands).toEqual(expect.arrayContaining([expect.objectContaining({ label: "compact" })]));
    const before = (await stats(bot.id)).messages.length;
    writeFileSync(join(fixture.info.dataDir, "seal-" + bot.threadId), "", { mode: 0o600 });
    const id = randomUUID();
    expect((await send("/compact", id)).status).toBe(202);
    await wait(bot.id);
    const rows = (await stats(bot.id)).messages.slice(before);
    expect(rows.filter((message: any) => message.role === "bot").map((message: any) => message.text)).toEqual([LEDGER_REFUSAL_LINE]);
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT phase, cleanup_owed FROM send_attempts WHERE send_id=?").all(id)).toEqual([{ phase: "terminal", cleanup_owed: 0 }]);
    } finally { db.close(); }
  }, 75_000);

});
