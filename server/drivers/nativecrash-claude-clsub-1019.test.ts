// SPDX-License-Identifier: AGPL-3.0-or-later
// CLSUB (nativecrash G2 claude): the prompt-submission site a plain fake-CLI turn only reaches through the turn's own prepare hook.
//  - claude.prompt.launch2: the fence that runs AFTER the new process's MCP wait (the first fence, before spawn, passed).
// A coded refusal there is ONE submission record, driver-closed (the captured process retired and confirmed), no prompt bytes.
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { bindFixtureAdapter } from "../testing/mcp-admission-fixture.ts";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { fencedRefusals as ringRefusals, type FencedRefusal } from "./engine-input.ts";
const fencedRefusals = () => ringRefusals() as readonly unknown[] as readonly FencedRefusal[];

const IDLE_MCP = fileURLToPath(new URL("../testing/fake-idle-mcp.mjs", import.meta.url));
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const composio = { command: process.execPath, args: [IDLE_MCP], env: { MURAGE_BOT_ID: "dax" } };
const ENV_KEYS = ["FAKE_CLAUDE_DUMP"] as const;
const revoked = () => Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });

let instance: ProviderInstance; let recorder: EventRecorder; let scratch: string; let dump: string;
beforeEach(async () => {
  ensureDirs(); chmodSync(FAKE_CLI, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-claude-clsub-"));
  dump = join(scratch, "dump.json");
  process.env.FAKE_CLAUDE_DUMP = dump;
  instance = await ClaudeDriver.create({ instanceId: "claude-clsub", displayName: "Claude", environment: { FAKE_CLAUDE_MCP_BASELINE_MS: "2000" }, enabled: true,
    config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" } });
  bindFixtureAdapter(instance.adapter);
  recorder = recordEvents(instance.adapter);
});
afterEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.unstubAllEnvs(); resetClaudeVersionGate(); resetClaudeMcpReadinessForTests();
  recorder?.stop(); await instance?.dispose(); await removeTempDir(scratch);
});

it("CLSUB launch2: a refusal at the fence after the new process's MCP wait is one submission record at claude.prompt.launch2", async () => {
  const error = revoked(); let calls = 0;
  const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-clsub-launch2", text: "LAUNCH2-REFUSED", integrations: { composio },
    beforePrepare: () => { if (++calls === 2) throw error; }, beforeSubmit: () => {} }).then(() => undefined, (e: unknown) => e);
  expect(calls, "the first fence passed, the second refused").toBe(2);
  expect(sent).toBe(error);
  const rec = fencedRefusals().filter((r) => r.threadId === "t-clsub-launch2");
  expect(rec.map((r) => [r.site, r.kind, r.closer])).toEqual([["claude.prompt.launch2", "submission", "driver"]]);
  expect(await (rec[0] as any).teardown, "the spawned process's retirement is confirmed").toEqual({ confirmed: true });
  expect(instance.adapter.hasSession("t-clsub-launch2")).toBe(false);
  expect(existsSync(dump), "no prompt bytes reached the CLI").toBe(false);
}, 60_000);
