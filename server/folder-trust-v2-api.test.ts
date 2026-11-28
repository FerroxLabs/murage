import { fixtureDisplayedResponse, fixtureDisplayRequest } from "./testing/display-http-fixture.ts";
import { fakeEngineServerArgs } from "./testing/fake-engine-server.ts";
// FUIGO-TRUST-V2 through the real server, with the opt-in pool on: the records
// are the recovery surface. What can say no is exactly what GET lists, DELETE
// key= forgets any of it, and a process that learned something is never kept.
// The engine is the fake ACP CLI's 1.0.35 protocol (FAKE_ACP_TRUST_V=2).
// Same server-spawn pattern as folder-trust-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");

let base: string;
let serverOutput = "";
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let trustLog: string;
let spawnLog: string;
let output = "";

const request = async (method: string, path: string, body?: unknown, headers = desktopHeaders): Promise<{ status: number; body: any }> => {
  body = fixtureDisplayRequest(join(home, ".murage/messages.db"), path, body);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: fixtureDisplayedResponse(join(home, ".murage/messages.db"), await res.json().catch(() => null)) };
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
const poolTrace = (threadId: string) => lines(join(home, ".murage", "native", `${threadId}.ndjson`))
  .map(line => JSON.parse(line).msg)
  .filter(msg => msg?.acpPool || ["spawn_requested", "turn_settled"].includes(msg?.phase));
const trustEvents = () => lines(trustLog).map((line) => JSON.parse(line)) as Array<{ event: string; pid: number; raw?: string; params?: any }>;
const requestsFor = (key: string) => trustEvents().filter((entry) => entry.event === "request" && entry.params.workspace === key).length;
const storeFile = () => join(home, ".murage", "folder-trust.json");
const stored = () => (existsSync(storeFile()) ? JSON.parse(readFileSync(storeFile(), "utf8")).folders : {}) as Record<string, any>;

const K_TOPOLOGY = () => join(home, "topology-main");
const K_SEQUENCE = () => join(home, "sequence-main");
const K_WRITERS = () => join(home, "writers-main");
const K_SIBLING = () => join(home, "sibling");
const K_HELD = () => join(home, "held-main");

