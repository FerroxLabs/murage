// Contract tests for the bring-your-own ACP driver. The scripted fake ACP
// CLI stands in for "any agent that speaks ACP over stdio" — exactly the
// promise the driver makes to users.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { CustomAcpDriver } from "./custom.ts";
import { removeTempDir } from "../../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("CustomAcpDriver config", () => {
  it("teaches instead of ENOENT when the command is missing or blank", async () => {
    expect(() => CustomAcpDriver.decodeConfig({})).toThrow(/Set CLI|config\.json/);
    expect(() => CustomAcpDriver.decodeConfig({ cli: "   " })).toThrow(/<your-agent> acp/);
    // registry uses defaultConfig() verbatim when the entry has no config —
    // create() must reject with the same teaching message, never spawn ""
    await expect(
      CustomAcpDriver.create({
        instanceId: "custom-blank",
        displayName: undefined,
        environment: {},
        enabled: true,
        config: CustomAcpDriver.defaultConfig(),
      }),
    ).rejects.toThrow(/<your-agent> acp/);
  });

  it("keeps a real command verbatim, wrapper strings included", () => {
    expect(CustomAcpDriver.decodeConfig({ cli: "fx acp", fullAuto: true })).toMatchObject({
      cli: "fx acp",
      fullAuto: true,
    });
  });

  it("advertises the custom rail, multi-instance, and the passthrough model", () => {
    expect(CustomAcpDriver.metadata).toMatchObject({
      access: "custom",
      supportsMultipleInstances: true,
    });
    expect(CustomAcpDriver.models).toEqual({
      default: "agent-default",
      options: [{ id: "agent-default", label: "Agent default" }],
    });
    // no install descriptor: there is nothing generic to install
    expect(CustomAcpDriver.install).toBeUndefined();
  });
});

describe("CustomAcpDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (environment: Record<string, string> = {}) => {
    instance = await CustomAcpDriver.create({
      instanceId: "custom-test",
      displayName: "Custom Test",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-custom-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.XAI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("runs a full turn through an arbitrary ACP CLI with canonical events", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-custom", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // assistant text
      "item.started", // tool tc-1
      "item.completed", // tool tc-1 done
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "customAcp")).toBe(true);
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")!;
    expect((text as { text?: string }).text).toBe("hello from fake acp");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("passes instance env to the child but strips foreign provider keys", async () => {
    process.env.XAI_API_KEY = "xai-should-not-leak";
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create({ MY_AGENT_TOKEN: "tok-123" });
    await instance.adapter.sendTurn({ threadId: "t-custom-env", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string | undefined> };
    expect(seen.env.MY_AGENT_TOKEN).toBe("tok-123");
    // deny-by-default credential hygiene: a custom CLI never inherits
    // another provider's billing key
    expect(seen.env.XAI_API_KEY).toBeUndefined();
  });

  it("names the tool the bot actually ran, not the wrapper it went through", async () => {
    process.env.FAKE_ACP_MODE = "wrapped-tool";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-custom-wrapped", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const started = recorder.events.find((e) => e.type === "item.started" && (e as { itemType?: string }).itemType === "tool")!;
    // the engine called it `use_tool`; the person needs the inner tool
    expect(started).toMatchObject({ title: "memory_search", summary: "quarterly plan" });
  });

  // A completed tool call was reduced to a chip; an image in its output had
  // no route to the message or to Files at all.
  it("surfaces an MCP tool's image and withholds the computer surface's frame", async () => {
    process.env.FAKE_ACP_MODE = "tool-image";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-custom-tool-image", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const images = recorder.events.filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      alt: "mcp__omarchy__screenshot",
    });
  });

  // Retention was being decided on the chip's name, and the chip shows a
  // shell command in place of the tool for any call that carries one. A
  // `computer_exec` running `firefox` therefore stopped matching the screen
  // surface it is, and its live frame became a permanent Files artifact.
  it("withholds the computer surface's frame even when the chip reads as the shell command", async () => {
    process.env.FAKE_ACP_MODE = "computer-exec-image";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-custom-computer-exec", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    // the chip still says what it ran — that part is the point of the label
    const started = recorder.events.find((e) => e.type === "item.started" && (e as { itemType?: string }).itemType === "tool")!;
    expect(started).toMatchObject({ title: "firefox" });

    const images = recorder.events.filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_image");
    expect(images).toEqual([]);
  });

  // The chip drops a tool's server namespace on purpose, so a custom server's
  // `screenshot` reached through a wrapper arrived at the retention filter as
  // the bare `screenshot` and was discarded as if it were Murage's own screen.
  it("keeps a custom MCP server's screenshot reached through a wrapper tool", async () => {
    process.env.FAKE_ACP_MODE = "wrapped-tool-image";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-custom-wrapped-image", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    // the chip still names the inner tool, not the wrapper and not the mount
    const started = recorder.events.find((e) => e.type === "item.started" && (e as { itemType?: string }).itemType === "tool")!;
    expect(started).toMatchObject({ title: "screenshot" });

    const images = recorder.events.filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      alt: "screenshot",
    });
  });

  it("carries a failed tool's reason out of the engine instead of only a red flag", async () => {
    process.env.FAKE_ACP_MODE = "wrapped-tool";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-custom-failed-tool", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const done = recorder.events.find((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool")!;
    expect(done).toMatchObject({ ok: false });
    expect((done as { detail?: string }).detail).toContain("Memory is not available for this turn.");
    expect((done as { detail?: string }).detail).toContain("search timed out after 5s");
  });

  it("reports available with a working CLI and no sign-in requirement", async () => {
    await create();
    const snapshot = await instance.snapshot();
    expect(snapshot).toMatchObject({ state: "available" });
  });
});
