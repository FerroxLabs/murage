// DRV / D8: idle Claude children are held by the adaptive warm pool (no fixed
// cap), active children excluded, browser capabilities scoped to turns.
// Uses the existing scripted CLI and Vitest's disposable home, no live engine.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";

const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const instances: Array<{ instance: ProviderInstance; recorder: EventRecorder }> = [];
const pids = new Set<number>();
let scratch: string;
beforeEach(() => {
  ensureDirs(); chmodSync(cli, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "drv-claude-idle-"));
  vi.stubEnv("FAKE_CLAUDE_MODE", "happy");
  vi.stubEnv("MURAGE_CLAUDE_SESSION_IDLE_MS", "600000");
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
afterEach(async () => {
  for (const { instance, recorder } of instances.splice(0)) { recorder.stop(); await instance.dispose(); }
  try { for (const pid of pids) await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false); }
  finally { pids.clear(); vi.unstubAllEnvs(); await removeTempDir(scratch); }
});
async function create() {
  const instance = await ClaudeDriver.create({ instanceId: `drv-${instances.length}`, displayName: "Fixture Claude", enabled: true, environment: {}, config: { cli, permissionMode: "acceptEdits" } });
  const owner = { instance, recorder: recordEvents(instance.adapter) };
  instances.push(owner);
  return owner;
}
type Owner = Awaited<ReturnType<typeof create>>;
type Dump = { pid: number; argv: string[]; mcpConfig: { mcpServers: { browser: { env: Record<string, string> } } } | null; credFile: { path: string; content: Record<string, Record<string, string>> } | null };
async function turn(owner: Owner, threadId: string, extra: Partial<SendTurnInput> = {}) {
  const dumpPath = join(scratch, `${threadId}.json`);
  vi.stubEnv("FAKE_CLAUDE_DUMP", dumpPath);
  const sent = await owner.instance.adapter.sendTurn({ threadId, text: "Fixture turn", ...extra });
  await owner.recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
  const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
  pids.add(dump.pid);
  const started = owner.recorder.events.findLast(event => event.type === "session.started" && event.threadId === threadId) as { sessionId: string };
  return { ...dump, sessionId: started.sessionId };
}

it("while active only one idle spare is kept per engine kind: the most recently used thread", async () => {
  vi.stubEnv("MURAGE_WARM_POOL_BUDGET_MB", "100000"); vi.stubEnv("MURAGE_WARM_POOL_MIN_FREE_MB", "0");
  const one = await create(), two = await create();
  const a = await turn(one, "drv-a");
  const b = await turn(two, "drv-b");
  const c = await turn(two, "drv-c");
  await expect.poll(() => alive(a.pid) || alive(b.pid), { timeout: 10_000 }).toBe(false);
  expect(alive(c.pid)).toBe(true);
  const resumed = await turn(one, "drv-a", { resumeCursor: a.sessionId });
  expect(resumed.pid).not.toBe(a.pid);
  expect(resumed.argv[resumed.argv.indexOf("--resume") + 1]).toBe(a.sessionId);
});

it("a background turn releases its engine as soon as it finishes", async () => {
  vi.stubEnv("MURAGE_WARM_POOL_BUDGET_MB", "100000"); vi.stubEnv("MURAGE_WARM_POOL_MIN_FREE_MB", "0");
  const owner = await create();
  const a = await turn(owner, "drv-a", { background: true });
  await expect.poll(() => alive(a.pid), { timeout: 10_000 }).toBe(false);
});

