// SPDX-License-Identifier: AGPL-3.0-or-later
// M9 r4: the Bedrock epoch FENCE on S2 mounted reuse (claude.ts "M9 r3 FENCE on S2 reuse"), offline through the isolated S2 wire fixture
// (claude-s2-runtime-cli.fixture.mjs) with the same injected qualification receipt as claude-s2-production.test.ts. The rebind lands while the
// reuse waits at its MCP barrier, after the turn read the epoch and before the prompt is written.
import { fencedTurnInput } from "./engine-input.ts";
import { buildPrompt, promptPart, noneRef } from "../memory/prompt-parts.ts";
import { checkedOpenTurns } from "../memory/lineage-write.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDirs } from "../config.ts";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { recordEvents } from "../testing/events.ts";
import type { SendTurnInput } from "../contracts.ts";
import { BedrockBindings } from "../bedrock-bindings.ts";
import { IdentityCache } from "../bedrock-identity.ts";
import { setBedrockRuntime } from "../bedrock-launch.ts";

// The executable is an isolated wire-protocol fixture, so qualification is
// an explicit injected receipt at this I/O edge, never an ambient test unlock.
vi.mock("./claude-s2-qualification.ts", async original => {
  const actual = await original<typeof import("./claude-s2-qualification.ts")>();
  const receipt = { platform: "linux" as const, arch: "fixture", version: "0.0.0",
    build: "0".repeat(64), evidence: "isolated-wire-fixture" };
  const qualified = () => actual.claudeS2Qualified({}, receipt.platform,
    receipt.version, receipt.build, receipt.arch, [receipt]);
  // Inject the isolated protocol receipt at both identity I/O edges.
  return { ...actual, claudeS2QualifiedCli: async () => qualified(), claudeS2QualifiedCliNow: qualified };
});
vi.mock("./process-tree.ts", async original => ({ ...await original<typeof import("./process-tree.ts")>(),
  descendantBaseline: async () => new Set<number>(), untrackedDescendants: async () => new Set<number>(),
}));
const stdinProbe = vi.hoisted(() => ({ write: undefined as undefined | ((wire: string) => void) }));
vi.mock("../procs.ts", async original => {
  const api = await original<typeof import("../procs.ts")>();
  return { ...api, spawnCli: (...args: Parameters<typeof api.spawnCli>) => {
    const child = api.spawnCli(...args);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: any, ...rest: any[]) => {
      stdinProbe.write?.(String(chunk));
      return (write as any)(chunk, ...rest);
    }) as typeof child.stdin.write;
    return child;
  } };
});
const cleanup: Array<() => unknown> = [];
let state: { block: unknown } = { block: null };
const bound = (epoch: number) => ({ profile: "personal", region: "us-east-1", accountId: "111111111111", epoch });
let awsHome = "";
beforeEach(() => {
  awsHome = mkdtempSync(join(tmpdir(), "s2-bedrock-aws-"));
  mkdirSync(join(awsHome, ".aws"));
  writeFileSync(join(awsHome, ".aws", "config"), "[profile personal]\nregion = us-east-1\n");
  state = { block: bound(1) };
  const bindings = new BedrockBindings({ readBlock: () => state.block, writeBlock: async (_i, b) => { state.block = b; }, busy: { get: () => false, set: () => {} }, check: async () => "111111111111" });
  // IDENTITY answers the fixture account offline; the launch gate, the cache and the fence are real
  setBedrockRuntime({ bindings, cache: new IdentityCache(), home: () => awsHome, resolve: async () => "111111111111" });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  setBedrockRuntime(null); rmSync(awsHome, { recursive: true, force: true });
  stdinProbe.write = undefined;
  vi.unstubAllEnvs(); resetClaudeMcpReadinessForTests(); resetClaudeVersionGate();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("S2 production fixture deadline"); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture(fail: boolean, incoming?: string, unsupported = false) {
  ensureDirs(); // server/testing/setup.ts owns the isolated test data HOME
  const root = mkdtempSync(join(tmpdir(), "s2-production-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, "claude.mjs");
  const runtime = readFileSync(new URL("claude-s2-runtime-cli.fixture.mjs", import.meta.url), "utf8");
  // The copied executable still loads the real process-visibility helper;
  // its repository-relative import cannot resolve from a temporary directory.
  writeFileSync(cli, runtime.replace('import "../../shared/win-hide-child-process.mjs";',
    `import ${JSON.stringify(new URL("../../shared/win-hide-child-process.mjs", import.meta.url).href)};`));
  chmodSync(cli, 0o755);
  const log = join(root, "stdin.jsonl"), release = join(root, "release");
  const failChild = join(root, "fail-one-mount");
  const mountCode = `const fs=require('node:fs'); const flag=${JSON.stringify(failChild)}; if(fs.existsSync(flag)){fs.unlinkSync(flag);process.exit(1);} process.stdin.resume();`;
  vi.stubEnv("FAKE_CLAUDE_S2_LOG", log); vi.stubEnv("FAKE_CLAUDE_S2_RELEASE", release);
  vi.stubEnv("FAKE_CLAUDE_S2_FAIL", fail ? "1" : "0"); vi.stubEnv("FAKE_CLAUDE_S2_INCOMING", incoming ?? "");
  vi.stubEnv("FAKE_CLAUDE_S2_UNSUPPORTED", unsupported ? "1" : "0");
  vi.stubEnv("CLAUDE_CONFIG_DIR", root); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "isolated S2", enabled: true,
    environment: { FAKE_CLAUDE_S2_LOG: log, FAKE_CLAUDE_S2_RELEASE: release,
      FAKE_CLAUDE_S2_FAIL: fail ? "1" : "0", FAKE_CLAUDE_S2_INCOMING: incoming ?? "",
      FAKE_CLAUDE_S2_UNSUPPORTED: unsupported ? "1" : "0" }, config: { cli, permissionMode: "acceptEdits", configDir: root, bedrock: bound(1) } as never });
  const events = recordEvents(instance.adapter);
  const bindings: Array<ReturnType<typeof consumingFixture>> = [];
  cleanup.push(() => { for (const f of bindings) f.close(); });
  cleanup.push(async () => { events.stop(); await instance.dispose(); });
  const threadId = randomUUID(), botId = randomUUID();
  function turn(text: string): SendTurnInput {
    const f = consumingFixture(undefined, { threadId, botId }); bindings.push(f);
    const caps = new InternalCapabilities(); caps.begin(botId, threadId, f.binding.identity.dispatchGeneration);
    const input: SendTurnInput = { text, threadId, cwd: root, draftOnly: true, releaseBinding: f.binding,
      mountAdmission: createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1"),
      integrations: { composio: { command: process.execPath, args: ["-e", mountCode], env: {} } } };
    return fencedTurnInput({ ...input, prompt: buildPrompt(f.turn, [promptPart(input.text, [noneRef("owner-turn")])]) },
      { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  }
  const rows = (): Array<{ pid: number; frame: any }> => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
  const first = await instance.adapter.sendTurn(turn("first"));
  await events.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
  await expect.poll(() => rows().find(r => r.frame.type === "user"), {
    timeout: 20_000, message: "S2 production fixture must receive the first user frame",
  }).toBeDefined();
  const userFrame = rows().find(r => r.frame.type === "user");
  expect(userFrame, "S2 production fixture first user frame").toBeDefined();
  const pid = userFrame!.pid;
  return { instance, events, turn, rows, pid, threadId, release, failChild, bindings };
}
it("R4-S2 a re-bind while the S2 reuse waits at its MCP barrier is R4: the kept child (old account) never gets the prompt", async () => {
  const x = await fixture(false);
  const sent = x.instance.adapter.sendTurn(x.turn("second")).catch((error: unknown) => ({ error }));
  // the reuse path is live: the kept child holds the mcp_reconnect barrier (S2), so the epoch read for this turn is already taken
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  state.block = bound(2); // the owner's Save lands during the barrier wait
  writeFileSync(x.release, "release");
  const result = await sent;
  await new Promise(r => setTimeout(r, 500));
  const users = x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content);
  expect(users, "R4-S2 the old-account child never gets the second prompt").toEqual(["first"]); // R4-S2
  expect(JSON.stringify([result, x.events.events]), "R4-S2 the R4 row").toContain("changed while your message was starting");
}, 60_000);
