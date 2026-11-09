import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GROK-ELICIT-CARD (1.0.15): Grok Build 1.0.70 forwards an MCP server's elicitation (a billable Yes/No confirm, say)
// as its own `_x.ai/mcp/elicit` request. It now opens the same question card as Fuigo's `_fuigo/mcp/elicit` and is
// answered with the same `{outcome}` reply. A server request Murage does not know is still answered -32601, and its
// method name (only the name) goes to the log so the next vendor rename is visible.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { GrokAgentDriver } from "./grok.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const ENV_KEYS = ["FAKE_ACP_MODE", "FAKE_ACP_ELICIT_METHOD", "FAKE_ACP_ASK_METHOD", "FAKE_ACP_ASK_PARAMS", "FAKE_ACP_DUMP"];

describe("Grok Build's MCP elicitation reaches the owner (GROK-ELICIT-CARD)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;
  let dump: string;

  const start = async (env: Record<string, string>) => {
    Object.assign(process.env, { ...env, FAKE_ACP_DUMP: dump });
    instance = await GrokAgentDriver.create({ instanceId: "acp-grok-elicit", displayName: "Grok", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
  };
  const decision = () => JSON.parse(readFileSync(dump, "utf8")).decision;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-acp-grok-elicit-"));
    dump = join(scratch, "dump.json");
  });
  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    vi.restoreAllMocks();
    await removeTempDir(scratch);
  });

  for (const method of ["_x.ai/mcp/elicit", "x.ai/mcp/elicit"]) {
    it(`${method}: opens the question card, never auto-answered, and Yes replies {outcome: accept, content}`, async () => {
      await start({ FAKE_ACP_MODE: "grok-elicit", FAKE_ACP_ELICIT_METHOD: method });
      await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-grok-elicit", text: "make the video" });
      const opened = await recorder.until((e) => e.type === "request.opened");
      expect(opened).toMatchObject({
        requestType: "question",
        tool: "elicitation",
        questions: [{ id: "confirm", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false }],
      });
      await expect(
        instance!.adapter.respondToRequest("t-grok-elicit", (opened as any).requestId, {
          behavior: "answer", message: "Yes", answers: [{ id: "confirm", selected: ["Yes"] }],
        }),
      ).resolves.toBe("answered");
      expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "answer", source: "user" });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(decision()).toEqual({ outcome: "accept", content: { confirm: true } });
    });
  }

  it("a skipped card replies {outcome: decline}", async () => {
    await start({ FAKE_ACP_MODE: "grok-elicit" });
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-grok-elicit-skip", text: "make the video" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await expect(instance!.adapter.respondToRequest("t-grok-elicit-skip", (opened as any).requestId, { behavior: "deny" })).resolves.toBe("rejected");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(decision()).toEqual({ outcome: "decline" });
  });

  it("an unknown server request is answered -32601 and only its method name is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await start({
      FAKE_ACP_MODE: "vendor-question",
      FAKE_ACP_ASK_METHOD: "_x.ai/mcp/brand_new\nforged=1",
      FAKE_ACP_ASK_PARAMS: JSON.stringify({ sessionId: "s-1", message: "PARAMS-MUST-NOT-BE-LOGGED" }),
    });
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-grok-unknown", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(decision()).toEqual({ error: { code: -32601, message: "method not found" } });
    const lines = warn.mock.calls.map((call) => call.map(String).join(" ")).filter((line) => line.startsWith("acp unknown server request"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("thread=t-grok-unknown");
    expect(lines[0]).toContain("method=_x.ai/mcp/brand_new?forged=1");
    expect(lines[0]).not.toContain("\n");
    expect(lines.join("\n")).not.toContain("PARAMS-MUST-NOT-BE-LOGGED");
  });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
