// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ALL.eld250: each real driver reads a real engine line from its fake CLI and passes that line's length to the native log, so a
// frame too long for the record gets the raw-length marker. Without rawChars the same frame walks the full path and its marker
// names encodedBytes instead, so each test fails when its driver stops passing the length.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { ClaudeDriver } from "./claude.ts";
import { PiDriver } from "./pi.ts";

const fake = (name: string) => join(dirname(fileURLToPath(import.meta.url)), "..", "testing", name);
let instance: ProviderInstance;
let recorder: EventRecorder;
let scratch: string;

beforeEach(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "native-raw-"));
});
afterEach(async () => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_AGY_MODE;
  recorder?.stop();
  await instance?.dispose();
  await removeTempDir(scratch);
});

const turnLog = async (threadId: string, send: Record<string, unknown> = {}) => {
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId, text: "go", cwd: scratch, ...send });
  await recorder.until((event) => event.type === "turn.completed");
  return readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");
};
const expectDroppedByRawLength = (log: string, source: string) => {
  expect(log).toContain("frame exceeds byte limit before redaction");
  expect(log).not.toContain("BIGFRAME-CANARY");
  // the small frames of the same turn are still recorded, so the driver's own line handling is what ran
  expect(log).toContain(`"source":"${source}"`);
};

it("Claude: a big SDK line is dropped by its raw length", async () => {
  chmodSync(fake("fake-claude-cli.ts"), 0o755);
  process.env.FAKE_CLAUDE_MODE = "big-frame";
  instance = await ClaudeDriver.create({ instanceId: "raw-claude", displayName: "Raw Claude", environment: {}, enabled: true, config: { cli: fake("fake-claude-cli.ts"), permissionMode: "acceptEdits" } });
  expectDroppedByRawLength(await turnLog(`t-raw-claude-${Date.now()}`), "claude.sdk.message");
});

it("Antigravity: a big stream line is dropped by its raw length", async () => {
  chmodSync(fake("fake-agy-cli.ts"), 0o755);
  process.env.FAKE_AGY_MODE = "big-frame";
  instance = await AntigravityDriver.create({ instanceId: "raw-agy", displayName: "Raw Agy", environment: {}, enabled: true, config: { cli: fake("fake-agy-cli.ts"), fullAuto: true } });
  expectDroppedByRawLength(await turnLog(`t-raw-agy-${Date.now()}`, { model: "gemini-3.1-pro-high" }), "agy.stream");
});

it("Pi: a big RPC line is dropped by its raw length", async () => {
  chmodSync(fake("fake-pi-cli.ts"), 0o755);
  instance = await PiDriver.create({ instanceId: "raw-pi", displayName: "Raw Pi", environment: { FAKE_PI_MODE: "big-frame" }, enabled: true, config: { cli: fake("fake-pi-cli.ts"), fullAuto: false } });
  expectDroppedByRawLength(await turnLog(`t-raw-pi-${Date.now()}`), "pi.rpc");
});
