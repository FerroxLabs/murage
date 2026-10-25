// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q4 (207) EXTENDED: the widget journey on an engine with no tools, through the real server. The engine is the in-process
// fixture server/testing/fake-ask-driver.ts in its text-only shape (no agents server mounted), standing in for openai-chat and
// openai-compat (server/drivers/http-text-only.ts and headless-text-only.ts are memory-reflection transports, not chat engines).
// The bot writes a ```murage-widget fence; the assistant-text fold makes it a widget row once per message (with `fenceOf`),
// through the same normaliser and after the same refusals as a question fence; the owner fills it and the bot's next turn reads
// those answers. An invalid fence, a password field, and a fence from words nobody proved are the owner's stay text.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
let fixture: VerificationServer;
let headers: Record<string, string> = {};
const BOOKING = {
  type: "Card", title: "Book a call", confirm: { label: "Book it", action: { type: "book" } },
  children: [
    { type: "DatePicker", name: "date", label: "Date" },
    { type: "TimePicker", name: "time", label: "Time" },
    { type: "Select", name: "length", label: "Length", options: [{ label: "30 minutes", value: "30" }, { label: "1 hour", value: "60" }] },
  ],
};
const fence = (body: unknown, before = "Here is a form:") => `${before}\n\n\`\`\`murage-widget\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}\n\`\`\`\n`;
const askDir = () => join(fixture.info.dataDir, "ask");
const api = async (method: string, path: string, body?: unknown, proven = true) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(proven ? headers : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const connect = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const idle = async (id: string) => { await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id)?.busy, { timeout: 20000 }).toBe(false); };
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const widgets = async (threadId: string) => (await messages(threadId)).filter((message) => message.widget !== undefined);
const turnsWith = (threadId: string, words: string) => {
  const path = join(askDir(), "dump.jsonl");
  return (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [])
    .filter((row: any) => !row.steer && row.threadId === threadId && String(row.text).includes(words));
};
const reset = () => { for (const name of ["hold", "agents-env.json", "live", "release", "reply.txt"]) rmSync(join(askDir(), name), { force: true }); };
const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const createBot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "text", model: "ask-1" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};

describe.skipIf(process.platform === "win32")("a bot with no tools shows a widget with a fence (QW Q4)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const dataDir=process.env.MURAGE_DATA_DIR;
      const askDir=path.join(dataDir,'ask');fs.mkdirSync(askDir,{recursive:true});
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "drivers", "builtIn.ts")).href)});
      const { makeAskDriver } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-ask-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeAskDriver());
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.text={driver:'fakeAsk',displayName:'Text only',environment:{FAKE_ASK_DIR:askDir}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    mkdirSync(join(fixture.info.dataDir, "ask"), { recursive: true });
    await connect();
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("B-207: the bot shows a date, time and length form with a fence; the owner fills it and the bot continues with those answers", async () => {
    const bot = await createBot("Widget fence");
    reset();
    // the second widget fence is the valid one: an invalid fence stays text and keeps its own place in the count
    writeFileSync(join(askDir(), "reply.txt"), `${fence("{not json")}${fence(BOOKING, "And:")}`);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "help me book a call" })).status).toBe(202);
    await idle(bot.id);
    await expect.poll(async () => (await widgets(bot.threadId)).length, { timeout: 15000 }).toBe(1);
    const said = (await messages(bot.threadId)).find((message) => message.role === "bot" && message.kind === "text" && message.text?.includes("murage-widget"));
    const [row] = await widgets(bot.threadId);
    expect(row.widget.fenceOf).toEqual({ messageId: said.id, index: 1 });
    expect(said.text).toContain("{not json");
    await quiet(400);
    expect(await widgets(bot.threadId)).toHaveLength(1);

    const pressed = await api("POST", `/api/threads/${bot.threadId}/widgets/${row.widget.id}/respond`, { ref: "confirm", values: { date: "2026-10-21", time: "15:00", length: "30" } });
    expect(pressed.status).toBe(200);
    const words = "Book it:\nDate: 2026-10-21\nTime: 15:00\nLength: 30 minutes";
    await expect.poll(() => turnsWith(bot.threadId, words).length, { timeout: 15000 }).toBe(1);
    await idle(bot.id);
    const line = (await messages(bot.threadId)).find((message) => message.role === "user" && message.sendId === `widget-${row.widget.id}`);
    expect(line).toMatchObject({ kind: "text", text: words });
  }, 60000);

  it("a password field, an over-limit tree and a fence from unproven words stay text; a restart materialises nothing", async () => {
    const bot = await createBot("Widget fence refusals");
    for (const reply of [
      fence({ type: "Card", children: [{ type: "Input", name: "pw", inputType: "password" }] }),
      fence({ type: "Card", children: [{ type: "Text", value: "x".repeat(40_000) }] }),
      "Thinking:\n\n```murage-widget\n" + JSON.stringify(BOOKING),
    ]) {
      reset();
      writeFileSync(join(askDir(), "reply.txt"), reply);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "show me a form" })).status).toBe(202);
      await idle(bot.id);
    }
    reset();
    writeFileSync(join(askDir(), "reply.txt"), fence(BOOKING));
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "show me a form, unproven" }, false)).status).toBe(202);
    await idle(bot.id);
    await quiet(500);
    expect(await widgets(bot.threadId)).toEqual([]);
    await fixture.restart();
    await connect();
    await quiet(800);
    expect(await widgets(bot.threadId)).toEqual([]);
  }, 90000);
});
