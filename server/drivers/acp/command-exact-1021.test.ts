// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMAND_STOP_FIXTURE_SOURCE, finishCommandStopRace } from "../../testing/command-stop-fixture.ts";
import { readBotRecords } from "../../bot-turn-state.ts";
import { launchVerificationServer, type VerificationServer } from "../../../scripts/control-murage.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "../../testing/power-block-test.ts";

describe.skipIf(process.platform === "win32")("ACP command session identity", () => {
  let fixture: VerificationServer;
  let proof: string;
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const frames = (name: string) => readFileSync(join(fixture.info.dataDir, name + ".frames"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const wait = async (botId: string) => expect.poll(async () =>
    (await api("/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId).busy,
    { timeout: 20_000 },
  ).toBe(false);

  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      env: { NODE_ENV: "test" },
      instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
        const fs = await import("node:fs"), path = await import("node:path");
        const { registerHooks } = await import("node:module");
        const { fuigoPolicyPath } = await import(${JSON.stringify(new URL("./fuigo-policy.ts", import.meta.url).href)});
        const formerRoot = path.join(process.env.MURAGE_DATA_DIR, "former-root");
        globalThis.n5RelocatedFuigo = (threadId, instanceId, policy, relocation) => {
          const stoppedReplay = fs.existsSync(path.join(process.env.MURAGE_DATA_DIR, "relocate-" + threadId));
          if (!stoppedReplay && instanceId !== "moved" && instanceId !== "copied") return { policy, relocation };
          return { policy: { ...policy, root: formerRoot }, relocation: { previous: formerRoot, copied: stoppedReplay || instanceId === "copied" } };
        };
        ${COMMAND_STOP_FIXTURE_SOURCE}
        registerHooks({ load(url, context, next) {
          const loaded = next(url, context);
          if (url.endsWith("/server/index.ts")) {
            const source = n5ServerStop(String(loaded.source));
            return { ...loaded, source: source.replace(/policy: fuigoPolicy,\\s+relocation: fuigoRootRelocation\\(fuigoPolicy, dataRoots\\(\\).previousRoots\\(\\)\\),/,
              '...globalThis.n5RelocatedFuigo(threadId, instanceId, fuigoPolicy, fuigoRootRelocation(fuigoPolicy, dataRoots().previousRoots())),') };
          }
          if (url.endsWith("/server/drivers/acp/core.ts")) {
            const before = 'if (e instanceof CommandNeedsSession) { settle(false, "command_needs_session"); return; }';
            const during = 'const finishTurn = () => {';
            return { ...loaded, source: String(loaded.source)
              .replace(before, 'if (e instanceof CommandNeedsSession) { if (["before", "rejected"].includes(globalThis.n5RaceStage(threadId))) { await globalThis.n5WaitAtRefusal(threadId); if (globalThis.n5RaceStage(threadId) === "before") void stop("unspecified"); } settle(false, "command_needs_session"); return; }')
              .replace(during, 'const finishTurn = async () => { if (stopReason === "command_needs_session" && globalThis.n5RaceStage(threadId) === "during") { await globalThis.n5WaitAtRefusal(threadId); void stop("unspecified"); }') };
          }
          return loaded;
        } });
        const { customAcpSupport } = await import(${JSON.stringify(new URL("./custom.ts", import.meta.url).href)});
        customAcpSupport.fluxReach = () => "elsewhere";
        const file = path.join(process.env.MURAGE_DATA_DIR, "config.json");
        const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const scenario of ["named", "opaque", "variant"]) {
          cfg.instances[scenario] = { driver: "customAcp", config: { cli: ${JSON.stringify(resolve("server/testing/fake-acp-cli.ts"))} },
            environment: { FAKE_ACP_MODELS: "fixture-model", FAKE_ACP_RPC_FULL_LOG: path.join(process.env.MURAGE_DATA_DIR, scenario + ".frames"),
              FAKE_ACP_COMMANDS: JSON.stringify([{ name: "compact", description: "Compact the current conversation" }]),
              ...(scenario === "variant" ? { FAKE_ACP_VARIANT_WITHOUT_DEFAULT: "1", FAKE_ACP_THINKING_SETTABLE: "1" } : { FAKE_ACP_LOAD_ERROR: JSON.stringify(scenario === "named"
                ? { code: -32602, message: "Session not found", data: { sessionId: "fake-acp-session" } }
                : { code: -32602, message: "Invalid params", data: { reason: "bad cursor" } }) }) } };
        }
        const openGate = path.join(process.env.MURAGE_DATA_DIR, "fixture-open");
        fs.writeFileSync(openGate, "", { mode: 0o600 });
        for (const [id, driver, home] of [["pending", "fuigoAgent", ".fuigo"], ["moved", "fuigoAgent", ".fuigo"], ["copied", "fuigoAgent", ".fuigo"], ["binding", "grokAgent", ".grok"]]) {
          fs.mkdirSync(path.join(process.env.HOME, home), { recursive: true });
          fs.writeFileSync(path.join(process.env.HOME, home, "auth.json"), '{}', { mode: 0o600 });
          cfg.instances[id] = { driver, config: { cli: ${JSON.stringify(resolve("server/testing/fake-acp-cli.ts"))}, fullAuto: false },
            environment: {
              FAKE_ACP_MODELS: "fake-acp-model",
              ...(driver === "fuigoAgent" ? { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: openGate, FAKE_ACP_VERSION: "1.0.40",
                FAKE_ACP_MCP_READY_METHOD: "_fuigo/mcp_initialized", FAKE_ACP_MCP_LIST: "all:ready" } : {}),
              ...(id === "moved" ? { FAKE_ACP_LOAD_ERROR: JSON.stringify({ code: -32602, message: "Policy conflict", data: {
                policy_error: "session_policy_conflict", path: fuigoPolicyPath(process.env.MURAGE_DATA_DIR),
                message: "this session is governed by " + fuigoPolicyPath(formerRoot) + " with a different policy",
              } }) } : {}),
              FAKE_ACP_MCP_READY: "1",
              FAKE_ACP_RPC_FULL_LOG: path.join(process.env.MURAGE_DATA_DIR, id + ".frames"),
              FAKE_ACP_COMMANDS: JSON.stringify([{ name: "compact", description: "Compact the current conversation" }]),
            } };
        }
        fs.writeFileSync(file, JSON.stringify(cfg));
      `,
    });
    proof = (await api("/api/desktop-secret")).body.secret;
    expect((await api("/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  // JOINT RULING STOP-VS-REFUSAL: "If the confirmed Stop receipt exists before the refusal freezes, the turn ends silent and the card shows the Stop."
  // "If the refusal freezes while the Stop is still HELD (unconfirmed), the refusal row is shown."
  it.each([
    ["C5 named", "named"],
    ["C5 opaque", "opaque"],
    ["C7", "variant"],
    ["C8 confirmed", "named", "confirmed"],
    ["C8 held before settle", "named", "before"],
    ["C8 held during cleanup", "named", "during"],
    ["C8 rejected", "named", "rejected"],
  ])("%s refuses before a replacement session is created", async (_witness, instanceId, stage?: string) => {
    // C7 (ACP-EFFORT-PER-MODEL-1023 U2): "Engine decides" reuses a session Murage never sent a level to, so a clean variant session runs
    // /compact itself. The replacement C7 guards comes from a level Murage confirmed: the first turn sets one, the owner then switches to
    // "Engine decides", and that touched session may only be replaced, which a command turn must refuse before session/new.
    const touched = instanceId === "variant";
    const models = touched ? (await api("/api/instances?fresh=1")).body.instances.find((entry: any) => entry.instanceId === instanceId).models : undefined;
    const model = touched ? "fixture-model" : "agent-default";
    const level = models?.options.find((option: any) => option.id === model)?.variants?.find((variant: any) => variant.id !== "high")?.id;
    if (touched) expect(level, JSON.stringify(models)).toEqual(expect.any(String));
    const created = await api("/api/bots", { name: "Moss", modelSelection: { instanceId, model, ...(touched ? { variant: level } : {}) } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot;
    expect((await api(`/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }, "PATCH")).status).toBe(200);
    const send = (text: string) => api(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: randomUUID() });
    const transcript = async () => (await api(`/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
    expect((await send("Allowed ACP history sentinel")).status).toBe(202);
    await wait(bot.id);
    if (touched) {
      expect(frames(instanceId).filter(frame => frame.method === "session/set_config_option").map(frame => frame.params?.value)).toEqual([level]);
      expect((await api(`/api/bots/${bot.id}`, { modelSelection: { instanceId, model } }, "PATCH")).status).toBe(200);
    }
    const listed = await api(`/api/bots/${bot.id}/engine-commands`);
    expect(listed.body.commands, JSON.stringify((await transcript()).slice(-2))).toEqual(expect.arrayContaining([expect.objectContaining({ label: "compact" })]));
    const before = (await transcript()).length;
    const count = frames(instanceId).length;
    if (stage) writeFileSync(join(fixture.info.dataDir, "race-" + bot.threadId), stage, { mode: 0o600 });
    expect((await send("/compact")).status).toBe(202);
    if (stage) {
      const reason = await finishCommandStopRace(fixture.info.dataDir, bot.threadId, stage,
        () => api(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }), () => wait(bot.id));
      expect(reason).toBe("command_needs_session");
    } else await wait(bot.id);
    expect(frames(instanceId).slice(count).map(frame => frame.method).filter(method => method?.startsWith("session/"))).toEqual(["session/load"]);
    expect((await transcript()).slice(before)).toEqual([
      expect.objectContaining({ role: "user", text: "/compact" }),
      ...(stage === "rejected" ? [expect.objectContaining({ role: "bot", kind: "activity", tool: expect.objectContaining({
        name: expect.stringMatching(/^error: provider stop is unconfirmed;/),
      }) })] : []),
      expect.objectContaining({ role: "bot", kind: "activity", tool: expect.objectContaining({
        name: stage === "confirmed" ? expect.stringMatching(/Stopped by you/) : "send-notice:compactNeedsSession",
      }) }),
    ]);
    if (stage) return;
    expect((await send("Follow up after refusal")).status).toBe(202);
    await wait(bot.id);
    const prompt = JSON.stringify(frames(instanceId).filter(frame => frame.method === "session/prompt").at(-1)?.params);
    expect(prompt.includes("Allowed ACP history sentinel")).toBe(true);
    expect(prompt.includes("/compact")).toBe(false);
  }, 90_000);
  it.each(["moved", "copied"])("C6 refuses a command on a %s Fuigo root without announcing renewal", async instanceId => {
    expect((await api("/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
    const instance = (await api("/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
    const model = instance.models.options[0]?.id ?? "fake-acp-model";
    const created = await api("/api/bots", { name: "Moss", modelSelection: { instanceId, model } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const path = "/api/bots/" + bot.id;
    expect((await api(path, { computer: "off", browser: false, composio: false }, "PATCH")).status).toBe(200);
    const send = (text: string) => api(path + "/messages", { threadId: bot.threadId, text, sendId: randomUUID() });
    const messages = async () => (await api("/api/threads/" + bot.threadId + "/messages?limit=100")).body.messages as any[];
    expect((await send("Retained before moving the data root")).status).toBe(202);
    await wait(bot.id);
    expect((await api(path + "/engine-commands")).body.commands).toEqual(expect.arrayContaining([expect.objectContaining({ label: "compact" })]));
    const before = (await messages()).length;
    const count = frames(instanceId).length;
    expect((await send("/compact")).status).toBe(202);
    await wait(bot.id);
    expect(frames(instanceId).slice(count).map(frame => frame.method).filter(method => method?.startsWith("session/")))
      .toEqual(instanceId === "moved" ? ["session/load"] : []);
    expect((await messages()).slice(before)).toEqual([
      expect.objectContaining({ role: "user", text: "/compact" }),
      expect.objectContaining({ role: "bot", kind: "activity", tool: expect.objectContaining({ name: "send-notice:compactNeedsSession" }) }),
    ]);
  }, 90_000);

  it.each([
    ["A5 Fuigo owed replay", "pending"],
    ["A6 Grok binding moved", "binding"],
  ])("%s refuses before any driver frames", async (_witness, instanceId) => {
    if (instanceId === "pending") {
      expect((await api("/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
    }
    const instance = (await api("/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
    const model = instance.models.options[0]?.id ?? "fake-acp-model";
    const created = await api("/api/bots", { name: "Moss", modelSelection: { instanceId, model } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect((await api(`/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }, "PATCH")).status).toBe(200);
    const send = (text: string) => api(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: randomUUID() });
    expect((await send("Allowed retained history")).status).toBe(202);
    await wait(bot.id);
    expect((await api(`/api/bots/${bot.id}/engine-commands`)).body.commands).toEqual(expect.arrayContaining([expect.objectContaining({ label: "compact" })]));
    const readTask = () => {
      const profile = readBotRecords(fixture.info.dataDir).find(entry => entry.id === bot.id)!;
      return profile.tasks!.find(entry => entry.threadId === bot.threadId)!;
    };
    if (instanceId === "pending") {
      const relocation = join(fixture.info.dataDir, "relocate-" + bot.threadId);
      const gate = join(fixture.info.dataDir, "fixture-open");
      const count = frames(instanceId).length;
      writeFileSync(relocation, "", { mode: 0o600 });
      unlinkSync(gate);
      try {
        expect((await send("Begin replay after copying the data root")).status).toBe(202);
        await expect.poll(() => frames(instanceId).slice(count).some(frame => frame.method === "session/prompt"), { timeout: 15_000 }).toBe(true);
        expect(frames(instanceId).slice(count).map(frame => frame.method)).toContain("session/new");
        expect(JSON.stringify(frames(instanceId).slice(count).find(frame => frame.method === "session/prompt")?.params)).toContain("Allowed retained history");
        const stop = await api("/api/bots/" + bot.id + "/interrupt", { threadId: bot.threadId });
        expect(stop.status).toBeLessThan(300);
        await wait(bot.id);
      } finally {
        writeFileSync(gate, "", { mode: 0o600 });
        unlinkSync(relocation);
      }
    }
    await fixture.stop();
    const task = readTask();
    const cursor = task.resumeCursors[instanceId];
    if (typeof cursor !== "string") throw new Error("Fixture has no retained cursor");
    if (instanceId === "pending") {
      expect(task.replayPending?.[instanceId]).toEqual({ cursor });
    } else {
      const sessionDir = join(fixture.info.dataDir, "native", "grok-provider-context", createHash("sha256").update(bot.threadId).digest("hex"));
      const bindingFile = join(sessionDir, "resume-binding.json");
      const prior = JSON.parse(readFileSync(bindingFile, "utf8"));
      expect(prior.sessionId).toBe(cursor);
      writeFileSync(bindingFile, JSON.stringify({ ...prior, identity: createHash("sha256").update("former route").digest("hex") }), { mode: 0o600 });
    }
    await fixture.restart();
    proof = (await api("/api/desktop-secret")).body.secret;
    const count = frames(instanceId).length;
    expect(await send("/compact")).toMatchObject({ status: 409, body: { noticeCode: "compactNeedsSession" } });
    expect(frames(instanceId)).toHaveLength(count);
    expect(readTask().resumeCursors[instanceId]).toBe(cursor);
    if (instanceId === "pending") {
      expect(readTask().replayPending).toEqual(task.replayPending);
      expect((await send("Carry our retained history now")).status).toBe(202);
      await wait(bot.id);
      const replay = frames(instanceId).slice(count);
      expect(replay.find(frame => frame.method === "session/load")?.params).toMatchObject({ sessionId: cursor });
      expect(JSON.stringify(replay.find(frame => frame.method === "session/prompt")?.params)).toContain("Allowed retained history");
      await expect.poll(() => readTask().replayPending?.[instanceId]).toBeUndefined();
    }
  }, 90_000);

});
