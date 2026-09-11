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
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/** The fixture server: a `fuigo login` install (auth.json) whose Fuigo is
 * the fake ACP CLI in folder-trust mode, plus a second instance whose fake
 * finishes the prompt while its own trust request is still open. */
async function bootServer(homeDir: string, port: number): Promise<{ child: ChildProcess; desktop: Record<string, string> }> {
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(join(homeDir, ".murage"), { recursive: true });
  mkdirSync(join(homeDir, ".fuigo"), { recursive: true });
  writeFileSync(join(homeDir, ".fuigo", "auth.json"), "{}");
  // FUIGOTRUST3 (4): a second Fuigo install with its own FUIGO_HOME (and so
  // its own trusted_folders.toml), the way an instance configured with an
  // environment override runs
  mkdirSync(join(homeDir, "other-fuigo-home"), { recursive: true });
  writeFileSync(join(homeDir, "other-fuigo-home", "auth.json"), "{}");
  const dumpFile = join(homeDir, "fake-acp-dump.json");
  writeFileSync(
    join(homeDir, ".murage", "config.json"),
    JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        fuigo: { driver: "fuigoAgent", environment: { FAKE_ACP_MODE: "folder-trust", FAKE_ACP_DUMP: dumpFile }, config: { cli: FAKE_ACP, fullAuto: false } },
        "fuigo-late": { driver: "fuigoAgent", environment: { FAKE_ACP_MODE: "folder-trust", FAKE_ACP_DUMP: dumpFile, FAKE_ACP_TRUST_PROMPT_FIRST: "1" }, config: { cli: FAKE_ACP, fullAuto: false } },
        "fuigo-other-home": { driver: "fuigoAgent", environment: { FAKE_ACP_MODE: "folder-trust", FAKE_ACP_DUMP: dumpFile, FUIGO_HOME: join(homeDir, "other-fuigo-home") }, config: { cli: FAKE_ACP, fullAuto: false } },
      },
    }),
  );
  const proc = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: homeDir,
      USERPROFILE: homeDir,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", (c) => (stderr += c));
  proc.stdout!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = (await fetch(`${url}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
  return { child: proc, desktop: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } };
}

async function makeBot(name: string, instanceId = "fuigo") {
  const engines = (await request("GET", "/api/instances")).body.instances as any[];
  const fuigo = engines.find((engine) => engine.instanceId === instanceId);
  expect(fuigo, `no ${instanceId} instance among ${engines.map((e) => e.instanceId).join(",")}`).toBeTruthy();
  // model ids are free-form at the API boundary (a Flux tier would demand a
  // key); without a key the catalog is empty, and the fake ignores -m anyway
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-acp-model" } });
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
    ({ child, desktop: desktopHeaders } = await bootServer(home, port));
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
    // (the decision log is an async queued append — decision-log.ts `drain` —
    // so the row can land a moment after the card is visible)
    await expect.poll(() => decisions().some((row) => row.requestId === card.card.requestId && row.decision === "card-shown" && row.source === "question"), { timeout: 5_000 }).toBe(true);

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
    await expect.poll(() => decisions().some((row) => row.requestId === card.card.requestId && row.decision === "folder-trusted" && row.source === "user"), { timeout: 5_000 }).toBe(true);
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
    await expect.poll(() => decisions().some((row) => row.requestId === card.card.requestId && row.decision === "folder-untrusted"), { timeout: 5_000 }).toBe(true);

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

  // ── FUIGOTRUST2 follow-ups ──────────────────────────────────────────────

  it("(2) a folder the user's own Fuigo install trusts never sees a card or a withheld chip — even over a Murage 'Don't trust' — and the picker says so", async () => {
    const bot = await makeBot("Upstream bot");
    const workspace = join(home, ".murage", "workspaces", bot.id, "threads", bot.threadId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "# planted\ncanary-upstream-egret\n");
    // first: Murage's own Don't trust, remembered
    await send(bot);
    await expect.poll(async () => Boolean(await openTrustCard(bot.threadId)), { timeout: 20_000 }).toBe(true);
    const card = (await openTrustCard(bot.threadId))!;
    expect((await answerTrust(bot, card.card.requestId, "Don't trust")).status).toBe(200);
    await settled(bot);
    expect(await botText(bot.threadId)).not.toContain("canary-upstream-egret");
    expect((await activities(bot.threadId)).filter((name) => name === "untrusted folder: AGENTS.md")).toHaveLength(1);
    expect(await trustRecord(workspace)).toMatchObject({ upstreamTrusted: false, record: { decision: "reject" } });

    // then the person runs `fuigo --trust` in that folder: the engine's own
    // store trusts it (its canonical key), which the engine reads before it
    // ever asks Murage
    writeFileSync(join(home, ".fuigo", "trusted_folders.toml"), `[folders."${realpathSync.native(workspace)}"]\ntrusted = true\ndecided_at = 1789152451\n`);
    try {
      expect(await trustRecord(workspace)).toMatchObject({ upstreamTrusted: true, record: { decision: "reject" } });
      await send(bot, "again");
      await settled(bot);
      // no second card, the reply carries the instruction, and no chip
      // claims the folder was untrusted: Murage did not lie about the turn
      expect((await messages(bot.threadId)).filter((m) => m.card?.folderTrust)).toHaveLength(1);
      expect(await botText(bot.threadId)).toContain("canary-upstream-egret");
      expect((await activities(bot.threadId)).filter((name) => name === "untrusted folder: AGENTS.md")).toHaveLength(1);
      const wire = readDump();
      // Murage passes no --trust of its own and rewrites nothing; the engine's store spoke
      expect(wire.argv).not.toContain("--trust");
      expect(wire.folderTrust, JSON.stringify(wire.argv)).toMatchObject({ trustedAtBuild: true, requested: false });
      // and Murage's record is untouched: nothing new was recorded
      expect(await trustRecord(workspace)).toMatchObject({ upstreamTrusted: true, record: { decision: "reject", source: "card" } });
    } finally {
      rmSync(join(home, ".fuigo", "trusted_folders.toml"), { force: true });
    }
  });

  // FUIGOTRUST3 (2): Murage's own release lanes are linked git worktrees; a
  // standalone `fuigo --trust` on the main checkout covers them, and so
  // must the picker note and the turn
  it("(2b) a bot in a linked git worktree runs under the main checkout's standalone grant: the picker says upstream, no card, no --trust, no chip, AGENTS.md read", async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: home } });
    const main = join(home, "main-checkout");
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q", ".");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const lane = join(home, "lane-worktree");
    git(main, "worktree", "add", "-q", "-b", "lane", lane);
    writeFileSync(join(lane, "AGENTS.md"), "# lane\ncanary-worktree-heron\n");
    const bot = await makeBot("Worktree bot");
    // picked, then forgotten: Murage has no record of its own and would
    // raise the card for the worktree's AGENTS.md — but the user's own
    // Fuigo trusts the main checkout, which the engine keys the worktree on
    writeFileSync(join(home, ".fuigo", "trusted_folders.toml"), `[folders."${realpathSync.native(main)}"]\ntrusted = true\ndecided_at = 1789152451\n`);
    try {
      expect((await request("PATCH", `/api/bots/${bot.id}`, { cwd: lane })).status).toBe(200);
      // the picker recorded the worktree under the main checkout's key
      expect(await trustRecord(main)).toMatchObject({ record: { decision: "trust", source: "picker" } });
      expect((await request("DELETE", `/api/folder-trust?folder=${encodeURIComponent(lane)}`)).status).toBe(200);
      expect((await trustRecord(main)).record).toBeNull();
      // the picker note: the worktree keys on the main checkout, which the
      // user's own Fuigo trusts
      const status = await trustRecord(lane);
      expect(status).toMatchObject({ key: realpathSync.native(main), folder: realpathSync.native(lane), sources: ["AGENTS.md"], gated: true, upstreamTrusted: true });
      await send(bot);
      await settled(bot);
      expect((await messages(bot.threadId)).filter((m) => m.card?.folderTrust)).toHaveLength(0);
      expect(await botText(bot.threadId)).toContain("canary-worktree-heron");
      expect(await activities(bot.threadId)).not.toContain("untrusted folder: AGENTS.md");
      const wire = readDump();
      expect(wire.argv).not.toContain("--trust");
      expect(wire.folderTrust, JSON.stringify(wire)).toMatchObject({ trustedAtBuild: true, requested: false });
      expect((await trustRecord(lane)).record).toBeNull();
    } finally {
      rmSync(join(home, ".fuigo", "trusted_folders.toml"), { force: true });
    }
  });

  // FUIGOTRUST3 (4): the picker note reads the store of the bot's OWN
  // instance, not the first Fuigo install's
  it("(4) GET /api/folder-trust?bot= reads the trusted_folders.toml of that bot's instance; without a bot, the first Fuigo instance's", async () => {
    const project = join(home, "two-homes-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "# two homes\n");
    const first = await makeBot("First-home bot", "fuigo");
    const other = await makeBot("Other-home bot", "fuigo-other-home");
    const status = (folder: string, botId?: string) => request("GET", `/api/folder-trust?folder=${encodeURIComponent(folder)}${botId ? `&bot=${botId}` : ""}`);
    // only the OTHER install trusts the folder
    writeFileSync(join(home, "other-fuigo-home", "trusted_folders.toml"), `[folders."${realpathSync.native(project)}"]\ntrusted = true\ndecided_at = 1789152451\n`);
    try {
      expect((await status(project)).body).toMatchObject({ upstreamTrusted: false });
      expect((await status(project, first.id)).body).toMatchObject({ upstreamTrusted: false });
      expect((await status(project, other.id)).body).toMatchObject({ upstreamTrusted: true, sources: ["AGENTS.md"] });
      // and the other way round: only the FIRST install trusts it
      rmSync(join(home, "other-fuigo-home", "trusted_folders.toml"), { force: true });
      writeFileSync(join(home, ".fuigo", "trusted_folders.toml"), `[folders."${realpathSync.native(project)}"]\ntrusted = true\ndecided_at = 1789152451\n`);
      expect((await status(project)).body).toMatchObject({ upstreamTrusted: true });
      expect((await status(project, first.id)).body).toMatchObject({ upstreamTrusted: true });
      expect((await status(project, other.id)).body).toMatchObject({ upstreamTrusted: false });
      // an unknown bot is an error, not silently the first install
      expect((await status(project, "no-such-bot")).status).toBe(404);
      // the note under the other bot's picker matches what its turn does:
      // its engine's store does not trust the folder, so (picked, then
      // forgotten) the card is raised
      expect((await request("PATCH", `/api/bots/${other.id}`, { cwd: project })).status).toBe(200);
      expect((await request("DELETE", `/api/folder-trust?folder=${encodeURIComponent(project)}`)).status).toBe(200);
      expect((await status(project, other.id)).body).toMatchObject({ upstreamTrusted: false, record: null });
      await send(other);
      await expect.poll(async () => Boolean(await openTrustCard(other.threadId)), { timeout: 20_000 }).toBe(true);
      const card = (await openTrustCard(other.threadId))!;
      expect((await answerTrust(other, card.card.requestId, "Don't trust")).status).toBe(200);
      await settled(other);
      expect(readDump().argv).not.toContain("--trust");
      expect((await status(project, other.id)).body).toMatchObject({ upstreamTrusted: false, record: { decision: "reject" } });
    } finally {
      rmSync(join(home, ".fuigo", "trusted_folders.toml"), { force: true });
      rmSync(join(home, "other-fuigo-home", "trusted_folders.toml"), { force: true });
    }
  });

  it("(3) picker trust is recorded only with desktop authority: a companion cannot grant it through the task picker, and the card then goes to the owner", async () => {
    const bot = await makeBot("Task picker bot");
    const project = join(home, "task-project");
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "# picked\ncanary-task-crane\n");
    const companion = { "x-murage-companion": "1" };
    // a paired device: the working folder is a desktop setting (404 to a companion), and nothing is recorded
    const remote = await request("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { cwd: project }, companion);
    expect(remote.status).toBe(404);
    expect((await trustRecord(project)).record).toBeNull();
    // the desktop's broad bot patch is a desktop-authority route outright
    const remoteBot = await request("PATCH", `/api/bots/${bot.id}`, { cwd: project }, companion);
    expect(remoteBot.status).toBeGreaterThanOrEqual(400);
    expect((await trustRecord(project)).record).toBeNull();
    // the owner's desktop: the task picker sets the folder AND records it
    const desktop = await request("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { cwd: project });
    expect(desktop.status).toBe(200);
    expect(desktop.body.task).toMatchObject({ cwd: project });
    expect(await trustRecord(project)).toMatchObject({ record: { decision: "trust", source: "picker" } });
    await send(bot);
    await settled(bot);
    expect((await messages(bot.threadId)).some((m) => m.card?.folderTrust)).toBe(false);
    expect(await botText(bot.threadId)).toContain("canary-task-crane");
  });

  it("(4) importing a team as a project records the chosen folder as picker-trusted", async () => {
    const seed = await request("POST", "/api/bots", { name: "Importer", title: "Lead", description: "Plans", color: "purple" });
    expect(seed.status).toBe(201);
    const exported = await request("POST", "/api/teams/export", { name: "Trust Team" });
    expect(exported.status).toBe(200);
    const project = join(home, "imported-project");
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "# imported\n");
    // a companion cannot import at all, so it cannot record either
    const remote = await request("POST", `/api/teams/import?mode=project&cwd=${encodeURIComponent(project)}`, exported.body, { "x-murage-companion": "1" });
    expect(remote.status).toBeGreaterThanOrEqual(400);
    expect((await trustRecord(project)).record).toBeNull();
    const created = await request("POST", `/api/teams/import?mode=project&cwd=${encodeURIComponent(project)}`, exported.body);
    expect(created.status).toBe(201);
    expect(created.body.group).toMatchObject({ cwd: project });
    expect(await trustRecord(project)).toMatchObject({ record: { decision: "trust", source: "picker" } });
  });

  it("(6) when the engine asks late and the turn finishes first, the card says the turn ran untrusted and the chip names what was asked about", async () => {
    // the server's scan names nothing (an empty private workspace), so no
    // card before the spawn; the engine's fake still asks, and answers the
    // prompt at once — the turn outruns the card
    const bot = await makeBot("Late bot", "fuigo-late");
    await send(bot);
    await expect.poll(async () => (await messages(bot.threadId)).some((m) => m.card?.folderTrust), { timeout: 20_000 }).toBe(true);
    await settled(bot);
    const card = (await messages(bot.threadId)).find((m) => m.card?.folderTrust)!;
    expect(card.card).toMatchObject({ answered: "expired", expired: true, folderTrust: { sources: ["AGENTS.md / CLAUDE.md"], late: "finished" } });
    expect(await activities(bot.threadId)).toContain("untrusted folder: AGENTS.md / CLAUDE.md");
    expect(await botText(bot.threadId)).toContain("agents: withheld");
    expect(readDump().decision).toEqual({ outcome: "reject" });
    // the turn was not stopped: no "stopped:" chip
    expect((await activities(bot.threadId)).filter((name) => name.startsWith("stopped:"))).toEqual([]);
  });

  // FINAL1: a thread's second turn is either RESUMED (session/load on the
  // cursor) or FRESH (session/new with the history replayed), and with memory
  // active which one depends on whether the memory worker indexed the first
  // turn before the second dispatched (memoryContinuationChanged: a changed
  // bundle drops the cursor). That is legitimate product behaviour, but it
  // made (2) timing-dependent: under the 48-worker full run (locale1-fix1)
  // the resumed path won, and the fake engine of the day ran its trust
  // prompt after session/new only, so the dump carried no folderTrust and
  // the case failed; the rerun took the fresh path and passed. The fake now
  // asks after session/load too, as the engine does (FUIGOTRUST3). This
  // case pins the resumed path deterministically — memory off, so the
  // dispatch keeps the cursor and the driver always sends session/load —
  // so that branch of the fixture cannot regress behind memory timing again.
  it("(7) a resumed turn (session/load) is gated like a fresh one: the engine's own grant is honoured with no card, and a remembered 'Don't trust' is answered from the record with a chip", async () => {
    const memory = (mode: "off" | "active") => request("POST", "/api/memory/action", { action: "configure", mode });
    expect((await memory("off")).status).toBe(200);
    const bot = await makeBot("Resume bot");
    const workspace = join(home, ".murage", "workspaces", bot.id, "threads", bot.threadId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "# planted\ncanary-resume-plover\n");
    const toml = join(home, ".fuigo", "trusted_folders.toml");
    const chips = async () => (await activities(bot.threadId)).filter((name) => name === "untrusted folder: AGENTS.md");
    const cards = async () => (await messages(bot.threadId)).filter((m) => m.card?.folderTrust);
    try {
      // first turn: a fresh session (session/new writes the mcpServers the
      // fake was handed), the card, Don't trust — the engine then asks after
      // session/new and Murage answers from the record it just wrote
      await send(bot);
      await expect.poll(async () => Boolean(await openTrustCard(bot.threadId)), { timeout: 20_000 }).toBe(true);
      const card = (await openTrustCard(bot.threadId))!;
      expect((await answerTrust(bot, card.card.requestId, "Don't trust")).status).toBe(200);
      await settled(bot);
      const first = readDump();
      expect(first.mcpServers).toBeDefined();
      expect(first.folderTrust).toMatchObject({ trustedAtBuild: false, requested: true });
      expect(first.decision).toEqual({ outcome: "reject" });
      expect(await chips()).toHaveLength(1);

      // second turn, RESUMED (no mcpServers: the fake answered session/load,
      // never session/new): the person's own `fuigo --trust` grant is read
      // by the engine at build, so no prompt, no card, no chip, and the
      // instruction reaches the reply — the (2) contract on the other path
      writeFileSync(toml, `[folders."${realpathSync.native(workspace)}"]\ntrusted = true\ndecided_at = 1789152451\n`);
      await send(bot, "again");
      await settled(bot);
      const resumed = readDump();
      expect(resumed.mcpServers, JSON.stringify(Object.keys(resumed))).toBeUndefined();
      expect(resumed.argv).not.toContain("--trust");
      expect(resumed.folderTrust, JSON.stringify(resumed)).toMatchObject({ trustedAtBuild: true, requested: false });
      expect(resumed.decision).toBeUndefined();
      expect(await cards()).toHaveLength(1);
      expect(await chips()).toHaveLength(1);
      expect(await botText(bot.threadId)).toContain("canary-resume-plover");
      expect(await trustRecord(workspace)).toMatchObject({ upstreamTrusted: true, record: { decision: "reject", source: "card" } });

      // third turn, still resumed, grant gone: the engine asks after
      // session/load and Murage answers from its remembered Don't trust —
      // a chip, no second card, the instruction withheld
      rmSync(toml, { force: true });
      await send(bot, "third");
      await settled(bot);
      const third = readDump();
      expect(third.mcpServers).toBeUndefined();
      expect(third.argv).not.toContain("--trust");
      expect(third.folderTrust).toMatchObject({ trustedAtBuild: false, requested: true });
      expect(third.decision).toEqual({ outcome: "reject" });
      expect(await cards()).toHaveLength(1);
      expect(await chips()).toHaveLength(2);
      expect((await activities(bot.threadId)).filter((name) => name.startsWith("error:"))).toEqual([]);
    } finally {
      rmSync(toml, { force: true });
      expect((await memory("active")).status).toBe(200);
    }
  });
});

// (5) upgrade: folders bots, tasks and rooms already worked in before 0.1.52
// were chosen by the person in Murage, so the first boot records them once.
posixOnly("upgrade seed of pre-0.1.52 working folders", () => {
  let seedHome: string;
  let seedBase: string;
  let seedChild: ChildProcess | null = null;
  let seedDesktop: Record<string, string>;
  let port: number;
  const projectA = () => join(seedHome, "repo-a");
  const projectB = () => join(seedHome, "plain-b");
  const roomFolder = () => join(seedHome, "room-c");
  const req = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${seedBase}${path}`, { method, headers: { ...seedDesktop, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const record = async (folder: string) => (await req("GET", `/api/folder-trust?folder=${encodeURIComponent(folder)}`)).body;
  const boot = async () => {
    ({ child: seedChild, desktop: seedDesktop } = await bootServer(seedHome, port));
  };
  const stop = async () => {
    if (seedChild) await waitForExit(seedChild, { signal: "SIGTERM" });
    seedChild = null;
  };

  beforeAll(async () => {
    port = await freePortBlock([0, 1]);
    seedBase = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    seedHome = mkdtempSync(join(tmpdir(), "murage-folder-trust-seed-"));
    mkdirSync(join(seedHome, ".murage"), { recursive: true });
    mkdirSync(join(projectA(), ".git"), { recursive: true });
    writeFileSync(join(projectA(), "AGENTS.md"), "# a\ncanary-seed-ibis\n");
    mkdirSync(join(projectB(), "nested"), { recursive: true });
    mkdirSync(roomFolder(), { recursive: true });
    // a 0.1.51 store: a bot working in repo-a, one of its tasks pinned to a
    // subfolder of plain-b, a room on room-c, and a task pinned to a
    // bot-created private workspace (never seeded: the gate exists for it)
    const managed = join(seedHome, ".murage", "workspaces", "bot-old", "threads", "thread-managed");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(seedHome, ".murage", "bots.json"), JSON.stringify([
      { id: "bot-old", threadId: "thread-old", name: "Old bot", cwd: projectA(), modelSelection: { instanceId: "fuigo", model: "fake-acp-model" }, tasks: [
        { threadId: "thread-old", cwd: join(projectB(), "nested") },
        { threadId: "thread-managed", cwd: managed },
      ] },
    ]));
    writeFileSync(join(seedHome, ".murage", "groups.json"), JSON.stringify([
      { id: "room-old", threadId: "thread-room", name: "Old room", memberIds: ["bot-old"], cwd: roomFolder() },
    ]));
    await boot();
  }, 40_000);

  afterAll(async () => {
    await stop();
    await removeTempDir(seedHome);
  });

  it("the first boot records every pre-existing working folder once; a Forget survives a restart; the seed never re-runs", async () => {
    expect(await record(projectA())).toMatchObject({ record: { decision: "trust", source: "upgrade" } });
    expect(await record(join(projectB(), "nested"))).toMatchObject({ record: { decision: "trust", source: "upgrade" } });
    expect(await record(roomFolder())).toMatchObject({ record: { decision: "trust", source: "upgrade" } });
    // the bot-created workspace is not a human's choice
    const managed = join(seedHome, ".murage", "workspaces", "bot-old", "threads", "thread-managed");
    expect((await record(managed)).record).toBeNull();
    const persisted = JSON.parse(readFileSync(join(seedHome, ".murage", "folder-trust.json"), "utf8"));
    expect(persisted).toMatchObject({ version: 1, seededFrom: "0.1.52" });
    expect(Object.keys(persisted.folders)).toHaveLength(3);
    expect(stderr).toContain("[folder-trust] recorded 3 folder");

    // and the seeded bot's first turn in repo-a asks nothing
    const bots = (await req("GET", "/api/bots?messages=0")).body.bots as any[];
    const old = bots.find((b) => b.id === "bot-old");
    expect(old).toBeTruthy();
    const patched = await req("PATCH", `/api/bots/bot-old`, { settingsScope: "defaults", autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false });
    expect(patched, JSON.stringify(patched.body)).toMatchObject({ status: 200 });
    expect((await req("POST", `/api/bots/bot-old/messages`, { threadId: "thread-old", text: "go" })).status).toBe(202);
    await expect.poll(async () => (await req("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === "bot-old")?.busy, { timeout: 30_000 }).toBe(false);
    const rows = (await req("GET", `/api/threads/thread-old/messages?limit=200`)).body.messages as any[];
    expect(rows.some((m) => m.card?.folderTrust)).toBe(false);

    // Forget one, restart: the seed does not put it back, the others stay
    expect((await req("DELETE", `/api/folder-trust?folder=${encodeURIComponent(projectA())}`)).status).toBe(200);
    await stop();
    await boot();
    expect((await record(projectA())).record).toBeNull();
    expect(await record(roomFolder())).toMatchObject({ record: { decision: "trust", source: "upgrade" } });
    expect(Object.keys(JSON.parse(readFileSync(join(seedHome, ".murage", "folder-trust.json"), "utf8")).folders)).toHaveLength(2);
    // logged once, on the first boot only (the fixture suite's own fresh
    // store above logged its empty seed separately)
    expect((stderr.match(/\[folder-trust\] recorded 3 folders/g) ?? [])).toHaveLength(1);
  }, 60_000);
});
