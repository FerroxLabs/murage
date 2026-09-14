import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

type Bot = { id: string; threadId: string };
type BotState = { id: string; busy: boolean };
type ThreadMessage = { role: string; text?: string; turnId?: string };

describe("Stop completion notification wiring", () => {
  let fixture: VerificationServer;
  let headers: Record<string, string>;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return await response.json() as T;
  };
  beforeAll(async () => {
    // Adapt only the existing fake driver: partial text at acceptance,
    // completion held by a file, and delayed cancelled terminal on Stop.
    const instrumentationSource = [
      "const fs = await import('node:fs'); const path = await import('node:path');",
      "const { registerHooks } = await import('node:module');",
      "registerHooks({ load(url, context, nextLoad) {",
      "if (!url.endsWith('/fake-late-terminal-driver.ts')) return nextLoad(url, context);",
      "let source = fs.readFileSync(new URL(url), 'utf8');",
      "if (!source.includes('setTimeout(() => {')) throw new Error('fixture anchor changed');",
      "source = source.replace('setTimeout(() => {', 'emit({ type: \"item.completed\", itemType: \"assistant_text\", text: \"Partial answer\", threadId: turn.threadId, turnId }); void waitForFile(input.environment.FAKE_FINISH_PREFIX + turnId).then(() => {').replace('}, 25);', '});').replace('ok: false, stopReason: \"interrupted\"', 'ok: true, stopReason: \"cancelled\"');",
      "return { format: 'module-typescript', shortCircuit: true, source }; }});",
      "const { BUILT_IN_DRIVERS } = await import(" + JSON.stringify(new URL("./drivers/builtIn.ts", import.meta.url).href) + ");",
      "const { makeLateTerminalDriver } = await import(" + JSON.stringify(new URL("./testing/fake-late-terminal-driver.ts", import.meta.url).href) + ");",
      "BUILT_IN_DRIVERS.push(makeLateTerminalDriver());",
      "const dir = process.env.MURAGE_DATA_DIR; const file = path.join(dir, 'config.json'); const config = JSON.parse(fs.readFileSync(file, 'utf8'));",
      "config.instances.late = { driver: 'fakeLateTerminal', environment: { FAKE_LATE_TERMINAL_GATE: path.join(dir, 'terminal'), FAKE_FINISH_PREFIX: path.join(dir, 'finish-') }}; fs.writeFileSync(file, JSON.stringify(config));",
    ].join("\n");
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as unknown;
    if (!proof || typeof proof !== "object" || !("secret" in proof) || typeof proof.secret !== "string") {
      throw new Error("desktop secret response did not include a string secret");
    }
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    await api<Record<string, never>>("POST", "/api/memory/action", { action: "configure", mode: "off" });
    console.log("P2 fixture " + fixture.info.url + "; log " + fixture.info.logPath);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const barrier = async (stream: SseRecorder, botId: string, name: string) => {
    await api("PATCH", "/api/bots/" + botId, { name });
    await stream.until(frame => frame.kind === "bot" && frame.bot?.id === botId && frame.bot?.name === name);
  };
  const notices = (stream: SseRecorder, threadId: string) => stream.frames.filter(frame => frame.kind === "notify" && frame.notification?.threadId === threadId).map(frame => frame.notification.kind);
  const send = async (bot: Bot, text: string, previous = "") => {
    await api<Record<string, never>>("POST", "/api/bots/" + bot.id + "/messages", { threadId: bot.threadId, text });
    let turnId = "";
    await expect.poll(async () => {
      const view = await api<{ messages: ThreadMessage[] }>("GET", "/api/threads/" + bot.threadId + "/messages?limit=100");
      turnId = view.messages.filter((message) => message.role === "bot" && message.text === "Partial answer" && message.turnId !== previous).at(-1)?.turnId ?? "";
      return turnId;
    }).not.toBe("");
    return turnId;
  };

  it.each([false, true])("cancelled partial reply stays silent with replacement=%s; completed reply notifies", async (replacement) => {
    rmSync(join(fixture.info.dataDir, "terminal"), { force: true });
    rmSync(join(fixture.info.dataDir, "terminal.emitted"), { force: true });
    const { bot } = await api<{ bot: Bot }>("POST", "/api/bots", { name: "Stopped", modelSelection: { instanceId: "late", model: "late-1" } });
    await api<Record<string, never>>("PATCH", "/api/bots/" + bot.id, { notifications: true, computer: "off" });
    const stream = await openSse(fixture.info.url + "/api/events");
    try {
      await stream.until(frame => frame.kind === "hello");
      const stopped = await send(bot, "Stop this partial response");
      await api("POST", "/api/bots/" + bot.id + "/interrupt", { threadId: bot.threadId });
      let completed = replacement ? await send(bot, "Replacement response", stopped) : "";
      writeFileSync(join(fixture.info.dataDir, "terminal"), "release");
      await expect.poll(() => existsSync(join(fixture.info.dataDir, "terminal.emitted"))).toBe(true);
      await barrier(stream, bot.id, "Cancelled settled");
      expect(notices(stream, bot.threadId)).toEqual([]);
      if (replacement) {
        const state = await api<{ bots: BotState[] }>("GET", "/api/bots?messages=0");
        expect(state.bots.find((candidate) => candidate.id === bot.id)?.busy).toBe(true);
      } else completed = await send(bot, "Completed response", stopped);
      writeFileSync(join(fixture.info.dataDir, "finish-" + completed), "release");
      await stream.until(frame => frame.kind === "notify" && frame.notification?.threadId === bot.threadId && frame.notification?.kind === "done");
      await barrier(stream, bot.id, "Completed settled");
      expect(notices(stream, bot.threadId)).toEqual(["done"]);
    } finally { stream.close(); }
  }, 30_000);
});
