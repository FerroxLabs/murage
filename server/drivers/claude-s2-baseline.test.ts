import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ensureDirs } from "../config.ts";
// The executable is an isolated wire-protocol fixture, so qualification is
// an explicit injected receipt at this I/O edge, never an ambient test unlock.
import * as qualification from "./claude-s2-qualification.ts";
import * as processTree from "./process-tree.ts";
beforeEach(() => {
  const receipt = { platform: "linux" as const, arch: "fixture", version: "0.0.0",
    build: "0".repeat(64), evidence: "isolated-wire-fixture" };
  vi.spyOn(qualification, "claudeS2QualifiedCli").mockImplementation(async () => qualification.claudeS2Qualified({}, receipt.platform,
    receipt.version, receipt.build, receipt.arch, [receipt]));
  // The fake protocol fixture supplies the same explicit receipt to the new
  // synchronous final qualification check; native digest tests stay separate.
  vi.spyOn(qualification, "claudeS2QualifiedCliNow").mockImplementation(() => qualification.claudeS2Qualified({}, receipt.platform,
    receipt.version, receipt.build, receipt.arch, [receipt]));
  vi.spyOn(processTree, "descendantBaseline").mockResolvedValue(new Set<number>());
  vi.spyOn(processTree, "untrackedDescendants").mockResolvedValue(new Set<number>());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetClaudeMcpReadinessForTests(); resetClaudeVersionGate(); });
// Public adapter witness: no missing S2 module or invented successful API can
// supply the RED. Both prompts must reach a real child before comparing PIDs.
it("T-S2-BASELINE: supported mounted turns reuse the CLI only after fresh reconnect", async () => {
  ensureDirs();
  const root = mkdtempSync(join(tmpdir(), "s2-baseline-"));
  const cli = join(root, "claude.mjs"), log = join(root, "stdin.jsonl"), release = join(root, "release");
  // Preserve shared imports when the runtime peer moves into its scratch home.
  const peer = readFileSync(new URL("claude-s2-runtime-cli.fixture.mjs", import.meta.url), "utf8")
    .replaceAll('"../../shared/win-hide-child-process.mjs"', JSON.stringify(new URL("../../shared/win-hide-child-process.mjs", import.meta.url).href));
  writeFileSync(cli, peer); chmodSync(cli, 0o755);
  writeFileSync(release, "ready");
  vi.stubEnv("FAKE_CLAUDE_S2_LOG", log); vi.stubEnv("FAKE_CLAUDE_S2_RELEASE", release);
  vi.stubEnv("CLAUDE_CONFIG_DIR", root); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "S2 baseline", enabled: true,
    environment: {}, config: { cli, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter), threadId = randomUUID(), botId = randomUUID();
  const turn = (text: string) => fixtureMountTurn({ threadId, text, cwd: root, draftOnly: true,
    warmIdentity: { botId, audience: "owner" },
    integrations: { composio: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } });
  const rows = (): Array<{ pid: number; frame: any }> => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(row => JSON.parse(row)) : [];
  try {
    const first = await instance.adapter.sendTurn(turn("first"));
    expect(await events.until(event => event.type === "turn.completed" && event.turnId === first.turnId)).toMatchObject({ ok: true });
    expect(rows().filter(row => row.frame.type === "user")).toHaveLength(1);
    await instance.adapter.sendTurn(turn("second"));
    await expect.poll(() => rows().filter(row => row.frame.type === "user").length, { timeout: 20_000 }).toBe(2);
    const users = rows().filter(row => row.frame.type === "user");
    expect(users[1]!.pid).toBe(users[0]!.pid);
    expect(rows().filter(row => row.frame.request?.subtype === "mcp_reconnect").length).toBeGreaterThan(0);
  } finally { events.stop(); await instance.dispose(); await removeTempDir(root); }
}, 40_000);
