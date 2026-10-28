// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra 1.0.3 pre-audit (A): a permission ask's F12 record (`execEnv`) holds the
// exact map handed to the engine, provider API key included on a turn with a
// configured provider. It never leaves the server: not on a runtime frame (live
// or replayed), not in the thread's event log, not through the inspector read.
// Every key value here is fake.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { readThreadEvents } from "./thread-events.ts";
import { loggedRuntimeEvent, requestOpenedOut, windowRuntimeEvent } from "./runtime-event-out.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const FAKE_PROVIDER_KEY = "fake-provider-key-0001-not-real";
const FAKE_SHELL_VALUE = "fake-shell-value-0002-not-real";

function ask(threadId = "t-creds"): RuntimeEvent {
  return {
    eventId: "e-1", provider: "claudeAgent", threadId, createdAt: "2026-10-19T00:00:00.000Z", turnId: "turn-1", requestId: "r-1",
    raw: { source: "engine", payload: { env: { ANTHROPIC_API_KEY: FAKE_PROVIDER_KEY } } },
    type: "request.opened", requestType: "permission", tool: "Bash", summary: "ls -la",
    toolInput: "{\"command\":\"ls -la\"}", toolKind: "execute", toolEngine: "claudeAgent",
    toolCall: { name: "Bash", input: { command: "ls -la" } },
    mcpMounts: [],
    execEnv: {
      env: { PATH: "/usr/bin:/bin", HOME: "/home/fake", ANTHROPIC_API_KEY: FAKE_PROVIDER_KEY, ANTHROPIC_BASE_URL: "https://provider.invalid", PROVIDER_LOOKALIKE: FAKE_SHELL_VALUE },
      absent: ["BASH_ENV"], cwd: "/home/fake", shell: ["/bin/sh", "-c"], capture: "session",
    },
  } as unknown as RuntimeEvent;
}

