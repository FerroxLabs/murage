// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U2 C7 through the driver, with a scripted fake engine (fake-acp-cli fuigo-script) on a test engine that carries
// the Hermes switch. Every value here is fake.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderDriver, ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

vi.mock("../../env-path.ts", async (original) => {
  const real = await original<typeof import("../../env-path.ts")>();
  return {
    ...real,
    captureOwnerEnv: vi.fn(async () => {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) if (typeof value === "string") env[name] = value;
      return { env: { ...env, FUIGO_COMPACTION_WALL_CLOCK_SECS: "0", PATH: real.augmentedPath() }, capture: "session" as const };
    }),
  };
});

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

const TEST_SUPPORT: AcpSupport = {
  driverKind: "u2RepliesTest",
  displayName: "U2 Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake-u2",
  nativeSource: "test.acp",
  loginNote: "never reached",
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};
const ReplayDriver = createAcpDriver({ ...TEST_SUPPORT, driverKind: "u2ReplayTest", resendsReasoningReply: true });
const PlainDriver = createAcpDriver(TEST_SUPPORT);

beforeEach(() => {
  ensureDirs();
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|MODEL_REFRESH/i.test(key)) vi.stubEnv(key, "");
});
afterEach(async () => {
  recorder?.stop();
  recorder = undefined;
  await instance?.dispose();
  instance = undefined;
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) removeTempDirSync(home);
});

type Step = Record<string, unknown>;
const say = (at: number, text: string, messageId?: string): Step => ({ at, update: { sessionUpdate: "agent_message_chunk", ...(messageId ? { messageId } : {}), content: { type: "text", text } } });
const endTurn = (at: number): Step => ({ at, result: { stopReason: "end_turn" } });

type Env = Record<string, string> | ((home: string) => Record<string, string>);
async function start(driver: ProviderDriver<AcpConfig>, script: Step[], env: Env = {}, displayName = "Fuigo") {
  const home = mkdtempSync(join(tmpdir(), "murage-u2-replies-"));
  homes.push(home);
  const extra = typeof env === "function" ? env(home) : env;
  instance = await driver.create({ instanceId: "u2-replies", displayName, enabled: true,
    config: driver.decodeConfig({ cli, fullAuto: true }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_SCRIPT: JSON.stringify(script),
      FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model", FUIGO_API_KEY: "sk-flux-fixture-only", ...extra } });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: "u2", text: "hello", cwd: home });
  return home;
}
const completed = (timeoutMs = 15_000) => recorder!.until((e) => e.threadId === "u2" && e.type === "turn.completed", timeoutMs) as Promise<RuntimeEvent & { ok: boolean; stopReason: string | null }>;
const replies = () => recorder!.events.filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text").map((e) => (e as { text?: string }).text);

describe("U2 C7: a reply re-sent with its reasoning under the same messageId", () => {
  const reasoned = "\u{1F4AD} **Reasoning:**\n```\nSix times seven.\n```\n\nThe answer is 42.";
  it("shows once from an engine that re-sends it", async () => {
    await start(ReplayDriver as unknown as ProviderDriver<AcpConfig>, [say(20, "The answer", "m1"), say(30, " is 42.", "m1"), say(40, `\n\n${reasoned}`, "m1"), endTurn(60)]);
    expect(await completed()).toMatchObject({ ok: true });
    expect(replies()).toEqual(["The answer is 42."]);
  }, 20_000);

  it("shows once when the engine writes the blank line as CRLF", async () => {
    const crlf = "\u{1F4AD} **Reasoning:**\r\nSix times seven.\r\n\r\nThe answer is 42.";
    await start(ReplayDriver as unknown as ProviderDriver<AcpConfig>, [say(20, "The answer is 42.", "m1"), say(40, crlf, "m1"), endTurn(60)]);
    expect(await completed()).toMatchObject({ ok: true });
    expect(replies()).toEqual(["The answer is 42."]);
  }, 20_000);

  it("a chunk under another messageId, or with no blank line, is appended", async () => {
    await start(ReplayDriver as unknown as ProviderDriver<AcpConfig>, [say(20, "The answer is 42.", "m1"), say(30, reasoned, "m2"), say(40, "\u{1F4AD} x\nThe answer is 42.The answer is 42.", "m2"), endTurn(60)]);
    expect(await completed()).toMatchObject({ ok: true });
    expect(replies()).toEqual([`The answer is 42.${reasoned}\u{1F4AD} x\nThe answer is 42.The answer is 42.`]);
  }, 20_000);

  it("any other engine appends it", async () => {
    await start(PlainDriver as unknown as ProviderDriver<AcpConfig>, [say(20, "The answer is 42.", "m1"), say(30, reasoned, "m1"), endTurn(60)]);
    expect(await completed()).toMatchObject({ ok: true });
    expect(replies()).toEqual([`The answer is 42.${reasoned}`]);
  }, 20_000);
});
