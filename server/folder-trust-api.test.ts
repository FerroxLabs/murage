// Folder trust through the real server (0.1.52 FUIGOTRUST1): a Fuigo bot on
// the fake ACP CLI in `folder-trust` mode, which reads ./AGENTS.md into its
// reply only when it was spawned with `--trust` — the engine's own
// session-build timing. Proves the human-facing contract end to end:
//
//   1. a folder chosen in the picker is trusted at selection time, so the
//      common case never sees a card and the reply carries the folder's
//      instruction;
//   2. a bot-created folder with an AGENTS.md raises one "Trust this folder?"
//      card before the engine starts; only the owner's surface answers it;
//      Trust is remembered for the folder, logged, and honoured by that very
//      turn;
//   3. Don't trust runs the turn untrusted with a chip naming what was left
//      out, and is remembered too; forgetting the record asks again, and a
//      skip remembers nothing.
//
// Same server-spawn pattern as engine-questions-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let dump: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, headers = desktopHeaders): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const openTrustCard = async (threadId: string) => (await messages(threadId)).filter((m) => m.card?.folderTrust && !m.card.answered).at(-1);
const botText = async (threadId: string) => (await messages(threadId)).filter((m) => m.role === "bot" && m.kind === "text").map((m) => String(m.text ?? "")).join("\n");
const activities = async (threadId: string) => (await messages(threadId)).filter((m) => m.kind === "activity").map((m) => String(m.tool?.name ?? ""));
const decisions = (): any[] => {
  const path = join(home, ".murage", "decisions.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const readDump = () => JSON.parse(readFileSync(dump, "utf8"));
const trustRecord = async (folder: string) => (await request("GET", `/api/folder-trust?folder=${encodeURIComponent(folder)}`)).body;

async function makeBot(name: string) {
  const engines = (await request("GET", "/api/instances")).body.instances as any[];
  const fuigo = engines.find((engine) => engine.instanceId === "fuigo");
  expect(fuigo, `no fuigo instance among ${engines.map((e) => e.instanceId).join(",")}`).toBeTruthy();
  // model ids are free-form at the API boundary (a Flux tier would demand a
  // key); without a key the catalog is empty, and the fake ignores -m anyway
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId: "fuigo", model: "fake-acp-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  // auto mode ON: the trust card must still reach the human (ASK1's rule)
  expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}
async function send(bot: { id: string; threadId: string }, text = "go") {
  rmSync(dump, { force: true });
  const sent = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
  expect(sent, JSON.stringify(sent.body)).toMatchObject({ status: 202 });
}
async function settled(bot: { id: string; threadId: string }) {
  await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 30_000 }).toBe(false);
}
const answerTrust = (bot: { id: string }, requestId: string, label: string, headers = desktopHeaders) =>
  request("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "answer", answers: [{ id: "folderTrust", selected: [label] }] }, headers);

posixOnly("folder trust through the harness (Fuigo on the fake ACP CLI)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-folder-trust-api-"));
    dump = join(home, "fake-acp-dump.json");
    mkdirSync(join(home, ".murage"), { recursive: true });
    // a `fuigo login` install: the driver's auth gate reads ~/.fuigo/auth.json
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        engineDiscovery: "explicit",
        instances: {
          fuigo: { driver: "fuigoAgent", environment: { FAKE_ACP_MODE: "folder-trust", FAKE_ACP_DUMP: dump }, config: { cli: FAKE_ACP, fullAuto: false } },
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

  it("a folder chosen in the picker is trusted at selection time: no card, --trust on the spawn, the folder's AGENTS.md reaches the turn", async () => {
    const project = join(home, "picked-project");
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "# picked\ncanary-picked-heron\n");
    const bot = await makeBot("Picker bot");
    expect((await request("PATCH", `/api/bots/${bot.id}`, { cwd: project })).status).toBe(200);
    expect(await trustRecord(project)).toMatchObject({ gated: true, sources: ["AGENTS.md"], record: { decision: "trust", source: "picker" } });
    // and the record covers the whole workspace, not just the picked folder
    mkdirSync(join(project, "pkg"), { recursive: true });
    expect((await trustRecord(join(project, "pkg"))).record).toMatchObject({ decision: "trust" });

    await send(bot);
    await settled(bot);
    expect(await openTrustCard(bot.threadId)).toBeUndefined();
    expect((await messages(bot.threadId)).some((m) => m.card?.folderTrust)).toBe(false);
    expect(await botText(bot.threadId)).toContain("canary-picked-heron");
    const wire = readDump();
    expect(wire.argv).toContain("--trust");
    expect(wire.argv.indexOf("--trust")).toBeLessThan(wire.argv.indexOf("agent"));
    expect(wire.initialize.clientCapabilities._meta).toEqual({ "fuigo/folderTrust": { interactive: true } });
    expect(wire.folderTrust).toMatchObject({ trustedAtBuild: true, requested: false });
    expect((await activities(bot.threadId)).filter((name) => name.startsWith("untrusted folder:"))).toEqual([]);
  });

  it("a bot-created folder raises the card before the engine starts; only the owner answers; Trust is honoured by that turn, remembered and logged", async () => {
    const bot = await makeBot("Card bot");
    // the bot's private workspace is app-owned and empty; a file the bot
    // (or a prompt injection) wrote there is exactly what the gate is for
    const workspace = join(home, ".murage", "workspaces", bot.id, "threads", bot.threadId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "# planted\ncanary-card-osprey\n");
    expect((await trustRecord(workspace)).record).toBeNull();

    await send(bot);
    await expect.poll(async () => Boolean(await openTrustCard(bot.threadId)), { timeout: 20_000 }).toBe(true);
    const card = (await openTrustCard(bot.threadId))!;
    expect(card.card).toMatchObject({
      title: "Trust this folder?",
      folderTrust: { sources: ["AGENTS.md"] },
      options: ["Trust this folder", "Don't trust"],
      questions: [{ id: "folderTrust", header: "Folder trust", options: [{ label: "Trust this folder" }, { label: "Don't trust" }], allowOther: false }],
    });
    expect(card.card.questions[0].question).toContain("AGENTS.md");
    // nothing was spawned while the card waits — no argv dump yet
    expect(existsSync(dump)).toBe(false);
    // auto mode did not answer it, and it is logged as a card a rule may not answer
    expect(decisions().some((row) => row.requestId === card.card.requestId && row.decision === "card-shown" && row.source === "question")).toBe(true);

    // a companion surface (no desktop proof) cannot decide trust
    const companion = await answerTrust(bot, card.card.requestId, "Trust this folder", {});
    expect(companion.status).toBe(403);
    expect(await openTrustCard(bot.threadId)).toBeTruthy();
    // and an approval is not an answer
    expect((await request("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(400);

    const answered = await answerTrust(bot, card.card.requestId, "Trust this folder");
    expect(answered).toMatchObject({ status: 200, body: { ok: true, outcome: "answered" } });
    await settled(bot);
    expect(await botText(bot.threadId)).toContain("canary-card-osprey");
    expect(readDump().argv).toContain("--trust");
    expect(await trustRecord(workspace)).toMatchObject({ record: { decision: "trust", source: "card" } });
    expect(decisions().some((row) => row.requestId === card.card.requestId && row.decision === "folder-trusted" && row.source === "user")).toBe(true);
    const settledCard = (await messages(bot.threadId)).find((m) => m.card?.requestId === card.card.requestId)!;
    expect(settledCard.card).toMatchObject({ answered: "answer", answers: [{ id: "folderTrust", selected: ["Trust this folder"] }] });

    // the next turn in the same folder never asks again
    await send(bot, "again");
    await settled(bot);
    expect((await messages(bot.threadId)).filter((m) => m.card?.folderTrust)).toHaveLength(1);
    expect(readDump().argv).toContain("--trust");
  });

  it("Don't trust runs untrusted with a chip naming what was left out and is remembered; forgetting asks again; a skip remembers nothing", async () => {
    const bot = await makeBot("Reject bot");
    const workspace = join(home, ".murage", "workspaces", bot.id, "threads", bot.threadId);
    mkdirSync(join(workspace, ".fuigo", "skills"), { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "# planted\ncanary-reject-kestrel\n");

    await send(bot);
    await expect.poll(async () => Boolean(await openTrustCard(bot.threadId)), { timeout: 20_000 }).toBe(true);
    const card = (await openTrustCard(bot.threadId))!;
    expect(card.card.folderTrust.sources).toEqual(["AGENTS.md", ".fuigo/skills"]);
    expect((await answerTrust(bot, card.card.requestId, "Don't trust")).status).toBe(200);
    await settled(bot);
    expect(await botText(bot.threadId)).toContain("agents: withheld");
    expect(await botText(bot.threadId)).not.toContain("canary-reject-kestrel");
    expect(readDump().argv).not.toContain("--trust");
    expect(readDump().decision).toEqual({ outcome: "reject" });
    expect(await activities(bot.threadId)).toContain("untrusted folder: AGENTS.md, .fuigo/skills");
    expect((await activities(bot.threadId)).filter((name) => name.startsWith("error:"))).toEqual([]);
    expect(await trustRecord(workspace)).toMatchObject({ record: { decision: "reject", source: "card" } });
    expect(decisions().some((row) => row.requestId === card.card.requestId && row.decision === "folder-untrusted")).toBe(true);

    // remembered: the next turn gets the chip, not a card
    await send(bot, "again");
    await settled(bot);
    expect((await messages(bot.threadId)).filter((m) => m.card?.folderTrust)).toHaveLength(1);
    expect((await activities(bot.threadId)).filter((name) => name === "untrusted folder: AGENTS.md, .fuigo/skills")).toHaveLength(2);

    // forget it: the card comes back; a skip is an honest no-answer that
    // records nothing, so it would come back once more
    expect((await request("DELETE", `/api/folder-trust?folder=${encodeURIComponent(workspace)}`)).status).toBe(200);
    expect((await trustRecord(workspace)).record).toBeNull();
    await send(bot, "third");
    await expect.poll(async () => (await messages(bot.threadId)).filter((m) => m.card?.folderTrust).length, { timeout: 20_000 }).toBe(2);
    const again = (await openTrustCard(bot.threadId))!;
    expect((await request("POST", `/api/bots/${bot.id}/respond`, { requestId: again.card.requestId, behavior: "skip" })).status).toBe(200);
    await settled(bot);
    expect((await trustRecord(workspace)).record).toBeNull();
    expect(readDump().argv).not.toContain("--trust");
    expect((await messages(bot.threadId)).find((m) => m.card?.requestId === again.card.requestId)!.card.answered).toBe("skipped");
  });
});
