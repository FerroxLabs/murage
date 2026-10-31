// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The wiring, end to end, on the ACP path the 1.0.1 camera run used: a real
// ACP driver against the scripted fake CLI raises the shell ask the engine
// sent for `cat …/mcp/call_00_….json | python3 …`, and the event it emits is
// fed into exactly the calls server/index.ts makes. The boundary itself is in
// own-tool-results.test.ts; this proves the session's folder reaches policy,
// and that a read of anything else still raises the card.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autoVerdict, isCommandTool } from "./auto-approve.ts";
import { ensureDirs } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { GrokAgentDriver } from "./drivers/acp/grok.ts";
import { fuigoSessionKey } from "./engine-keys.ts";
import { isOwnToolResultRead } from "./own-tool-results.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";
import { commandFromToolInput } from "../shared/exact-command.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let scratch: string;
let home: string;
let cwd: string;

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-own-results-wiring-"));
  home = join(scratch, "grok-home");
  cwd = join(scratch, "thread");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(async () => {
  delete process.env.FAKE_ACP_MODE;
  delete process.env.FAKE_ACP_PERMISSION_TOOLCALL;
  delete process.env.FAKE_ACP_PERMISSION_SESSION;
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  await removeTempDir(scratch);
});

/** The folders the product names for the session: the thread's folder as given and as its real path (macOS: /var is /private/var),
 * deduplicated, as sessionFolders does (own-tool-results.ts), so one folder where the two are the same. */
function sessionDirs(childHome: string): string[] {
  const keys = [...new Set([cwd, realpathSync.native(cwd)].map((folder) => fuigoSessionKey(folder)))];
  return keys.map((key) => join(childHome, "sessions", key, "fake-acp-session", "mcp"));
}

/** Raise one shell ask through the real driver and judge it as index.ts does. */
async function askFor(command: string, threadId: string) {
  process.env.FAKE_ACP_MODE = "permission";
  process.env.FAKE_ACP_PERMISSION_SESSION = "1";
  process.env.FAKE_ACP_DUMP = join(scratch, "dump.json");
  process.env.FAKE_ACP_PERMISSION_TOOLCALL = JSON.stringify({
    toolCallId: "call_00_ask", kind: "execute", title: `Execute \`${command}\``,
    rawInput: { variant: "Bash", command, is_background: false },
  });
  instance = await GrokAgentDriver.create({
    instanceId: "own-results", displayName: "Own results", environment: { GROK_HOME: home }, enabled: true,
    config: { cli: FAKE_CLI, fullAuto: false },
  });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId, text: "summarise the inbox", cwd });
  const opened = await recorder.until((e) => e.type === "request.opened") as any;
  const own = isOwnToolResultRead({
    tool: opened.tool,
    command: isCommandTool(opened.tool) ? commandFromToolInput(opened.toolCall?.input) : undefined,
    filePaths: opened.filePaths,
    dirs: opened.toolResultDirs,
  });
  const verdict = autoVerdict({ autoApprove: false }, opened.tool, opened.summary, { ownToolResults: own });
  await instance.adapter.respondToRequest(threadId, opened.requestId, { behavior: "deny" });
  await recorder.until((e) => e.type === "turn.completed");
  return { opened, verdict };
}

describe("an ACP engine reading its own saved MCP result", () => {
  it("names the session's own result folder on the ask, and Ask mode answers the read", async () => {
    // The engine runs under the home Murage scoped for it, not the one it was
    // configured with: learn it from the child itself, then save a result in
    // that session's folder the way the engine does before naming the file.
    await askFor("echo warm", "t-own-warm");
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    const childHome = JSON.parse(readFileSync(join(scratch, "dump.json"), "utf8")).env.GROK_HOME as string;
    const dir = join(childHome, "sessions", fuigoSessionKey(cwd), "fake-acp-session", "mcp");
    mkdirSync(dir, { recursive: true });
    const saved = join(dir, "call_00_Ugx02hBzWG21yy4QOx9K5297.json");
    writeFileSync(saved, JSON.stringify({ messages: [{ subject: "Invoice" }] }));
    const { opened, verdict } = await askFor(
      `cat ${process.platform === "win32" ? `'${saved}'` : saved} | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['messages'][0]['subject'])"`, "t-own-read");
    expect(opened.toolResultDirs).toEqual(sessionDirs(childHome));
    expect(verdict).toMatchObject({ source: "own-tool-results" });
    expect(verdict.approve).toBeTruthy();
  });

  it("still asks for a read of any other file", async () => {
    const other = join(scratch, "notes.txt");
    writeFileSync(other, "private");
    const { verdict } = await askFor(`cat ${other}`, "t-other-read");
    expect(verdict.approve).toBeNull();
  });

  it("still asks when the command also writes", async () => {
    await askFor("echo warm", "t-own-warm2");
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    const childHome = JSON.parse(readFileSync(join(scratch, "dump.json"), "utf8")).env.GROK_HOME as string;
    const dir = join(childHome, "sessions", fuigoSessionKey(cwd), "fake-acp-session", "mcp");
    mkdirSync(dir, { recursive: true });
    const saved = join(dir, "call_00_x.json");
    writeFileSync(saved, "{}");
    const { opened, verdict } = await askFor(`cat ${saved} > ${join(scratch, "copy.json")}`, "t-own-write");
    expect(opened.toolResultDirs).toEqual(sessionDirs(childHome));
    expect(verdict.approve).toBeNull();
  });
});