it("over budget retires idle children but never an active one", async () => {
  vi.stubEnv("MURAGE_WARM_POOL_BUDGET_MB", "100000"); vi.stubEnv("MURAGE_WARM_POOL_MIN_FREE_MB", "0");
  const owner = await create();
  const gate = join(scratch, "release-active");
  const seen = join(scratch, "active-pid");
  vi.stubEnv("FAKE_CLAUDE_HOLD_MARKER", "hold-active");
  vi.stubEnv("FAKE_CLAUDE_HOLD_GATE", gate);
  vi.stubEnv("FAKE_CLAUDE_HOLD_SEEN", seen);
  const active = await turn(owner, "drv-a");
  const held = await owner.instance.adapter.sendTurn({ threadId: "drv-a", text: "hold-active", resumeCursor: active.sessionId });
  await expect.poll(() => existsSync(seen)).toBe(true);
  vi.stubEnv("MURAGE_WARM_POOL_BUDGET_MB", "1"); // now over budget; drv-a is mid-turn
  const b = await turn(owner, "drv-b");
  await expect.poll(() => alive(b.pid), { timeout: 10_000 }).toBe(false);
  expect(alive(active.pid)).toBe(true);
  expect(owner.instance.adapter.hasSession("drv-a")).toBe(true);
  writeFileSync(gate, "continue");
  await owner.recorder.until(event => event.type === "turn.completed" && event.turnId === held.turnId);
});

it("a retained child has no live browser claim and the next turn reissues its MCP token", async () => {
  const owner = await create();
  const authority = new InternalCapabilities();
  const threadId = "drv-browser";
  let generation = "";
  // This is the harness's existing turn-capability lifecycle, not a driver-owned grant.
  const unsubscribe = owner.instance.adapter.onEvent(event => {
    if (event.type === "turn.started") authority.bindProviderTurn(threadId, generation, event.turnId!);
    if (event.type === "turn.completed") authority.completeProviderTurn(threadId, event.turnId!);
  });
  const issue = () => {
    generation = authority.begin("bot", threadId);
    return authority.mint({ botId: "bot", threadId, generation, depth: 0, kind: "computer", skillAuthoring: false });
  };
  const integrations = (token: string) => ({ browser: { command: process.execPath, args: ["fixture-browser-proxy"], env: { MURAGE_CONTROL_TOKEN: token, MURAGE_CONTROL_URL: "http://127.0.0.1:1", MURAGE_BROWSER_TRANSPORT: "extension" } } });
  try {
    const firstToken = issue();
    expect(authority.resolve(`Bearer ${firstToken}`)).not.toBeNull();
    // Warm Claude (mobile lane): the per-turn token never rides the MCP config or the process env;
    // it sits in the process's 0600 credential file for the turn only, emptied when the turn settles.
    vi.stubEnv("FAKE_CLAUDE_DUMP_EACH_TURN", "1");
    const first = await turn(owner, threadId, { integrations: integrations(firstToken) });
    expect(JSON.stringify(first.mcpConfig)).not.toContain(firstToken);
    expect(first.credFile!.content.browser.MURAGE_CONTROL_TOKEN).toBe(firstToken);
    expect(JSON.parse(readFileSync(first.credFile!.path, "utf8"))).toEqual({});
    expect(alive(first.pid)).toBe(true);
    expect(authority.resolve(`Bearer ${firstToken}`)).toBeNull();
    const secondToken = issue();
    expect(secondToken).not.toBe(firstToken);
    expect(authority.resolve(`Bearer ${firstToken}`)).toBeNull();
    const second = await turn(owner, threadId, { resumeCursor: first.sessionId, integrations: integrations(secondToken) });
    // the retained child carries the conversation on: the next turn reissues the token into its file
    expect(second.pid).toBe(first.pid);
    expect(second.credFile!.content.browser.MURAGE_CONTROL_TOKEN).toBe(secondToken);
    expect(JSON.stringify(second.credFile!.content)).not.toContain(firstToken);
    expect(JSON.stringify(second.mcpConfig)).not.toContain(firstToken);
    expect(JSON.parse(readFileSync(second.credFile!.path, "utf8"))).toEqual({});
    expect(authority.resolve(`Bearer ${secondToken}`)).toBeNull();
  } finally { unsubscribe(); authority.revokeAll(); }
});
