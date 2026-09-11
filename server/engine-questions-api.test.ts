// Every engine's "ask the owner" request, end to end through the real server
// (0.1.52 ASK3): Codex item/tool/requestUserInput, Fuigo's
// _fuigo/ask_user_question over ACP, an ACP elicitation/create form, and a
// pi `select`. Each bot runs the way every live bot does — auto mode on and
// the AI reviewer in enforce — because that is the configuration that used
// to answer questions with nothing. Each question must:
//
//   1. become a question card carrying the engine's own questions, with no
//      auto-approval and no review;
//   2. take the owner's answers through /respond with the same validation as
//      the desktop card, and deliver them in the engine's own reply shape;
//   3. refuse an approval, and skip as an honest no-answer.
//
// The fake engines write the exact reply they received to a dump file, so the
// wire shape is asserted, not inferred. Same server-spawn pattern as
// decision-log-wiring.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...desktopHeaders, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const openQuestionCard = async (threadId: string) => (await messages(threadId)).filter((m) => m.card?.questions?.length && !m.card.answered).at(-1);
const decisions = (): any[] => {
  const path = join(home, ".murage", "decisions.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const dumpRows = (file: string): any[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

/** A bot on `instanceId` in the configuration that used to lose questions. */
async function makeBot(name: string, instanceId: string, model: string) {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "enforce", computer: "off" })).status).toBe(200);
  return bot;
}
async function ask(bot: { id: string; threadId: string }, text = "go") {
  expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
  await expect.poll(async () => Boolean(await openQuestionCard(bot.threadId)), { timeout: 20000 }).toBe(true);
  return (await openQuestionCard(bot.threadId))!;
}
async function settled(bot: { id: string; threadId: string }) {
  await expect.poll(async () => (await request("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 20000 }).toBe(false);
}

posixOnly("engine questions through the harness", () => {
  let dumps: string;
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    for (const cli of [FAKE_ACP, FAKE_CODEX, FAKE_PI]) chmodSync(cli, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-engine-questions-"));
    dumps = join(home, "dumps");
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(dumps, { recursive: true });
    // grok's ACP support requires a sign-in marker
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "auth.json"), "{}");
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        engineDiscovery: "explicit",
        instances: {
          fuigoish: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "fuigo-question", FAKE_ACP_DUMP: join(dumps, "fuigo.json") }, config: { cli: FAKE_ACP, fullAuto: false } },
          elicit: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "elicitation-form", FAKE_ACP_DUMP: join(dumps, "elicit.json") }, config: { cli: FAKE_ACP, fullAuto: false } },
          codex: { driver: "codex", environment: { FAKE_CODEX_MODE: "user-input", FAKE_CODEX_DUMP: join(dumps, "codex.json") }, config: { cli: FAKE_CODEX, fullAuto: true } },
          pi: { driver: "piAgent", environment: { FAKE_PI_MODE: "permission", FAKE_PI_DUMP: join(dumps, "pi.jsonl") }, config: { cli: FAKE_PI, fullAuto: false } },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = (await fetch(`${base}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("Codex requestUserInput: every question on the card, answers per id, never auto-approved even in fullAuto", async () => {
    const bot = await makeBot("Codex asker", "codex", "gpt-fake-default");
    const card = await ask(bot, "set it up");
    expect(card.card).toMatchObject({
      title: "Your bot has a question",
      questions: [
        { id: "db", header: "Database", options: [{ label: "Postgres", description: "Relational, durable" }, { label: "Redis", description: "In-memory, fast" }] },
        { id: "token", secret: true, allowOther: true },
        { id: "region", allowOther: true },
      ],
    });
    expect(card.card.tool).toBeUndefined();
    expect(card.card.allowKey).toBeUndefined();
    expect(decisions().some((row) => row.decision === "auto-approved" && row.botId === bot.id)).toBe(false);
    expect((await messages(bot.threadId)).some((m) => /auto-approved/.test(m.tool?.name ?? ""))).toBe(false);

    // an approval is not an answer
    expect((await request("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(400);
    // a label that was never offered is refused before the engine sees it
    const bad = await request("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "answer",
      answers: [{ id: "db", selected: ["Mongo"] }, { id: "token", selected: [], other: "t" }, { id: "region", selected: ["eu-west"] }],
    });
    expect(bad.status).toBe(400);
    const answered = await request("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "answer",
      answers: [{ id: "db", selected: ["Redis"] }, { id: "token", selected: [], other: "tok_secret_9" }, { id: "region", selected: [], other: "Frankfurt" }],
    });
    expect(answered.body).toEqual({ ok: true, outcome: "answered" });
    await settled(bot);
    expect(JSON.parse(readFileSync(join(dumps, "codex.json"), "utf8")).decision).toEqual({
      answers: { db: { answers: ["Redis"] }, token: { answers: ["tok_secret_9"] }, region: { answers: ["Frankfurt"] } },
    });
    // the card keeps the answers read-only, minus the secret one
    const after = (await messages(bot.threadId)).find((m) => m.id === card.id);
    expect(after.card.answered).toBe("answer");
    expect(after.card.answers).toEqual([{ id: "db", selected: ["Redis"] }, { id: "region", selected: [], other: "Frankfurt" }]);
    expect(JSON.stringify(await messages(bot.threadId))).not.toContain("tok_secret_9");
    expect(JSON.stringify(decisions())).not.toContain("tok_secret_9");
  }, 60_000);

  it("Fuigo ask_user_question over ACP: text-keyed answers with Other plus notes; a skip is a cancelled outcome", async () => {
    const bot = await makeBot("Fuigo asker", "fuigoish", "fake-model");
    const card = await ask(bot);
    expect(card.card.questions).toMatchObject([
      { id: "q1", question: "Which database?", multiSelect: false, allowOther: true },
      { id: "q2", question: "Which frameworks?", multiSelect: true, allowOther: true },
    ]);
    const answered = await request("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "answer",
      answers: [{ id: "q1", selected: [], other: "SQLite" }, { id: "q2", selected: ["React", "Vue"] }],
    });
    expect(answered.body).toEqual({ ok: true, outcome: "answered" });
    await settled(bot);
    expect(JSON.parse(readFileSync(join(dumps, "fuigo.json"), "utf8")).decision).toEqual({
      outcome: "accepted",
      answers: { "Which database?": ["Other"], "Which frameworks?": ["React", "Vue"] },
      annotations: { "Which database?": { notes: "SQLite" } },
    });

    const again = await ask(bot);
    expect((await request("POST", `/api/bots/${bot.id}/respond`, { requestId: again.card.requestId, behavior: "skip" })).body).toEqual({ ok: true, outcome: "rejected" });
    await settled(bot);
    expect(JSON.parse(readFileSync(join(dumps, "fuigo.json"), "utf8")).decision).toEqual({ outcome: "cancelled" });
    expect(decisions().filter((row) => row.decision === "question-skipped" && row.botId === bot.id)).toHaveLength(1);
    const after = (await messages(bot.threadId)).find((m) => m.id === again.id);
    expect(after.card.answered).toBe("skipped");
  }, 60_000);

  it("ACP elicitation form: schema fields become questions and the accept carries typed content", async () => {
    const bot = await makeBot("Elicitor", "elicit", "fake-model");
    const card = await ask(bot, "deploy");
    expect(card.card.questions).toMatchObject([
      { id: "environment", options: [{ label: "staging" }, { label: "production" }] },
      { id: "features", multiSelect: true },
      { id: "confirm", options: [{ label: "Yes" }, { label: "No" }] },
    ]);
    // a single-select takes one pick
    expect((await request("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "answer",
      answers: [{ id: "environment", selected: ["staging", "production"] }, { id: "features", selected: ["cdn"] }, { id: "confirm", selected: ["Yes"] }],
    })).status).toBe(400);
    const answered = await request("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "answer",
      answers: [{ id: "environment", selected: ["production"] }, { id: "features", selected: ["cache", "cdn"] }, { id: "confirm", selected: ["No"] }],
    });
    expect(answered.body).toEqual({ ok: true, outcome: "answered" });
    await settled(bot);
    expect(JSON.parse(readFileSync(join(dumps, "elicit.json"), "utf8")).decision).toEqual({
      action: "accept",
      content: { environment: "production", features: ["cache", "cdn"], confirm: false },
    });
  }, 60_000);

  it("pi select: the dialog's options on the card, {value} back to pi, and auto mode never answers it", async () => {
    const bot = await makeBot("Pi asker", "pi", "ollama-cloud/glm-5.2");
    const card = await ask(bot);
    expect(card.card).toMatchObject({
      subtitle: "Run bash: echo hi?",
      options: ["Allow once", "Deny"],
      questions: [{ id: "q1", question: "Run bash: echo hi?", options: [{ label: "Allow once" }, { label: "Deny" }], allowOther: false }],
    });
    expect(decisions().some((row) => row.decision === "auto-approved" && row.botId === bot.id)).toBe(false);
    // free text is refused where the dialog offers only its options
    expect((await request("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId, behavior: "answer", answers: [{ id: "q1", selected: [], other: "maybe" }],
    })).status).toBe(400);
    const answered = await request("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId, behavior: "answer", answers: [{ id: "q1", selected: ["Allow once"] }],
    });
    expect(answered.body).toEqual({ ok: true, outcome: "answered" });
    await settled(bot);
    expect(dumpRows(join(dumps, "pi.jsonl")).filter((row) => row.uiResponse)).toEqual([
      { uiResponse: { type: "extension_ui_response", id: "ask-1", value: "Allow once" } },
    ]);
  }, 60_000);
});
