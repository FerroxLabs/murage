// FUIGO-TRUST-V2 through the real server, with the opt-in pool on: the records
// are the recovery surface. What can say no is exactly what GET lists, DELETE
// key= forgets any of it, and a process that learned something is never kept.
// The engine is the fake ACP CLI's 1.0.35 protocol (FAKE_ACP_TRUST_V=2).
// Same server-spawn pattern as folder-trust-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
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
let trustLog: string;
let spawnLog: string;
let output = "";

const request = async (method: string, path: string, body?: unknown, headers = desktopHeaders): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const openCard = async (threadId: string) => (await messages(threadId)).filter((m) => m.card?.folderTrust && !m.card.answered).at(-1);
const activities = async (threadId: string) => (await messages(threadId)).filter((m) => m.kind === "activity").map((m) => String(m.tool?.name ?? ""));
const decisions = (): any[] => {
  const path = join(home, ".murage", "decisions.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
const spawnCount = () => lines(spawnLog).length;
const trustEvents = () => lines(trustLog).map((line) => JSON.parse(line)) as Array<{ event: string; pid: number; raw?: string; params?: any }>;
const requestsFor = (key: string) => trustEvents().filter((entry) => entry.event === "request" && entry.params.workspace === key).length;
const storeFile = () => join(home, ".murage", "folder-trust.json");
const stored = () => (existsSync(storeFile()) ? JSON.parse(readFileSync(storeFile(), "utf8")).folders : {}) as Record<string, any>;

const K_TOPOLOGY = () => join(home, "topology-main");
const K_SEQUENCE = () => join(home, "sequence-main");
const K_SIBLING = () => join(home, "sibling");
const K_HELD = () => join(home, "held-main");

async function bootServer(homeDir: string, port: number): Promise<{ child: ChildProcess; desktop: Record<string, string> }> {
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(join(homeDir, ".murage"), { recursive: true });
  mkdirSync(join(homeDir, ".fuigo"), { recursive: true });
  writeFileSync(join(homeDir, ".fuigo", "auth.json"), "{}");
  const engine = (extra: Record<string, string> = {}) => ({
    driver: "fuigoAgent",
    environment: { FAKE_ACP_MODE: "folder-trust", FAKE_ACP_TRUST_V: "2", FAKE_ACP_MCP_READY: "1", FAKE_ACP_TRUST_LOG: trustLog, FAKE_ACP_SPAWN_LOG: spawnLog, ...extra },
    config: { cli: FAKE_ACP, fullAuto: false },
  });
  writeFileSync(join(homeDir, ".murage", "config.json"), JSON.stringify({
    defaultModel: { instanceId: "fuigo", model: "fake-acp-model" },
    instances: {
      fuigo: engine(),
      "fuigo-topology": engine({ FAKE_ACP_TRUST_WORKSPACE: K_TOPOLOGY() }),
      "fuigo-sequence": engine({ FAKE_ACP_TRUST_WORKSPACE: K_SEQUENCE() }),
      "fuigo-sibling": engine({ FAKE_ACP_TRUST_WORKSPACE: K_SIBLING() }),
      "fuigo-held": engine({ FAKE_ACP_TRUST_HOLD_MS: "1500", FAKE_ACP_TRUST_WORKSPACE: K_HELD() }),
      "fuigo-plain": engine({ FAKE_ACP_TRUST_KINDS: "" }),
      "fuigo-1037": engine({ FAKE_ACP_VERSION: "1.0.37" }),
      computer: { driver: "boxAgent" },
    },
  }));
  const proc = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: homeDir,
      USERPROFILE: homeDir,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      MURAGE_MODEL_PROVIDER_CONNECTIONS: "",
      MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
      MURAGE_ACP_POOL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", (c) => (output += c));
  proc.stdout!.on("data", (c) => (output += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = (await fetch(`${url}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
  return { child: proc, desktop: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } };
}

async function makeBot(name: string, instanceId = "fuigo") {
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-acp-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}
/** A raise to Full access or above goes through its review, as the app does. */
async function raise(bot: { id: string }, targetLevel: string, flags: object) {
  const seen = (await request("POST", `/api/bots/${bot.id}/permissions/refresh`, { scope: "open", targetLevel })).body;
  const saved = await request("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", previewId: seen.previewId, ifRev: seen.botRev, ...flags });
  expect(saved.status).toBe(200);
  return request("POST", `/api/bots/${bot.id}/permissions/refresh`, { scope: "open", rosterId: seen.rosterId, targetLevel: seen.targetLevel, afterRev: saved.body.bot?.permissionRev ?? saved.body.permissionRev });
}
const workspaceOf = (bot: { id: string; threadId: string }) => join(home, ".murage", "workspaces", bot.id, "threads", bot.threadId);
async function send(bot: { id: string; threadId: string }, text = "go") {
  const sent = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
  expect(sent, JSON.stringify(sent.body)).toMatchObject({ status: 202 });
}
async function settled(bot: { id: string; threadId: string }) {
  await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 30_000 }).toBe(false);
}
async function turn(bot: { id: string; threadId: string }, text = "go") {
  await send(bot, text);
  await settled(bot);
}
async function card(bot: { threadId: string }) {
  await expect.poll(async () => Boolean(await openCard(bot.threadId)), { timeout: 20_000 }).toBe(true);
  return (await openCard(bot.threadId))!.card;
}
const answer = (bot: { id: string }, requestId: string, label: string) =>
  request("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "answer", answers: [{ id: "folderTrust", selected: [label] }] });
const skip = (bot: { id: string }, requestId: string) => request("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "skip" });
const list = async (folder: string) => (await request("GET", `/api/folder-trust?folder=${encodeURIComponent(folder)}`)).body;
const forget = (key: string, extra = "") => request("DELETE", `/api/folder-trust?key=${encodeURIComponent(key)}${extra}`);
/** Answer the card this bot's next turn raises. */
async function decide(bot: { id: string; threadId: string }, label: "Trust this folder" | "Don't trust") {
  await send(bot);
  const open = await card(bot);
  expect((await answer(bot, open.requestId, label)).status).toBe(200);
  await settled(bot);
}

posixOnly("FUIGO-TRUST-V2 through the harness (generation 2, pooled)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = realpathSync(mkdtempSync(join(tmpdir(), "murage-folder-trust-v2-api-")));
    trustLog = join(home, "trust.log");
    spawnLog = join(home, "spawns.log");
    ({ child, desktop: desktopHeaders } = await bootServer(home, port));
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("(rule 3b, wiring) a folder the owner picked raises no card on his No limits turn on Fuigo 1.0.37, and still does at Auto", async () => {
    const picked = (name: string) => { const folder = join(home, name); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "AGENTS.md"), "x\n"); return folder; };
    const auto = await makeBot("Picked at Auto");
    const atAuto = picked("picked-auto");
    expect((await request("PATCH", `/api/bots/${auto.id}`, { cwd: atAuto })).status).toBe(200);
    await send(auto);
    const open = await card(auto);
    expect((await skip(auto, open.requestId)).status).toBe(200);
    await settled(auto);

    const owner = await makeBot("Picked at No limits", "fuigo-1037");
    const atNoLimits = picked("picked-no-limits");
    expect((await request("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(200);
    expect((await raise(owner, "no-limits", { fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    expect((await request("PATCH", `/api/bots/${owner.id}`, { cwd: atNoLimits })).status).toBe(200);
    await turn(owner);
    expect(requestsFor(atNoLimits)).toBe(1);
    expect(JSON.parse(trustEvents().filter((entry) => entry.event === "reply").at(-1)!.raw!).result).toEqual({ outcome: "reject" });
    expect(await openCard(owner.threadId)).toBeUndefined();
    expect(stored()[atNoLimits]).toMatchObject({ decision: "trust", source: "picker" });
    expect(stored()[atNoLimits].consent).not.toBe(2);
  }, 40_000);

  it("(1) the combined topology: a reject at the main checkout answers a bot elsewhere, is listed, and Forget brings the card back", async () => {
    const sibling = await makeBot("Sibling", "fuigo-sibling");
    await decide(sibling, "Don't trust");
    const owner = await makeBot("Declines", "fuigo-topology");
    await decide(owner, "Don't trust");
    expect(stored()[K_TOPOLOGY()]).toMatchObject({ decision: "reject", source: "card", consent: 2, folder: workspaceOf(owner) });

    const other = await makeBot("Elsewhere", "fuigo-topology");
    await turn(other);
    expect(await openCard(other.threadId)).toBeUndefined();
    const chips = await activities(other.threadId);
    expect(chips.filter((name) => name.startsWith("untrusted folder:"))).toEqual([`untrusted folder: AGENTS.md / CLAUDE.md :: forget ${K_TOPOLOGY()}`]);

    const listed = await list(workspaceOf(other));
    expect(listed.records.find((row: any) => row.key === K_TOPOLOGY())).toMatchObject({ decision: "reject", consent: 2, onPath: false });
    const spawned = spawnCount();
    const asked = requestsFor(K_TOPOLOGY());
    expect(await forget(K_TOPOLOGY())).toMatchObject({ status: 200, body: { ok: true } });
    expect(stored()[K_TOPOLOGY()]).toBeUndefined();
    await expect.poll(() => decisions().some((row) => row.decision === "folder-forgotten" && row.summary === K_TOPOLOGY()), { timeout: 5_000 }).toBe(true);

    await send(other, "again");
    const open = await card(other);
    expect(open.folderTrust).toMatchObject({ key: K_TOPOLOGY(), v2: true });
    expect(spawnCount()).toBeGreaterThan(spawned);
    expect(requestsFor(K_TOPOLOGY())).toBe(asked + 1);
    expect((await answer(other, open.requestId, "Trust this folder")).status).toBe(200);
    await settled(other);
    expect(stored()[K_TOPOLOGY()]).toMatchObject({ decision: "trust", consent: 2 });
    // the sibling's reject survived every step
    expect(stored()[K_SIBLING()]).toMatchObject({ decision: "reject" });
  }, 60_000);

  it("(2) the r5 sequence: the parked process stays silent, the list still holds K, and Forget starts a new process that asks", async () => {
    const decider = await makeBot("Decider", "fuigo-sequence");
    await decide(decider, "Don't trust");
    const bot = await makeBot("Sequence", "fuigo-sequence");
    await turn(bot);
    const after1 = { spawns: spawnCount(), asks: requestsFor(K_SEQUENCE()) };
    // the digest is equal: adopted, and the fake's dedup sends no request
    await turn(bot, "two");
    expect(spawnCount()).toBe(after1.spawns);
    expect(requestsFor(K_SEQUENCE())).toBe(after1.asks);
    // negative control: nothing changed, so a third turn adopts again
    await turn(bot, "three");
    expect(spawnCount()).toBe(after1.spawns);
    expect((await list(workspaceOf(bot))).records.map((row: any) => row.key)).toContain(K_SEQUENCE());
    expect((await forget(K_SEQUENCE())).status).toBe(200);
    await send(bot, "four");
    const open = await card(bot);
    expect(spawnCount()).toBe(after1.spawns + 1);
    expect(requestsFor(K_SEQUENCE())).toBe(after1.asks + 1);
    expect((await skip(bot, open.requestId)).status).toBe(200);
    await settled(bot);
    expect(stored()[K_SEQUENCE()]).toBeUndefined();
  }, 60_000);

  it("(5, N7.4) DELETE key= only narrows, by two layers of authority", async () => {
    const bot = await makeBot("Narrow", "fuigo-sibling");
    expect(stored()[K_SIBLING()]).toBeTruthy();
    const before = readFileSync(storeFile(), "utf8");
    expect(await forget(join(home, "not-stored"))).toMatchObject({ status: 404, body: { error: "no such record" } });
    expect(await forget("")).toMatchObject({ status: 404 });
    expect(readFileSync(storeFile(), "utf8")).toBe(before);
    // route layer: no proof gets the unknown route, a companion a refusal
    expect((await request("DELETE", `/api/folder-trust?key=${encodeURIComponent(K_SIBLING())}`, undefined, {})).status).toBe(404);
    expect([403, 404]).toContain((await request("DELETE", `/api/folder-trust?key=${encodeURIComponent(K_SIBLING())}`, undefined, { "x-murage-companion": "1" })).status);
    expect(readFileSync(storeFile(), "utf8")).toBe(before);
    // handler layer, behind the route: the desktop check comes before the store is touched
    const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
    const check = source.indexOf('if (method === "DELETE" && url.searchParams.has("key"))');
    expect(check).toBeGreaterThan(-1);
    const guard = source.indexOf('requestSurface(req.headers, url.searchParams) !== "desktop"', check);
    const write = source.indexOf("folderTrust.forgetKey(", check);
    expect(guard).toBeGreaterThan(check);
    expect(guard).toBeLessThan(write);
    // a stored key unrelated to the named folder is the owner's own decision
    const keys = Object.keys(stored());
    expect((await forget(K_SIBLING(), `&folder=${encodeURIComponent(workspaceOf(bot))}`)).status).toBe(200);
    // the whole file changed by exactly one removal
    expect(Object.keys(stored()).sort()).toEqual(keys.filter((key) => key !== K_SIBLING()).sort());
  }, 30_000);

  it("(N7.6) an unstamped trust is listed with Forget, never answers, and the card follows", async () => {
    const bot = await makeBot("Legacy");
    const folder = workspaceOf(bot);
    mkdirSync(folder, { recursive: true });
    expect((await request("POST", "/api/folder-trust", { bot: bot.id, thread: bot.threadId })).status).toBe(200);
    const row = (await list(folder)).records.find((candidate: any) => candidate.key === folder);
    expect(row).toMatchObject({ decision: "trust", onPath: true });
    expect(row.consent).toBeUndefined();
    await send(bot);
    const open = await card(bot);
    expect(open.folderTrust).toMatchObject({ key: folder, v2: true });
    expect((await skip(bot, open.requestId)).status).toBe(200);
    await settled(bot);
    expect((await forget(folder)).status).toBe(200);
    expect((await list(folder)).records.find((candidate: any) => candidate.key === folder)).toBeUndefined();
  }, 40_000);

  it("(7) rule 2, rule 4 and skipped cards write nothing; the card, the picker, POST and the seed are the only writers", async () => {
    const decider = await makeBot("Bound decider", "fuigo-sequence");
    await decide(decider, "Don't trust");
    const before = readFileSync(storeFile(), "utf8");
    // 50 folders, one each: 46 answered by rule 2, 2 at Full access with nothing to bring in, 2 skipped
    const rule2 = await Promise.all(Array.from({ length: 46 }, (_, index) => makeBot(`Bound rule 2 ${index}`, "fuigo-sequence")));
    const full = await Promise.all(Array.from({ length: 2 }, (_, index) => makeBot(`Bound full ${index}`, "fuigo-plain")));
    for (const bot of full) {
      expect((await raise(bot, "full", { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
    }
    const skippers = await Promise.all(Array.from({ length: 2 }, (_, index) => makeBot(`Bound skip ${index}`)));
    for (let round = 0; round < 4; round += 1) {
      for (const bot of [...rule2, ...full]) await turn(bot, `round ${round}`);
      for (const bot of skippers) {
        await send(bot, `round ${round}`);
        expect((await skip(bot, (await card(bot)).requestId)).status).toBe(200);
        await settled(bot);
      }
    }
    expect(readFileSync(storeFile(), "utf8")).toBe(before);
    // a handler that does not write cannot write: the writers are named here
    const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
    expect(source.match(/folderTrust\.remember\(/g)).toHaveLength(3);
    expect(source.match(/folderTrust\.seedOnce\(/g)).toHaveLength(1);
    const core = readFileSync(join(SERVER_DIR, "drivers", "acp", "core.ts"), "utf8");
    expect(core).not.toMatch(/new FolderTrustStore|folderTrust\.remember\(/);
    expect((await forget(K_SEQUENCE())).status).toBe(200);
  }, 240_000);

  it("(6) GET does not change a reply: records never reach a turn", async () => {
    const bot = await makeBot("Reads");
    await send(bot);
    const first = await card(bot);
    for (let read = 0; read < 3; read += 1) await list(workspaceOf(bot));
    expect((await skip(bot, first.requestId)).status).toBe(200);
    await settled(bot);
    expect(Object.keys(stored())).not.toContain(workspaceOf(bot));
  }, 30_000);

  describe("(12) the new-card pool sequence: Forget in either order", () => {
    const closes = (bot: { threadId: string }, reason: string) => output.split("\n").filter((line) => line.includes(`acp close thread=${bot.threadId}`) && line.includes(`reason=${reason}`)).length;

    it("(a) Don't trust, Forget after the settle: closed with the reason, the next turn asks", async () => {
      const bot = await makeBot("Card after");
      const key = workspaceOf(bot);
      await send(bot);
      const open = await card(bot);
      const spawned = spawnCount();
      expect((await answer(bot, open.requestId, "Don't trust")).status).toBe(200);
      await settled(bot);
      expect(closes(bot, "folder-trust-card")).toBe(1);
      expect(stored()[key]).toMatchObject({ decision: "reject", consent: 2 });
      expect((await forget(key)).status).toBe(200);
      await send(bot, "two");
      const again = await card(bot);
      expect(again.folderTrust.key).toBe(key);
      expect(spawnCount()).toBeGreaterThan(spawned);
      expect((await skip(bot, again.requestId)).status).toBe(200);
      await settled(bot);
    }, 40_000);

    it("(b) Don't trust, Forget while the turn still runs: the same", async () => {
      const bot = await makeBot("Card during", "fuigo-held");
      await send(bot);
      const open = await card(bot);
      expect((await answer(bot, open.requestId, "Don't trust")).status).toBe(200);
      await expect.poll(() => Boolean(stored()[K_HELD()]), { timeout: 5_000 }).toBe(true);
      const running = (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy;
      expect(running).toBe(true);
      expect((await forget(K_HELD())).status).toBe(200);
      await settled(bot);
      expect(closes(bot, "folder-trust-card")).toBe(1);
      await send(bot, "two");
      const again = await card(bot);
      expect(again.folderTrust.key).toBe(K_HELD());
      expect((await skip(bot, again.requestId)).status).toBe(200);
      await settled(bot);
    }, 40_000);

    it("(c) Trust, Forget after the settle: closed, and the owner's own Fuigo keeps its grant, so nothing asks", async () => {
      const bot = await makeBot("Trust after");
      const key = workspaceOf(bot);
      await send(bot);
      const open = await card(bot);
      expect((await answer(bot, open.requestId, "Trust this folder")).status).toBe(200);
      await settled(bot);
      expect(closes(bot, "folder-trust-card")).toBe(1);
      expect((await forget(key)).status).toBe(200);
      const asked = requestsFor(key);
      await turn(bot, "two");
      expect(requestsFor(key)).toBe(asked);
      expect(await openCard(bot.threadId)).toBeUndefined();
    }, 40_000);

    it("(c) Trust, Forget while the turn still runs: the same", async () => {
      rmSync(join(home, ".fuigo", "trusted_folders.toml"), { force: true });
      const bot = await makeBot("Trust during", "fuigo-held");
      await send(bot);
      const open = await card(bot);
      expect((await answer(bot, open.requestId, "Trust this folder")).status).toBe(200);
      await expect.poll(() => Boolean(stored()[K_HELD()]), { timeout: 5_000 }).toBe(true);
      expect((await forget(K_HELD())).status).toBe(200);
      await settled(bot);
      expect(closes(bot, "folder-trust-card")).toBe(1);
      const asked = requestsFor(K_HELD());
      await turn(bot, "two");
      expect(requestsFor(K_HELD())).toBe(asked);
    }, 40_000);
  });
});