describe("a permission ask leaving the server", () => {
  it("goes out to a stream as its allowlisted card fields only", () => {
    const out = windowRuntimeEvent(ask());
    const text = JSON.stringify(out);
    expect(text).not.toContain(FAKE_PROVIDER_KEY);
    expect(text).not.toContain(FAKE_SHELL_VALUE);
    for (const field of ["execEnv", "toolCall", "mcpMounts", "raw"]) expect(Object.hasOwn(out, field)).toBe(false);
    expect(out).toMatchObject({ type: "request.opened", requestId: "r-1", threadId: "t-creds", turnId: "turn-1", tool: "Bash", summary: "ls -la", toolInput: "{\"command\":\"ls -la\"}", toolKind: "execute", toolEngine: "claudeAgent" });
  });

  it("Astra #9: carries the value-free projection of the record (names, shell, provenance, managed names) to the card and the log", () => {
    const { raw: _raw, ...base } = ask() as RuntimeEvent & { execEnv: Record<string, unknown>; raw?: unknown };
    const event = { ...base, execEnv: { ...base.execEnv, provenance: { kind: "inherited", cli: "2.1.305", adds: ["CLAUDECODE"], unenforceable: ["POSIXLY_CORRECT", "GIT_SSH"], ownerRouting: ["ANTHROPIC_BASE_URL"] }, managedEnv: ["PAGER"] } } as unknown as RuntimeEvent;
    const forged = { ...event, envInfo: { names: [FAKE_SHELL_VALUE] } } as unknown as RuntimeEvent;
    for (const out of [windowRuntimeEvent(event), loggedRuntimeEvent(event), windowRuntimeEvent(forged)]) {
      const info = (out as { envInfo?: Record<string, unknown> }).envInfo;
      expect(info).toEqual({
        names: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "HOME", "PATH", "PROVIDER_LOOKALIKE"],
        absent: ["BASH_ENV"], shell: ["/bin/sh", "-c"], capture: "session",
        provenance: { kind: "inherited", cli: "2.1.305", adds: ["CLAUDECODE"], unenforceable: ["POSIXLY_CORRECT", "GIT_SSH"], ownerRouting: ["ANTHROPIC_BASE_URL"] },
        managedEnv: ["PAGER"],
      });
      const text = JSON.stringify(out);
      expect(text).not.toContain(FAKE_PROVIDER_KEY);
      expect(text).not.toContain(FAKE_SHELL_VALUE);
      expect(text).not.toContain("provider.invalid");
      expect(Object.hasOwn(out, "execEnv")).toBe(false);
    }
  });

  it("is allowlisted even when the ask carries no tool call or mounts", () => {
    const { toolCall: _call, mcpMounts: _mounts, ...rest } = ask() as RuntimeEvent & { toolCall?: unknown; mcpMounts?: unknown };
    expect(JSON.stringify(windowRuntimeEvent(rest as RuntimeEvent))).not.toContain(FAKE_PROVIDER_KEY);
  });

  it("OPENAI-TOOLS-109: the log keeps the call's name only, never its exact input (every engine)", () => {
    const secret = "tok-ordinary-field-7f3a9c2e";
    const event = { ...ask(), toolCall: { name: "mcp__custom__note", input: { note: secret } } } as unknown as RuntimeEvent;
    const out = loggedRuntimeEvent(event) as RuntimeEvent & { toolCall?: { name: string; input?: unknown } };
    expect(out.toolCall).toEqual({ name: "mcp__custom__note" });
    expect(JSON.stringify(out)).not.toContain(secret);
    // the live event is untouched: the handler still judges the exact call
    expect((event as unknown as { toolCall: { input: { note: string } } }).toolCall.input.note).toBe(secret);
    const { toolCall: _drop, ...noCall } = event as RuntimeEvent & { toolCall?: unknown };
    expect(Object.hasOwn(loggedRuntimeEvent(noCall as RuntimeEvent), "toolCall")).toBe(false);
  });

  it("leaves other frames as they were", () => {
    const text: RuntimeEvent = { eventId: "e-2", provider: "claudeAgent", threadId: "t", createdAt: "x", type: "item.completed", itemType: "assistant_text", origin: "engine", text: "hello" };
    expect(windowRuntimeEvent(text)).toBe(text);
    expect(loggedRuntimeEvent(text)).toBe(text);
  });

  it("is written to the thread's event log without the handed map", () => {
    const writes: string[] = [];
    const bus = new EventBus(((_file: string, data: string) => { writes.push(data); }) as never);
    bus.publish(ask("t-creds-log"));
    const written = writes.join("");
    expect(written).toContain("request.opened");
    expect(written).not.toContain("\"execEnv\"");
    expect(written).not.toContain(FAKE_PROVIDER_KEY);
    expect(written).not.toContain(FAKE_SHELL_VALUE);
  });

  it("is read back by the inspector without the handed map, even from a line an older build wrote", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-ask-out-"));
    try {
      const eventsDir = join(root, "events");
      const nativeDir = join(root, "native");
      mkdirSync(eventsDir, { recursive: true });
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(eventsDir, "t-creds-old.ndjson"), `${JSON.stringify(ask("t-creds-old"))}\n`);
      const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t-creds-old" });
      const text = JSON.stringify(page);
      expect(text).toContain("request.opened");
      expect(text).not.toContain("execEnv");
      expect(text).not.toContain(FAKE_PROVIDER_KEY);
      expect(text).not.toContain(FAKE_SHELL_VALUE);
    } finally {
      removeTempDirSync(root);
    }
  });

  it("is the one projection the server's runtime broadcast uses", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    const opener = "broadcast({ kind: \"runtime\", event: ";
    const calls: string[] = [];
    for (let at = source.indexOf(opener); at >= 0; at = source.indexOf(opener, at + 1)) calls.push(source.slice(at + opener.length, at + opener.length + 40));
    expect(calls.length).toBe(2);
    // the goal coordinator's own text frame is built field by field from an assistant_text event
    for (const call of calls) expect(call.startsWith("windowRuntimeEvent(event) })") || call.startsWith("publicAssistantEvent })")).toBe(true);
  });

  it("names every request.opened field as out or kept in", () => {
    // a field the projection does not name is dropped, never sent by default
    const extra = { ...ask(), futureSecret: FAKE_PROVIDER_KEY } as unknown as RuntimeEvent;
    expect(JSON.stringify(requestOpenedOut(extra as Extract<RuntimeEvent, { type: "request.opened" }>))).not.toContain(FAKE_PROVIDER_KEY);
  });
});