async function bootServer(homeDir: string, port: number): Promise<{ child: ChildProcess; desktop: Record<string, string> }> {
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(join(homeDir, ".murage"), { recursive: true });
  mkdirSync(join(homeDir, ".fuigo"), { recursive: true });
  writeFileSync(join(homeDir, ".fuigo", "auth.json"), "{}");
  // F15 Rule 3 row: a Trust an earlier card left (consent 2), as a 1.0.23 install carries it; only a V2 card answer writes one.
  const storedTrustFolder = join(homeDir, "f15-auto-stored-trust-over-project-hooks");
  writeFileSync(join(homeDir, ".murage", "folder-trust.json"), JSON.stringify({ version: 1, folders: {
    [storedTrustFolder]: { decision: "trust", decidedAt: Date.now(), source: "card", folder: storedTrustFolder, consent: 2 },
    // F15 (1.0.24): the owner's own turn is never carded, so the saved "no" rows (1), (2), (5) and (7) build on are the ones a 1.0.23 card left
    ...Object.fromEntries(["topology-main", "sequence-main", "writers-main", "sibling"].map((name) => [join(homeDir, name),
      { decision: "reject", decidedAt: Date.now(), source: "card", folder: join(homeDir, name), consent: 2 }])) } }));
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
      "fuigo-writers": engine({ FAKE_ACP_TRUST_WORKSPACE: K_WRITERS() }),
      "fuigo-sibling": engine({ FAKE_ACP_TRUST_WORKSPACE: K_SIBLING() }),
      "fuigo-held": engine({ FAKE_ACP_TRUST_HOLD_MS: "1500", FAKE_ACP_TRUST_WORKSPACE: K_HELD() }),
      "fuigo-plain": engine({ FAKE_ACP_TRUST_KINDS: "" }),
      "fuigo-1037": engine({ FAKE_ACP_VERSION: "1.0.37", FAKE_ACP_TRUST_FORCE_REQUEST: "1" }),
      "fuigo-1038": engine({ FAKE_ACP_VERSION: "1.0.38", FAKE_ACP_TRUST_FORCE_REQUEST: "1" }),
      "fuigo-1038-hooks": engine({ FAKE_ACP_VERSION: "1.0.38", FAKE_ACP_TRUST_FORCE_REQUEST: "1", FAKE_ACP_TRUST_KINDS: "instructions,hooks" }),
      "fuigo-1038-permission": engine({ FAKE_ACP_VERSION: "1.0.38", FAKE_ACP_TRUST_FORCE_REQUEST: "1", FAKE_ACP_TRUST_KINDS: "instructions,permission" }),
      "fuigo-unpicked": engine({ FAKE_ACP_VERSION: "1.0.38", FAKE_ACP_TRUST_FORCE_REQUEST: "1", FAKE_ACP_TRUST_WORKSPACE: join(home, "e5-not-picked-key") }),
      computer: { driver: "boxAgent" },
    },
  }));
  // Only native execution is faked. Trust, owner authority, cards and replies
  // still run through the real child server, including the Full access control.
  // The r5 pool is for unmounted sessions. Advertise the fixture's actual tool support without changing the real Fuigo adapter.
  const poolFixture = join(homeDir, "pool-fixture.mjs");
  const driver = pathToFileURL(join(SERVER_DIR, "drivers", "acp", "fuigo.ts")).href;
  writeFileSync(poolFixture, `
    import { FuigoAgentDriver } from ${JSON.stringify(driver)};
    const create = FuigoAgentDriver.create.bind(FuigoAgentDriver);
    FuigoAgentDriver.create = async (input) => {
      const instance = await create(input);
      if (input.instanceId === "fuigo-sequence") {
        Object.defineProperties(instance.adapter.capabilities, { agentsMcp: { value: false }, memoryMcp: { value: false } });
      }
      return instance;
    };
  `);
  const proc = spawn(process.execPath, fakeEngineServerArgs("--import", poolFixture, join(SERVER_DIR, "index.ts")), {
    windowsHide: true,
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
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", (c) => (output += c));
  proc.stdout!.on("data", (c) => { output += c; serverOutput=(serverOutput+c).slice(-20000); });
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
/** F15: wait for the settle OR a folder-trust card, then require that none showed (a card holds the turn busy, so a plain settle
 * would time out before the no-card assertion is reached). */
async function noCardUntilIdle(bot: { id: string; threadId: string }) {
  const busy = async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy;
  await expect.poll(async () => Boolean(await openCard(bot.threadId)) || (await busy()) === false, { timeout: 30_000 }).toBe(true);
  expect((await messages(bot.threadId)).filter((m) => m.card?.folderTrust)).toEqual([]);
  await settled(bot);
}
async function turnWithoutCard(bot: { id: string; threadId: string }, text = "go") {
  await send(bot, text);
  await noCardUntilIdle(bot);
}
async function card(bot: { threadId: string }) {
  await expect.poll(async () => Boolean(await openCard(bot.threadId)), { timeout: 20_000 }).toBe(true);
  return (await openCard(bot.threadId))!.card;
}
const skip = (bot: { id: string }, requestId: string) => request("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "skip" });
const list = async (folder: string) => (await request("GET", `/api/folder-trust?folder=${encodeURIComponent(folder)}`)).body;
const forget = (key: string, extra = "") => request("DELETE", `/api/folder-trust?key=${encodeURIComponent(key)}${extra}`);

describe("FUIGO-TRUST-V2 through the harness (generation 2, pooled)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = realpathSync(mkdtempSync(join(tmpdir(), "murage-folder-trust-v2-api-")));
    trustLog = join(home, "trust.log");
    spawnLog = join(home, "spawns.log");
    ({ child, desktop: desktopHeaders } = await bootServer(home, port));
    // This suite tests the trust pool. An uninstrumented fake engine cannot
    // attest a retained memory session, so leave recall off in this fixture.
    expect((await request("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("(rule 3b, wiring) an old Fuigo rejects a process choice without a card; Auto still asks", async () => {
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
    // MAIN RULING G2: an old version cannot receive a duration-less automatic grant.
    expect(JSON.parse(trustEvents().filter((entry) => entry.event === "reply").at(-1)!.raw!).result).toEqual({ outcome: "reject" });
    expect(await openCard(owner.threadId)).toBeUndefined();
    expect(stored()[atNoLimits]).toMatchObject({ decision: "trust", source: "picker" });
    expect(stored()[atNoLimits].consent).not.toBe(2);
  }, 40_000);

  // F15 (1.0.24, FRICTION P10): picking a folder IS the consent. The owner's own turn at Ask or Auto, dispatched by the real server
  // (folderTrustForTurn + the live authority), is never carded: a picked folder's configuration loads silently for this process only,
  // and configuration that runs commands (hooks, MCP servers) follows the level, withheld below Full access with one line.
  describe("F15 the owner's own turn below Full access on a picked folder", () => {
    const rows = [
      { name: "Ask, AGENTS.md", level: { autoApprove: false }, plant: "AGENTS.md", loads: true },
      { name: "Auto, AGENTS.md", level: { autoApprove: true }, plant: "AGENTS.md", loads: true },
      { name: "Auto, project hooks", level: { autoApprove: true }, plant: ".fuigo/hooks/pre.sh", loads: false },
      { name: "Auto, MCP servers", level: { autoApprove: true }, plant: ".mcp.json", loads: false },
      // Fuigo gates hooks Murage's scan did not see (a user-level entry for the folder): its own configKinds decide too.
      { name: "Auto, hooks only the engine names", level: { autoApprove: true }, plant: "AGENTS.md", loads: false, instance: "fuigo-1038-hooks" },
      // allowlist (fail closed): a kind the text list does not name is withheld too
      { name: "Auto, permission rules only the engine names", level: { autoApprove: true }, plant: "AGENTS.md", loads: false, instance: "fuigo-1038-permission" },
      // Rule 3: an earlier Trust (consent 2) does not lift the level rule either
      { name: "Auto, stored Trust over project hooks", level: { autoApprove: true }, plant: ".fuigo/hooks/pre.sh", loads: false, storedTrust: true },
    ] as Array<{ name: string; level: object; plant: string; loads: boolean; instance?: string; storedTrust?: true }>;
    for (const row of rows) it(`(F15 ${row.name}) no card; ${row.loads ? "loads silently for this process" : "withheld with one line"}`, async () => {
      const owner = await makeBot(`F15 ${row.name}`, row.instance ?? "fuigo-1038");
      const folder = join(home, `f15-${row.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`);
      mkdirSync(join(folder, dirname(row.plant)), { recursive: true });
      writeFileSync(join(folder, "AGENTS.md"), `f15-marker-${row.name}\n`);
      if (row.plant !== "AGENTS.md") writeFileSync(join(folder, row.plant), row.plant.endsWith(".json") ? "{}\n" : "true\n");
      const nativeFile = join(home, ".fuigo", "trusted_folders.toml");
      const native = existsSync(nativeFile) ? readFileSync(nativeFile, "utf8") : "";
      try {
        expect((await request("PATCH", `/api/bots/${owner.id}`, { settingsScope: "defaults", ...row.level })).status).toBe(200);
        expect((await request("PATCH", `/api/bots/${owner.id}`, { cwd: folder })).status).toBe(200);
        expect(stored()[folder]).toMatchObject(row.storedTrust ? { decision: "trust", source: "card", consent: 2 } : { decision: "trust", source: "picker" });
        await send(owner);
        // the turn either ends or stops on a card; either way look at what it did
        await expect.poll(async () => Boolean(await openCard(owner.threadId))
          || (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === owner.id)?.busy === false, { timeout: 30_000 }).toBe(true);
        expect(await openCard(owner.threadId)).toBeUndefined();
        const asked = trustEvents().filter(entry => entry.event === "request" && entry.params.workspace === folder).at(-1)!;
        const result = JSON.parse(trustEvents().filter(entry => entry.event === "reply" && entry.pid === asked.pid).at(-1)!.raw!).result;
        expect(result).toEqual(row.loads ? { outcome: "trust", scope: "configAndCommands", duration: "process" } : { outcome: "reject" });
        await settled(owner);
        const said = JSON.stringify(await messages(owner.threadId));
        if (row.loads) expect(said).toContain(`f15-marker-${row.name}`);
        // exactly one Murage notice names what was left out (shared/folder-trust.ts FOLDER_TRUST_WITHHELD_PREFIX), whatever the engine says
        else expect((await activities(owner.threadId)).filter((name) => name.startsWith("untrusted folder:"))).toHaveLength(1);
        // never a lasting grant in the owner's own Fuigo, never a Murage consent-2 record
        expect(existsSync(nativeFile) ? readFileSync(nativeFile, "utf8") : "").toBe(native);
        if (!row.storedTrust) expect(stored()[folder].consent).not.toBe(2);
      } finally {
        await request("DELETE", `/api/bots/${owner.id}`);
        await forget(folder);
      }
    }, 60_000);
  });

  it("E5 owner-picked No limits sends only a process choice through the isolated server", async () => {
    const owner = await makeBot("No limits native trust", "fuigo-1038");
    const folder = join(home, "e5-no-limits-native");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "AGENTS.md"), "fixture instructions\n");
    try {
      expect((await request("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(200);
      expect((await raise(owner, "no-limits", { fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
      expect((await request("PATCH", `/api/bots/${owner.id}`, { cwd: folder })).status).toBe(200);
      await turn(owner);
      const native = trustEvents().filter(entry => entry.event === "request" && entry.params.workspace === folder);
      // MAIN RULING G2(e): the picked positive still requires a current process-only reply.
      expect(native).toHaveLength(1);
      const reply = trustEvents().filter(entry => entry.event === "reply" && entry.pid === native[0]!.pid).at(-1)!;
      expect(JSON.parse(reply.raw!).result).toEqual({ outcome: "trust", scope: "configAndCommands", duration: "process" });
      expect(JSON.stringify(await messages(owner.threadId))).toContain("fixture instructions");
      expect(await openCard(owner.threadId)).toBeUndefined();
      expect(stored()[folder]).toMatchObject({ decision: "trust", source: "picker" });
      expect(stored()[folder].consent).not.toBe(2);
    } finally {
      await request("DELETE", `/api/bots/${owner.id}`);
      await forget(folder);
    }
  }, 40_000);

  it("E5 owner-unpicked No limits withholds configuration with zero cards and no saved grant", async () => {
    const owner = await makeBot("Unpicked native trust", "fuigo-unpicked");
    const folder = join(home, "e5-unpicked-folder");
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "AGENTS.md"), "unpicked-instruction-marker");
    expect((await request("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(200);
    expect((await raise(owner, "no-limits", { fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    expect((await request("PATCH", `/api/bots/${owner.id}`, { cwd: folder })).status).toBe(200);
    const before = readFileSync(storeFile(), "utf8");
    await turn(owner);
    const asked = trustEvents().filter(entry => entry.event === "request" && entry.params.workspace === join(home, "e5-not-picked-key")).at(-1)!;
    expect(asked).toBeDefined();
    expect(JSON.parse(trustEvents().filter(entry => entry.event === "reply" && entry.pid === asked.pid).at(-1)!.raw!).result).toEqual({ outcome: "reject" });
    expect(JSON.stringify(await messages(owner.threadId))).toContain("agents: withheld");
    expect(JSON.stringify(await messages(owner.threadId))).not.toContain("unpicked-instruction-marker");
    expect(await openCard(owner.threadId)).toBeUndefined();
    expect(readFileSync(storeFile(), "utf8")).toBe(before);
    await request("DELETE", `/api/bots/${owner.id}`); await forget(folder);
  });

  it("E5 owner No limits opens native Fuigo folder trust through the isolated server", async () => {
    const owner = await makeBot("No limits native trust", "fuigo-1038");
    const folder = join(home, "e5-native-isolated-server");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "AGENTS.md"), "fixture instructions\n");
    try {
      expect((await request("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(200);
      expect((await raise(owner, "no-limits", { fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
      expect((await request("PATCH", `/api/bots/${owner.id}`, { cwd: folder })).status).toBe(200);
      await turn(owner);
      const native = trustEvents().filter(entry => entry.event === "request" && entry.params.workspace === folder);
      expect(native).toHaveLength(1);
      const reply = trustEvents().filter(entry => entry.event === "reply" && entry.pid === native[0]!.pid).at(-1)!;
      expect(JSON.parse(reply.raw!).result).toEqual({ outcome: "trust", scope: "configAndCommands", duration: "process" });
      expect(JSON.stringify(await messages(owner.threadId))).toContain("fixture instructions");
      expect(await openCard(owner.threadId)).toBeUndefined();
      expect(stored()[folder]).toMatchObject({ decision: "trust", source: "picker" });
      expect(stored()[folder].consent).not.toBe(2);
    } finally {
      await request("DELETE", `/api/bots/${owner.id}`);
      await forget(folder);
    }
  }, 40_000);

  it("E5 Full access retains saved native Fuigo rejection below No limits", async () => {
    const owner = await makeBot("Full native trust", "fuigo-1037");
    const folder = join(home, "e5-full-native");
    const nativeFile = join(home, ".fuigo", "trusted_folders.toml");
    const previous = existsSync(nativeFile) ? readFileSync(nativeFile, "utf8") : "";
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "AGENTS.md"), "full-native-rejected-instructions\n");
    // Model the native app's saved Don't trust setting. The actual server and
    // CLI read this fixture file; no authorization or trust handler is mocked.
    const rejected = previous + `[folders.${JSON.stringify(folder)}]\ntrusted = false\nconsent = 2\n`;
    writeFileSync(nativeFile, rejected);
    try {
      const auto = { autoApprove: true, fullAccess: false, noLimits: false };
      expect((await request("PATCH", `/api/bots/${owner.id}`, { settingsScope: "defaults", ...auto })).status).toBe(200);
      expect((await request("PATCH", `/api/bots/${owner.id}/tasks/${owner.threadId}`, auto)).status).toBe(200);
      expect((await raise(owner, "full", { fullAccess: true, acknowledgeFullAccess: true, noLimits: false })).status).toBe(200);
      expect((await request("PATCH", `/api/bots/${owner.id}`, { cwd: folder })).status).toBe(200);
      await turn(owner, "Full access keeps the native saved no");
      expect(JSON.stringify(await messages(owner.threadId))).toContain("agents: withheld");
      expect(JSON.stringify(await messages(owner.threadId))).not.toContain("full-native-rejected-instructions");
      expect(await openCard(owner.threadId)).toBeUndefined();
      expect(readFileSync(nativeFile, "utf8")).toBe(rejected);
      expect((await request("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(200);
      expect((await raise(owner, "no-limits", { fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
      await turn(owner, "No limits reads the native saved-no folder");
      // MAIN RULING G1/G2: No limits retains the saved decline while ordinary commands run.
      expect(JSON.stringify(await messages(owner.threadId))).not.toContain("full-native-rejected-instructions");
      expect(JSON.stringify(await messages(owner.threadId))).toContain("agents: withheld");
      expect(await openCard(owner.threadId)).toBeUndefined();
      expect(readFileSync(nativeFile, "utf8")).toBe(rejected);
    } finally {
      writeFileSync(nativeFile, previous);
      await request("DELETE", `/api/bots/${owner.id}`);
      await forget(folder);
    }
  }, 60_000);

  // CHANGED-EXPECTATIONS F15 (1.0.24, q1024-trustquiet r4): the two Don't trust answers were cards (now 1.0.23 records seeded
  // at boot), and after Forget the next turn used to be carded and trusted; it now runs withheld, with no card and nothing written.
  it("(1) the combined topology: a stored reject at the main checkout answers a bot elsewhere, is listed, and Forget withholds without a card", async () => {
    expect(stored()[K_TOPOLOGY()]).toMatchObject({ decision: "reject", source: "card", consent: 2 });
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
    // ql2 sink fold (was summary === the folder key): a decision row's summary is the fixed label, the key is not written
    await expect.poll(() => decisions().some((row) => row.decision === "folder-forgotten" && row.summary === "folder" && row.tool === "folder-trust"), { timeout: 5_000 }).toBe(true);
    expect(JSON.stringify(decisions().filter((row) => row.decision === "folder-forgotten"))).not.toContain(K_TOPOLOGY());

    await turnWithoutCard(other, "again");
    expect(spawnCount()).toBeGreaterThan(spawned);
    expect(requestsFor(K_TOPOLOGY())).toBe(asked + 1);
    const after = (await activities(other.threadId)).filter((name) => name.startsWith("untrusted folder:"));
    expect(after).toHaveLength(2);
    expect(after[1]).not.toContain(":: forget");
    expect(stored()[K_TOPOLOGY()]).toBeUndefined();
    // the sibling's reject survived every step
    expect(stored()[K_SIBLING()]).toMatchObject({ decision: "reject" });
  }, 60_000);

  it("(2) the r5 sequence: the parked process stays silent, the list still holds K, and Forget starts a new process that is not carded", async () => {
    // CHANGED-EXPECTATIONS F15 (1.0.24, q1024-trustquiet r4): the Don't trust is the seeded 1.0.23 record (was a card answer), and
    // the new process after Forget is no longer carded (was: asked, then skipped)
    expect(stored()[K_SEQUENCE()]).toMatchObject({ decision: "reject", consent: 2 });
    const bot = await makeBot("Sequence", "fuigo-sequence");
    await turn(bot);
    const after1 = { spawns: spawnCount(), asks: requestsFor(K_SEQUENCE()) };
    // the digest is equal: adopted, and the fake's dedup sends no request
    await turn(bot, "two");
    expect(spawnCount(), JSON.stringify(poolTrace(bot.threadId)) + serverOutput.slice(-4000)).toBe(after1.spawns);
    expect(requestsFor(K_SEQUENCE())).toBe(after1.asks);
    // negative control: nothing changed, so a third turn adopts again
    await turn(bot, "three");
    expect(spawnCount(), JSON.stringify(poolTrace(bot.threadId)) + serverOutput.slice(-4000)).toBe(after1.spawns);
    expect((await list(workspaceOf(bot))).records.map((row: any) => row.key)).toContain(K_SEQUENCE());
    expect((await forget(K_SEQUENCE())).status).toBe(200);
    await turnWithoutCard(bot, "four");
    expect(spawnCount()).toBe(after1.spawns + 1);
    expect(requestsFor(K_SEQUENCE())).toBe(after1.asks + 1);
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

  it("(N7.6) an unstamped trust is listed with Forget and never answers: the folder is withheld, never carded", async () => {
    const bot = await makeBot("Legacy");
    const folder = workspaceOf(bot);
    mkdirSync(folder, { recursive: true });
    expect((await request("POST", "/api/folder-trust", { bot: bot.id, thread: bot.threadId })).status).toBe(200);
    const row = (await list(folder)).records.find((candidate: any) => candidate.key === folder);
    expect(row).toMatchObject({ decision: "trust", onPath: true });
    expect(row.consent).toBeUndefined();
    // CHANGED-EXPECTATIONS F15 (1.0.24, q1024-trustquiet r4): was "and the card follows" (then skipped); the owner's own turn is never carded now,
    // so the unstamped trust still never answers and the folder's files are withheld with one line.
    await turnWithoutCard(bot);
    expect((await activities(bot.threadId)).filter((name) => name.startsWith("untrusted folder:"))).toHaveLength(1);
    expect((await forget(folder)).status).toBe(200);
    expect((await list(folder)).records.find((candidate: any) => candidate.key === folder)).toBeUndefined();
  }, 40_000);

  it("(7) rule 2, rule 4 and skipped cards write nothing; the card, the picker, POST and the seed are the only writers", async () => {
    // CHANGED-EXPECTATIONS F15 (1.0.24, q1024-trustquiet r4): the reject is the seeded 1.0.23 record (was a card answer) and the
    // two "skip" bots are no longer carded: their turns run withheld, which writes nothing either
    expect(stored()[K_WRITERS()]).toMatchObject({ decision: "reject", consent: 2 });
    const before = readFileSync(storeFile(), "utf8");
    // 50 folders, one each: 46 answered by rule 2, 2 at Full access with nothing to bring in, 2 skipped
    const rule2 = await Promise.all(Array.from({ length: 46 }, (_, index) => makeBot(`Bound rule 2 ${index}`, "fuigo-writers")));
    const full = await Promise.all(Array.from({ length: 2 }, (_, index) => makeBot(`Bound full ${index}`, "fuigo-plain")));
    for (const bot of full) {
      expect((await raise(bot, "full", { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
    }
    const skippers = await Promise.all(Array.from({ length: 2 }, (_, index) => makeBot(`Bound skip ${index}`)));
    for (let round = 0; round < 4; round += 1) {
      for (const bot of [...rule2, ...full]) await turn(bot, `round ${round}`);
      for (const bot of skippers) {
        await turnWithoutCard(bot, `round ${round}`);
      }
    }
    expect(readFileSync(storeFile(), "utf8")).toBe(before);
    // a handler that does not write cannot write: the writers are named here
    const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
    expect(source.match(/folderTrust\.remember\(/g)).toHaveLength(3);
    expect(source.match(/folderTrust\.seedOnce\(/g)).toHaveLength(1);
    const core = readFileSync(join(SERVER_DIR, "drivers", "acp", "core.ts"), "utf8");
    expect(core).not.toMatch(/new FolderTrustStore|folderTrust\.remember\(/);
    expect((await forget(K_WRITERS())).status).toBe(200);
  }, 240_000);

  it("(6) GET does not change a reply: records never reach a turn", async () => {
    const bot = await makeBot("Reads");
    // CHANGED-EXPECTATIONS F15 (1.0.24, q1024-trustquiet r4): the reads used to happen while a card was open; no card opens now,
    // so they happen while the turn runs.
    await send(bot);
    for (let read = 0; read < 3; read += 1) await list(workspaceOf(bot));
    await noCardUntilIdle(bot);
    expect(Object.keys(stored())).not.toContain(workspaceOf(bot));
  }, 30_000);

  // CHANGED-EXPECTATIONS F15 (1.0.24, q1024-trustquiet r4): "(12) the new-card pool sequence: Forget in either order" (4 rows)
  // deleted: each row answered a card and checked how the card-answered process closed (reason=folder-trust-card); the owner's own turn is never carded
  // and an owner turn never closes on that reason now. Forget against a live pooled process stays covered by (2).
});
