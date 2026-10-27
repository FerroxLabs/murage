// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDriver } from "./drivers/codex.ts";
import { FuigoAgentDriver } from "./drivers/acp/fuigo.ts";
import { GrokAgentDriver } from "./drivers/acp/grok.ts";
import type { ProviderInstance } from "./contracts.ts";
import { recordEvents } from "./testing/events.ts";
import { autoVerdict } from "./auto-approve.ts";
import { execChecks, resetExecChecks } from "./testing/exec-check-spy.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { handedPinsOf } from "./engine-env.ts";
import { invalidateEnvCapture } from "./env-path.ts";
vi.mock("node:child_process", async original => (await import("./testing/exec-check-spy.ts")).withExecCheckSpy(await original()));
let instance: ProviderInstance | undefined, root: string | undefined;
afterEach(async () => { await instance?.dispose(); instance = undefined; vi.unstubAllEnvs(); if (root) await removeTempDir(root); root = undefined; invalidateEnvCapture("driver fixture end"); });
describe("108 isolated fake driver asks", () => {
  it.each(["codex", "fuigo", "grok"])("%s asks through the real environment check and approval guards", async name => {
    root = mkdtempSync(join(tmpdir(), "driver108-"));
    const codex = name === "codex", driver = codex ? CodexDriver : name === "fuigo" ? FuigoAgentDriver : GrokAgentDriver;
    const cli = join(import.meta.dirname, "testing", codex ? "fake-codex-app-server.ts" : "fake-acp-cli.ts"); chmodSync(cli, 0o755);
    vi.stubEnv(codex ? "FAKE_CODEX_MODE" : "FAKE_ACP_MODE", codex ? "approval" : "permission");
    if (codex) vi.stubEnv("FAKE_CODEX_APPROVAL", JSON.stringify({ method: "execCommandApproval", params: { command: "echo fixture108" } }));
    else vi.stubEnv("FAKE_ACP_PERMISSION_COMMAND", "echo fixture108");
    // Same non-secret fixture credential as fuigo-1032.test.ts; only the local fake CLI receives it.
    const environment: Record<string, string> = { HOME: root, USERPROFILE: root };
    if (name === "fuigo") environment.FUIGO_API_KEY = "sk-flux-fixture-only";
    instance = await driver.create({ instanceId: `fixture108-${name}`, displayName: `Fixture ${name}`, enabled: true, environment, config: { cli, fullAuto: false } });
    const events = recordEvents(instance.adapter); resetExecChecks();
    try {
      await instance.adapter.sendTurn({ threadId: `fixture108-${name}`, text: "fixture", cwd: root, routeAsks: true });
      const event = await events.until(event => event.type === "request.opened");
      if (event.type !== "request.opened") throw new Error("Expected command ask");
      expect(execChecks.runs).toBeGreaterThan(0);
      expect(event.execEnv?.unread, "Windows shells are mandatory on the Windows gate").toBeUndefined();
      expect(Boolean(event.execEnv)).toBe(true);
      expect(event.execEnv?.unchecked, "this fixture requires a successful check").toBeUndefined();
      const command = (event.toolCall?.input as { command?: unknown } | undefined)?.command;
      if (typeof command !== "string") throw new Error("The fake driver must provide its whole command");
      const context = { commandText: command, commandCwd: root, fullAccessOrigin: "owner" as const, stopLine: null,
        call: { toolCall: event.toolCall, toolIdentity: event.toolIdentity, toolKind: event.toolKind, mcpMounts: event.mcpMounts, engine: event.toolEngine, commandShell: event.commandShell }, handedPins: handedPinsOf(event.execEnv), envUnread: event.execEnv?.unread?.cause, envUnchecked: event.execEnv?.unchecked };
      expect(autoVerdict({ autoApprove: true, fullAccess: true }, event.tool, command, context).approve).not.toBeNull();
      expect(autoVerdict({ autoApprove: true, fullAccess: true }, event.tool, command, { ...context, envUnread: "fixture check unavailable" }).approve).toBeNull();
      await instance.adapter.respondToRequest(`fixture108-${name}`, event.requestId!, { behavior: "deny" });
      await events.until(event => event.type === "turn.completed");
    } finally { events.stop(); }
  }, 60_000);
});
