// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra 1.0.3 pre-audit (A): a permission ask's F12 record (`execEnv`) holds the
// exact map handed to the engine, provider API key included on a turn with a
// configured provider. It never leaves the server: not on a runtime frame (live
// or replayed), not in the thread's event log, not through the inspector read.
// Every key value here is fake.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { readThreadEvents } from "./thread-events.ts";
import { loggedRuntimeEvent, requestOpenedOut, windowRuntimeEvent } from "./runtime-event-out.ts";
// design NOLIMITS-S1S2-H6-ALLOWLIST.md section 4 (test order): helpers not yet exported are read through a namespace + guard
import * as out from "./runtime-event-out.ts";
import { boundedToolInput } from "./approval-text.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { ensureDirs, NATIVE_DIR } from "./config.ts";
import { appendNative } from "./drivers/native.ts";
import { appendDecision, flushDecisionLog, readDecisions } from "./decision-log.ts";

ensureDirs();

it('keeps the local tool execution cwd on the server', () => {
  const event = { ...ask(), executionCwd: '/fixture/private-tool-cwd' } as Extract<RuntimeEvent, { type: 'request.opened' }>;
  expect(requestOpenedOut(event)).toEqual(requestOpenedOut(ask() as typeof event));
  expect(loggedRuntimeEvent(event)).toEqual(loggedRuntimeEvent(ask()));
});

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

  it("leaves other frames as they were on the stream; the log keeps a reply's ids and a fixed label (sink allowlist)", () => {
    const text: RuntimeEvent = { eventId: "e-2", provider: "claudeAgent", threadId: "t", createdAt: "x", type: "item.completed", itemType: "assistant_text", origin: "engine", text: "hello" };
    expect(windowRuntimeEvent(text)).toBe(text);
    expect(loggedRuntimeEvent(text)).toEqual({ eventId: "e-2", provider: "claudeAgent", threadId: "t", createdAt: "x", type: "item.completed", itemType: "assistant_text", origin: "engine", text: out.REPLY_LOGGED_TEXT });
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

// NOLIMITS 1.0.18 logger lane (design NOLIMITS-S1S2-H6-ALLOWLIST.md section 2 L1-L4, section 4.4 rows 1-6a; L4's
// toolStartPaths is NOLIMITS-S1S2-H6-LOGGER-REDESIGN.md 2.1). Assertions are per row, in three sets (4.4): T (an ordinary
// tool start), U (unchanged rows). Set P (withheld rows) lives in harness/bus-phone-withhold.test.ts. Red/green at the
// tests-first baseline ba3d38869 is recorded in the lane handoff (qb1), never predicted here.
describe("NOLIMITS L1-L4: a logged tool start is an allowlist (design 4.4)", () => {
  const SECRET = "confidential-plan-text-7f3a";
  const ns = out as unknown as Record<string, unknown>;
  const toolStartPaths = ns.toolStartPaths as ((input: unknown) => unknown) | undefined;
  const loggedToolTitle = ns.loggedToolTitle as ((event: unknown) => unknown) | undefined;
  const T_KEYS: ReadonlySet<string> = new Set(["type", "itemType", "origin", "eventId", "provider", "providerInstanceId", "threadId", "turnId", "createdAt", "itemId", "title", "toolKind", "toolIdentity", "input"]);
  const start = (extra: Record<string, unknown>): RuntimeEvent => ({
    type: "item.started", itemType: "tool", origin: "engine", eventId: "e-log", provider: "fakeAsk", providerInstanceId: "inst-1",
    threadId: "t-log", turnId: "turn-1", createdAt: "2026-11-06T00:00:00.000Z", itemId: "item-1", ...extra,
  }) as unknown as RuntimeEvent;
  const logged = (event: RuntimeEvent) => loggedRuntimeEvent(event) as unknown as Record<string, unknown>;
  /** Set T: keys within L1's list, none of the dropped keys, SECRET nowhere in the whole row. */
  const setT = (row: Record<string, unknown>, label: string) => {
    for (const key of Object.keys(row)) expect(T_KEYS.has(key), `${label}: unexpected key ${key}`).toBe(true);
    for (const key of ["summary", "spoken", "callKey", "raw", "detail"]) expect(Object.hasOwn(row, key), `${label}: ${key}`).toBe(false);
    expect(JSON.stringify(row), label).not.toContain(SECRET);
  };
  const nest = (levels: number, leaf: Record<string, unknown>): Record<string, unknown> => {
    let value: Record<string, unknown> = leaf;
    for (let i = 0; i < levels; i++) value = { tool_input: value };
    return value;
  };

  // row 1 (Fable r2 4.3 rows 1-14), through loggedRuntimeEvent; `undefined` means the logged row has NO input key
  const INPUT_ROWS: Array<[string, unknown, unknown]> = [
    ["4.3-1 bounded string", boundedToolInput({ path: "/w/a.md", content: SECRET.repeat(2000) }), undefined],
    ["4.3-2 ACP wrapper", { tool_name: "write_file", tool_input: { path: "/w/a.md", content: SECRET } }, { tool_name: "write_file", tool_input: { path: "/w/a.md" } }],
    ["4.3-3 two-level wrapper", { toolName: "use_tool", args: { tool_input: { file_path: "/w/a.md", content: SECRET } } }, { toolName: "use_tool", args: { tool_input: { file_path: "/w/a.md" } } }],
    ["4.3-4 unknown fields", { file_path: "/w/a.md", body: SECRET, text: SECRET, markdown: SECRET, data: { blob: SECRET } }, { file_path: "/w/a.md" }],
    ["4.3-5 path key non-strings", { path: { content: SECRET }, files: [{ content: SECRET }, "/w/b.md"] }, { files: ["/w/b.md"] }],
    ["4.3-6 Codex changes", { changes: [{ path: "/w/notes.md", kind: { type: "update" }, diff: SECRET }, { path: "/w/new.md", kind: "add", content: SECRET }] }, { changes: [{ path: "/w/notes.md", kind: "update" }, { path: "/w/new.md", kind: "add" }] }],
    ["4.3-7 ACP locations", { locations: [{ path: "/w/a.md", line: 3 }], content: SECRET }, { locations: [{ path: "/w/a.md" }] }],
    ["4.3-8 shell", { command: "cat > /w/a.md <<EOF\n" + SECRET + "\nEOF", cwd: "/w", description: SECRET }, { cwd: "/w" }],
    ["4.3-10 array", [SECRET], undefined],
    ["4.3-10 number", 7, undefined],
    ["4.3-10 string", SECRET, undefined],
    ["4.3-10 null", null, undefined],
    ["4.3-11 content subtree", { content: { name: SECRET, path: "/w/a.md" } }, undefined],
    ["4.3-11 attacker key", { [SECRET]: { path: "/w/a.md" } }, undefined],
    ["4.3-11 source", { source: SECRET, destination: "/w/b.md" }, { destination: "/w/b.md" }],
    ["4.3-11 name and file", { name: SECRET, file: SECRET, path: "/w/a.md" }, { path: "/w/a.md" }],
    ["4.3-11 array wrapper", { args: [{ path: "/w/a.md" }] }, undefined],
    ["4.3-11 depth 4", nest(4, { path: "/w/a.md" }), nest(4, { path: "/w/a.md" })],
    ["4.3-11 depth 5", nest(5, { path: "/w/a.md" }), undefined],
    // GrokBuild case 21: a kept path holds a separator, so the long item starts with one
    ["4.3-11 cap (non-secret data)", { input: { params: { paths: ["/w/a.md", 7, "/" + "p".repeat(2999)] } } }, { input: { params: { paths: ["/w/a.md", "/" + "p".repeat(1023)] } } }],
    // case 21 + cap: the separator test reads the capped value, so a separator past 1,024 bytes keeps no word
    ["4.3-11 cap drops a word whose separator is past the cap", { path: "p".repeat(2000) + "/x" }, undefined],
    ["4.3-13 files cap", { files: Array.from({ length: 100 }, (_, i) => `/w/f${i}.md`) }, { files: Array.from({ length: 64 }, (_, i) => `/w/f${i}.md`) }],
    ["4.3-13 changes cap", { changes: Array.from({ length: 100 }, (_, i) => ({ path: `/w/c${i}.md`, kind: "add", diff: SECRET })) }, { changes: Array.from({ length: 64 }, (_, i) => ({ path: `/w/c${i}.md`, kind: "add" })) }],
  ];
  for (const [label, input, want] of INPUT_ROWS) {
    it(`row 1 (L4, Set T): ${label}`, () => {
      const row = logged(start({ title: "Write", input, callKey: "k-1" }));
      setT(row, label);
      if (want === undefined) expect(Object.hasOwn(row, "input"), label).toBe(false);
      else expect(row.input, label).toEqual(want);
      // the line stays well-formed JSON
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    });
  }
  it("row 1 (L4) 4.3-11: the capped item is 1,024 bytes", () => {
    const row = logged(start({ title: "Write", input: { input: { params: { paths: ["/w/a.md", 7, "/" + "p".repeat(2999)] } } } }));
    const kept = ((row.input as { input: { params: { paths: string[] } } }).input.params.paths)[1]!;
    expect(Buffer.byteLength(kept)).toBe(1024);
  });
  it("row 1 (L4) 4.3-12: toolStartPaths is exported and idempotent on rows 2, 3, 6, 7", () => {
    expect(typeof toolStartPaths, "toolStartPaths export (design step 3)").toBe("function");
    for (const [label, input, want] of INPUT_ROWS.filter(([l]) => /^4\.3-(2|3|6|7) /.test(l))) {
      const once = toolStartPaths!(input);
      expect(once, label).toEqual(want);
      expect(toolStartPaths!(once), label).toEqual(once);
    }
  });
  it("row 1 (L4): toolStartPaths never throws and never mutates its input", () => {
    expect(typeof toolStartPaths, "toolStartPaths export (design step 3)").toBe("function");
    const input = { tool_name: "write_file", tool_input: { path: "/w/a.md", content: SECRET }, changes: [{ path: "/w/b.md", diff: SECRET }] };
    const before = structuredClone(input);
    expect(() => toolStartPaths!(input)).not.toThrow();
    expect(input).toEqual(before);
    for (const odd of [undefined, null, 0, "", [], () => 1, Object.create(null)]) expect(() => toolStartPaths!(odd)).not.toThrow();
    expect(toolStartPaths!({ tool_name: "a sentence with " + SECRET, path: "/w/a.md" }), "NAME_FIELDS must match IDENT").toEqual({ path: "/w/a.md" });
  });

  // row 2 (L2/L3), Set T
  const TITLE_ROWS: Array<[string, Record<string, unknown>, string, Record<string, unknown>?]> = [
    ["Codex heredoc", { provider: "codex", title: "cat > /w/a.md <<EOF\n" + SECRET + "\nEOF", toolIdentity: { name: "shell" } }, "shell"],
    ["ACP unstamped (r2 #3 literal)", { provider: "geminiAgent", title: "confidential-plan-text-7f3a", toolKind: "execute" }, "execute"],
    ["ACP unstamped, bogus kind", { provider: "geminiAgent", title: SECRET, toolKind: "bogus kind" }, "tool"],
    ["ACP wrapped", { provider: "geminiAgent", title: "write_file", summary: SECRET, input: { tool_name: "write_file", tool_input: { text: SECRET, path: "/w/a.md" } }, toolKind: "edit" }, "edit", { input: { tool_name: "write_file", tool_input: { path: "/w/a.md" } } }],
    ["BoxAgent (r2 #3 literal)", { provider: "boxAgent", title: "confidential-plan-text-7f3a" }, "tool"],
    ["BoxAgent ls (r2 #9)", { provider: "boxAgent", title: "ls" }, "tool"],
    ["claude Write", { provider: "claudeAgent", title: "Write", input: { file_path: "/w/a.md", content: SECRET } }, "Write", { input: { file_path: "/w/a.md" } }],
    ["claude non-IDENT title", { provider: "claudeAgent", title: "x " + SECRET }, "tool"],
    ["antigravity", { provider: "antigravityAgent", title: "run_command" }, "run_command"],
    ["Fuigo stamp", { provider: "fuigoAgent", title: "x " + SECRET, toolIdentity: { namespace: "fuigo", name: "write_file" } }, "write_file", { toolIdentity: { namespace: "fuigo", name: "write_file" } }],
    ["non-IDENT identity", { provider: "codex", title: "x " + SECRET, toolIdentity: { name: SECRET + " x" }, toolKind: "read" }, "read"],
  ];
  for (const [label, extra, title, more] of TITLE_ROWS) {
    it(`row 2 (L2/L3, Set T): ${label} logs title ${title}`, () => {
      const row = logged(start(extra));
      setT(row, label);
      expect(row.title, label).toBe(title);
      if (more) expect(row, label).toMatchObject(more);
      if (label === "ACP unstamped, bogus kind") expect(Object.hasOwn(row, "toolKind")).toBe(false);
      if (label === "non-IDENT identity") expect(Object.hasOwn(row, "toolIdentity")).toBe(false);
      if (extra.toolKind === "execute" || extra.toolKind === "edit" || extra.toolKind === "read") expect(row.toolKind).toBe(extra.toolKind);
    });
  }
  it("row 2 (L2): loggedToolTitle is exported and gives the same titles", () => {
    expect(typeof loggedToolTitle, "loggedToolTitle export (design step 3)").toBe("function");
    for (const [label, extra, title] of TITLE_ROWS) expect(loggedToolTitle!(start(extra)), label).toBe(title);
  });

  // row 3 (L2, origin murage), Set T
  it("row 3 (L2, Set T): a Fuigo stderr notice logs title notice (r2 #3 literal)", () => {
    const row = logged(start({ origin: "murage", provider: "fuigoAgent", title: "Fuigo: confidential-plan-text-7f3a", toolKind: "notice" }));
    setT(row, "fuigo notice");
    expect(row.title).toBe("notice");
  });
  it("row 3 (L2, Set T): a Codex wait line logs title murage and no spoken", () => {
    const row = logged(start({ origin: "murage", provider: "codex", title: "Waiting " + SECRET, spoken: "Waiting " + SECRET }));
    setT(row, "codex wait");
    expect(row.title).toBe("murage");
  });

  // row 4 (L1), Set T
  it("row 4 (L1, Set T): raw, detail, spoken, callKey and a future key never reach the log", () => {
    const row = logged(start({ title: "Read", raw: { text: SECRET }, detail: SECRET, spoken: SECRET, callKey: "k-9", futureField: SECRET }));
    setT(row, "key allowlist");
    expect(Object.hasOwn(row, "futureField")).toBe(false);
    expect(row).toMatchObject({ type: "item.started", itemType: "tool", origin: "engine", eventId: "e-log", provider: "fakeAsk", providerInstanceId: "inst-1", threadId: "t-log", turnId: "turn-1", createdAt: "2026-11-06T00:00:00.000Z", itemId: "item-1" });
  });

  // row 5: formerly Set U ("logged as it is"). MurageMain ruling 2026-11-06 + Astra r1 H9: every logged row is the sink
  // allowlist, so these rows keep their ids, enums, numbers and flags, and their text becomes a fixed label or is dropped.
  const U_ROWS: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["reasoning start, no input", { type: "item.started", itemType: "reasoning", origin: "engine", eventId: "e-r", provider: "fakeAsk", threadId: "t-log", turnId: "turn-1", createdAt: "x", itemId: "r-1", title: "Thinking it over", summary: "a plan", callKey: "k-r" },
      { type: "item.started", itemType: "reasoning", origin: "engine", eventId: "e-r", provider: "fakeAsk", threadId: "t-log", turnId: "turn-1", createdAt: "x", itemId: "r-1", title: "reasoning" }],
    ["assistant text", { type: "item.completed", itemType: "assistant_text", origin: "engine", eventId: "e-a", provider: "fakeAsk", threadId: "t-log", createdAt: "x", text: "hello there" },
      { type: "item.completed", itemType: "assistant_text", origin: "engine", eventId: "e-a", provider: "fakeAsk", threadId: "t-log", createdAt: "x", text: out.REPLY_LOGGED_TEXT }],
    ["turn completed", { type: "turn.completed", eventId: "e-c", provider: "fakeAsk", threadId: "t-log", turnId: "turn-1", createdAt: "x", ok: true },
      { type: "turn.completed", eventId: "e-c", provider: "fakeAsk", threadId: "t-log", turnId: "turn-1", createdAt: "x", ok: true }],
    ["tool completion (H9)", { type: "item.completed", itemType: "tool", eventId: "e-d", provider: "fakeAsk", threadId: "t-log", turnId: "turn-1", createdAt: "x", itemId: "item-1", ok: true, result: "file words", detail: "a detail" },
      { type: "item.completed", itemType: "tool", eventId: "e-d", provider: "fakeAsk", threadId: "t-log", turnId: "turn-1", createdAt: "x", itemId: "item-1", ok: true }],
  ];
  for (const [label, event, want] of U_ROWS) {
    it(`row 5 (sink allowlist): ${label} is logged as its ids, flags and fixed labels`, () => {
      expect(loggedRuntimeEvent(event as unknown as RuntimeEvent)).toEqual(want);
    });
  }
  it("row 5 (Set U, L1 reasoning clause): a reasoning start's input keeps its paths only", () => {
    const reasoning = (input: Record<string, unknown>) => ({ type: "item.started", itemType: "reasoning", origin: "engine", eventId: "e-r2", provider: "fakeAsk", threadId: "t-log", createdAt: "x", itemId: "r-2", title: "Thinking", input }) as unknown as RuntimeEvent;
    const content = logged(reasoning({ content: SECRET, path: "/w/a.md" }));
    expect(content.input).toEqual({ path: "/w/a.md" });
    expect(JSON.stringify(content)).not.toContain(SECRET);
    const text = logged(reasoning({ text: SECRET, path: "/w/a.md" }));
    expect(text.input).toEqual({ path: "/w/a.md" });
    expect(JSON.stringify(text)).not.toContain(SECRET);
    // sink allowlist: a reasoning start's title is display text, logged as the fixed label
    expect(text.title).toBe("reasoning");
  });
  it("row 5: the original event is not mutated, and windowRuntimeEvent still drops input", () => {
    const event = start({ provider: "codex", title: "cat " + SECRET, summary: SECRET, toolIdentity: { name: "shell" }, input: { command: "cat " + SECRET, cwd: "/w" }, callKey: "k" });
    const before = structuredClone(event);
    loggedRuntimeEvent(event);
    expect(event).toEqual(before);
    const window = windowRuntimeEvent(event) as unknown as Record<string, unknown>;
    expect(window.input).toBeUndefined();
    expect(Object.hasOwn(window, "callKey")).toBe(false);
  });

  // row 6 (a): the real bus, Set T
  it("row 6a (L6, Set T): a Codex shell start is logged as shell with its cwd; the live listener gets the original; the line reads back", () => {
    const writes: string[] = [];
    const bus = new EventBus(((_file: string, data: string) => { writes.push(data); }) as never);
    const delivered: RuntimeEvent[] = [];
    bus.subscribe((event: RuntimeEvent) => { delivered.push(event); }, { durable: false });
    const event = start({ provider: "codex", threadId: "t-log-bus", title: "cat > /w/a.md <<EOF\n" + SECRET + "\nEOF", toolIdentity: { name: "shell" }, input: { command: "cat > /w/a.md <<EOF\n" + SECRET + "\nEOF", cwd: "/w" } });
    bus.publish(event);
    const lines = writes.join("").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    setT(row, "bus codex shell");
    expect(row.title).toBe("shell");
    expect(row.input).toEqual({ cwd: "/w" });
    expect(delivered.some((e) => JSON.stringify(e).includes(SECRET) && (e as unknown as { title: string }).title === (event as unknown as { title: string }).title)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "murage-log-allow-"));
    try {
      mkdirSync(join(root, "events"), { recursive: true });
      mkdirSync(join(root, "native"), { recursive: true });
      writeFileSync(join(root, "events", "t-log-bus.ndjson"), `${lines[0]}\n`);
      const page = readThreadEvents({ eventsDir: join(root, "events"), nativeDir: join(root, "native"), threadId: "t-log-bus" });
      expect(page.entries.map((entry) => entry.data)).toEqual([expect.objectContaining({ type: "item.started", itemType: "tool", itemId: "item-1", title: "shell" })]);
    } finally {
      removeTempDirSync(root);
    }
  });
});

// GrokBuild review of 857471594, open cases 18, 19 and 21 (case 20, the native trace, is in drivers/native.test.ts). The
// projection is the persisted log's only: the live ask (windowRuntimeEvent) and the live error keep their text for the card.
describe("Grok cases 18, 19, 21: no command text in a logged ask, error or tool-start path", () => {
  const SECRET = "confidential-plan-text-7f3a";
  const shellAsk = (extra: Record<string, unknown>): RuntimeEvent => ({
    eventId: "e-ask", provider: "codex", threadId: "t-grok", createdAt: "2026-11-06T00:00:00.000Z", turnId: "turn-1", requestId: "r-1",
    type: "request.opened", requestType: "permission", tool: "shell", summary: SECRET, ...extra,
  }) as unknown as RuntimeEvent;

  it("case 18 (Grok's row): a shell ask's summary and toolInput never reach the log", () => {
    expect(JSON.stringify(loggedRuntimeEvent({ type: "request.opened", summary: SECRET, toolInput: JSON.stringify({ command: SECRET }) }))).not.toContain(SECRET);
  });

  it("case 18: every engine's shell ask logs summary and reason `shell` and toolInput as its paths only; the live card keeps the command", () => {
    const asks: Array<[string, RuntimeEvent]> = [
      ["claude Bash", shellAsk({ provider: "claudeAgent", tool: "Bash", toolKind: "execute", toolInput: JSON.stringify({ command: `cat ${SECRET}`, description: SECRET }), toolCall: { name: "Bash", input: { command: `cat ${SECRET}`, description: SECRET } } })],
      ["codex shell", shellAsk({ tool: "shell", reason: `I need to run ${SECRET}`, toolInput: JSON.stringify({ command: SECRET, cwd: "/w" }) })],
      ["acp execute", shellAsk({ provider: "fuigo", tool: "run_shell_command", toolKind: "execute", toolCall: { name: "run_shell_command", input: { command: SECRET } } })],
      ["openai-chat MCP call with a command", shellAsk({ provider: "openaiChat", tool: "computer__run", toolIdentity: { namespace: "mcp", name: "computer__run" }, toolInput: JSON.stringify({ cmd: SECRET, workdir: "/w" }), toolCall: { name: "computer__run", input: { cmd: SECRET, workdir: "/w" } } })],
      ["pi bash", shellAsk({ provider: "pi", tool: "bash", toolInput: JSON.stringify({ command: SECRET }) })],
      ["antigravity run_command", shellAsk({ provider: "antigravityAgent", tool: "run_command", toolCall: { name: "run_command", input: { command: SECRET, cwd: "/w" } } })],
      ["boxagent terminal", shellAsk({ provider: "boxAgent", tool: "terminal", toolInput: SECRET })],
      ["pwsh", shellAsk({ tool: "powershell", commandShell: "pwsh", toolInput: JSON.stringify({ command: SECRET }) })],
    ];
    for (const [label, event] of asks) {
      const row = loggedRuntimeEvent(event) as unknown as Record<string, unknown>;
      expect(JSON.stringify(row), label).not.toContain(SECRET);
      expect(row.summary, label).toBe("shell");
      if (Object.hasOwn(event, "reason")) expect(row.reason, label).toBe("shell");
      if (row.toolInput !== undefined) expect(JSON.parse(row.toolInput as string), label).toEqual(out.toolStartPaths(JSON.parse((event as { toolInput: string }).toolInput)));
      // the live card is unchanged
      expect(JSON.stringify(windowRuntimeEvent(event)), label).toContain(SECRET);
    }
    const codexRow = loggedRuntimeEvent(asks[1]![1]) as unknown as Record<string, unknown>;
    expect(JSON.parse(codexRow.toolInput as string)).toEqual({ cwd: "/w" });
  });

  // Astra r1 H8 (replaces "a non-shell ask keeps its summary, reason and toolInput"): every logged ask is the allowlist
  it("H8 (Astra's row): a Claude Write ask's file content never reaches the log", () => {
    const S = "confidential plan text 7f3a";
    expect(JSON.stringify(loggedRuntimeEvent({ type: "request.opened", tool: "Write", summary: S, reason: S, toolInput: JSON.stringify({ file_path: "/w/notes.md", content: S }) }))).not.toContain(S);
  });
  it("H8: a non-shell ask logs a fixed summary and reason and its paths only; the live card keeps its text", () => {
    const write = shellAsk({ provider: "claudeAgent", tool: "Write", summary: `Write /w/notes.md: ${SECRET}`, reason: SECRET, toolKind: "edit", toolInput: JSON.stringify({ file_path: "/w/notes.md", content: SECRET }), toolCall: { name: "Write", input: { file_path: "/w/notes.md", content: SECRET } } });
    const row = loggedRuntimeEvent(write) as unknown as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row).toMatchObject({ tool: "Write", summary: "edit", reason: "edit", toolInput: JSON.stringify({ file_path: "/w/notes.md" }), toolCall: { name: "Write" } });
    expect(JSON.stringify(windowRuntimeEvent(write))).toContain(SECRET);
    const fetch = shellAsk({ provider: "claudeAgent", tool: "WebFetch", summary: "https://example.invalid/a", reason: "read the docs", toolInput: JSON.stringify({ url: "https://example.invalid/a" }) });
    const fetched = loggedRuntimeEvent(fetch) as unknown as Record<string, unknown>;
    expect(fetched).toMatchObject({ summary: "permission", reason: "permission" });
    expect(Object.hasOwn(fetched, "toolInput")).toBe(false);
    expect(JSON.stringify(fetched)).not.toContain("example.invalid");
    const question = shellAsk({ requestType: "question", tool: "AskUserQuestion", summary: "Which branch?", choices: ["main", "a dev branch"], questions: [{ id: "q1", question: "Which branch?", options: [{ label: "main" }] }] });
    const asked = loggedRuntimeEvent(question) as unknown as Record<string, unknown>;
    expect(asked.summary).toBe("question");
    expect(JSON.stringify(asked)).not.toContain("Which branch");
    expect(JSON.stringify(asked)).not.toContain("dev branch");
  });

  it("case 19 (Grok's row): the Rule 67 tripwire error is logged as a fixed sentence with no command", async () => {
    const { tripwireLine } = await import("./drivers/codex-hook.ts");
    expect(JSON.stringify(loggedRuntimeEvent({ type: "runtime.error", message: tripwireLine(SECRET) }))).not.toContain(SECRET);
    for (const command of [SECRET, "echo `x` ; rm -rf /tmp/a", "a\nb"]) {
      const row = loggedRuntimeEvent({ type: "runtime.error", message: tripwireLine(command) }) as { message: string };
      expect(row.message).toBe("Codex ran a command without Murage's check; the turn was stopped");
    }
    // sink allowlist (was: any other error is unchanged): any other error's text is the fixed label, its structured fields stay
    const other = { type: "runtime.error", message: `engine exited: ${SECRET}`, details: SECRET, errorKind: "engine_exit", setup: false };
    expect(loggedRuntimeEvent(other)).toEqual({ type: "runtime.error", message: out.ERROR_LOGGED_MESSAGE, errorKind: "engine_exit", setup: false });
  });

  it("case 21 (Grok's row): a tool start's cwd holding text is dropped with the command", () => {
    expect(JSON.stringify(loggedRuntimeEvent({ type: "item.started", itemType: "tool", input: { command: SECRET, cwd: SECRET } }))).not.toContain(SECRET);
  });

  it("case 21: a path value with whitespace, a quote, $, a backtick, |, ; or a newline is dropped; plain paths stay", () => {
    for (const bad of ["/w/a b", "/w/'a'", "/w/\"a\"", "/w/$HOME", "/w/`id`", "/w/a|b", "/w/a;b", "/w/a\nb", "/w/a\tb"]) {
      expect(out.toolStartPaths({ cwd: bad, files: [bad, "/w/ok.md"], changes: [{ path: bad, kind: "add" }], locations: [{ path: bad }] }), JSON.stringify(bad))
        .toEqual({ files: ["/w/ok.md"] });
    }
    expect(out.toolStartPaths({ cwd: "/w/src-1.0_x", file_path: "C:\\w\\a.md", dir: ".", path: "./a.md" })).toEqual({ cwd: "/w/src-1.0_x", file_path: "C:\\w\\a.md", dir: ".", path: "./a.md" });
    // a word with no separator is not a path (Grok's row: `cwd: SECRET`)
    expect(out.toolStartPaths({ cwd: SECRET, file_path: "README.md", files: [SECRET, "/w/ok.md"] })).toEqual({ files: ["/w/ok.md"] });
  });

  it("case 21: changes[].kind is kept only for add, update and delete", () => {
    const row = out.toolStartPaths({ changes: [
      { path: "/w/a.md", kind: "add" }, { path: "/w/b.md", kind: { type: "update" } }, { path: "/w/c.md", kind: "delete" },
      { path: "/w/d.md", kind: SECRET }, { path: "/w/e.md", kind: { type: SECRET } },
    ] });
    expect(row).toEqual({ changes: [{ path: "/w/a.md", kind: "add" }, { path: "/w/b.md", kind: "update" }, { path: "/w/c.md", kind: "delete" }, { path: "/w/d.md" }, { path: "/w/e.md" }] });
    expect(JSON.stringify(loggedRuntimeEvent({ type: "item.started", itemType: "tool", input: { changes: [{ path: "/w/a", kind: SECRET }] } }))).not.toContain(SECRET);
  });

  it("M12 (Astra's row): a path field holding shell syntax is dropped", () => {
    expect(out.toolStartPaths({ cwd: "cat</w/private.txt" })).toBeUndefined();
    for (const bad of ["cat</w/a", "/w/a>/w/b", "/w/a&&id", "/w/a&", "(/w/a)", "/w/*", "/w/a?", "/w/!a", "/w/a=b", "/w/#a", "/w/[a]", "/w/{a,b}", "/w/a^b"]) {
      expect(out.toolStartPaths({ cwd: bad, files: [bad, "/w/ok.md"] }), bad).toEqual({ files: ["/w/ok.md"] });
    }
    // real paths stay: any script, digits, - _ . ~ @ + , % and both separators
    const good = { cwd: "~/proj-1/src_2", file_path: "/w/résumé/日本語.md", dir: "C:\\Users\\a\\b", path: "/w/a@2x+b,c%20.png" };
    expect(out.toolStartPaths(good)).toEqual(good);
  });
});

// MurageMain ruling 2026-11-06 (binding): ONE sink allowlist for the event log, native/<thread>.ndjson and the decision log.
// Every frame type the drivers emit is written through the real writers with a marker in every field, and the files read
// back hold no marker. Marker A has spaces (no identifier, path or label can hold it) and goes into EVERY string field, the
// discriminators included; marker B is identifier-shaped and goes into every field that is not an id or an enum by contract.
describe("sink allowlist: no marker reaches disk from any frame (Astra r1 H8-H11)", () => {
  const A = "confidential plan text 7f3a";
  const B = "confidential-plan-text-7f3b";
  /** Fields whose string value is an id or an enum by contract (marker B never goes there). */
  const ID_FIELDS: ReadonlySet<string> = new Set([
    "type", "subtype", "sessionUpdate", "kind", "status", "id", "callId", "call_id", "toolCallId", "tool_use_id", "itemId", "item_id", "threadId",
    "thread_id", "turnId", "turn_id", "sessionId", "session_id", "requestId", "request_id", "name", "tool", "toolName", "tool_name", "server",
    "namespace", "optionId", "role", "stop_reason", "jsonrpc", "eventId", "provider", "providerInstanceId", "createdAt", "itemType", "origin",
    "toolKind", "requestType", "behavior", "source", "streamKind", "toolEngine", "stopReason", "errorKind", "engineCode", "decision", "botId",
    "at", "method", "model", "routed", "requested", "priority", "deniedBy", "interjectionId", "beforeItemId", "approvalScope", "denials",
    // the bot's own name is the owner's label from the bot record (decision-log.ts loggedDecision)
    "botName",
    // path fields: kept by contract when they are paths (marker A, in the other two modes, goes into them too)
    "file_path", "path", "filePaths", "toolResultDirs", "cwd", "folder",
  ]);
  const DISCRIMINATORS: ReadonlySet<string> = new Set(["type", "itemType", "method", "sessionUpdate", "requestType", "decision", "source"]);
  type Mode = "all" | "all-but-discriminators" | "non-id";
  function mark(value: unknown, mode: Mode, key?: string): unknown {
    if (typeof value === "string") {
      if (mode === "all") return A;
      if (mode === "all-but-discriminators") return key !== undefined && DISCRIMINATORS.has(key) ? value : A;
      return key !== undefined && ID_FIELDS.has(key) ? value : B;
    }
    if (Array.isArray(value)) return value.map((item) => mark(item, mode, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mark(v, mode, k)]));
    return value;
  }
  const env = { eventId: "e-1", provider: "claudeAgent", providerInstanceId: "inst-1", threadId: "t-sink", createdAt: "2026-11-06T00:00:00.000Z", turnId: "turn-1" };
  const content = "file words: the plan";
  const EVENTS: Array<Record<string, unknown>> = [
    { ...env, type: "session.started", sessionId: "s-1", model: "claude-opus", sessionContract: 2 },
    { ...env, type: "turn.subtask", subtask: { id: "st-1", label: content, status: "running", startedAt: 1, toolCount: 2 }, subtasks: [{ id: "st-1", label: content, status: "running", startedAt: 1, toolCount: 2 }] },
    { ...env, type: "session.exited", reason: content },
    { ...env, type: "turn.started" },
    { ...env, type: "turn.retrying", attempt: 1, delayMs: 5, reason: content, maxAttempts: 3 },
    { ...env, type: "turn.completed", ok: true, stopReason: "end_turn", cost: 0.1, denials: ["Bash"], usage: { input: 1, output: 2 }, toolsUnavailable: ["connected apps"], deniedBy: "user" },
    { ...env, type: "item.started", itemType: "tool", origin: "engine", itemId: "i-1", title: "Write", summary: content, spoken: content, input: { file_path: "/w/a.md", content }, toolKind: "edit", toolIdentity: { namespace: "fuigo", name: "write_file", kind: "edit" }, callKey: "k-1" },
    { ...env, type: "item.started", itemType: "reasoning", itemId: "i-2", title: content, summary: content, input: { text: content } },
    { ...env, type: "item.completed", itemType: "tool", itemId: "i-1", ok: true, result: { content: [{ type: "text", text: content }] }, detail: content },
    { ...env, type: "item.completed", itemType: "tool", itemId: "i-1", ok: false, result: content, detail: content },
    { ...env, type: "item.completed", itemType: "assistant_text", origin: "engine", text: content, beforeItemId: "i-1" },
    { ...env, type: "item.completed", itemType: "assistant_image", data: content, alt: content },
    { ...env, type: "content.reset", streamKind: "assistant_text" },
    { ...env, type: "plan.updated", entries: [{ content, status: "pending", priority: "high" }] },
    { ...env, type: "engine.commands", commands: [{ name: "review", description: content }] },
    { ...env, type: "steer.confirmed", interjectionId: "j-1" },
    { ...env, type: "question.async", questions: [{ id: "q-1", header: content, question: content, options: [{ label: content, description: content }] }] },
    { ...env, type: "request.opened", requestId: "r-1", requestType: "permission", tool: "Write", summary: content, reason: content, choices: [content], toolKind: "edit",
      toolInput: JSON.stringify({ file_path: "/w/a.md", content }), toolCall: { name: "Write", input: { file_path: "/w/a.md", content } }, filePaths: ["/w/a.md"], toolResultDirs: ["/w/r"],
      raw: { text: content }, callKey: "k-1", localHold: content, toolInputMissing: "input", folderTrust: { key: content, folder: "/w", sources: [content], declines: [content] } },
    { ...env, type: "request.opened", requestId: "r-2", requestType: "permission", tool: "Bash", summary: `cat ${content}`, toolInput: JSON.stringify({ command: `cat ${content}`, cwd: "/w" }), commandShell: "pwsh" },
    { ...env, type: "request.opened", requestId: "r-3", requestType: "question", tool: "AskUserQuestion", summary: content, choices: [content], questions: [{ id: "q-1", question: content, options: [{ label: content }] }] },
    { ...env, type: "request.resolved", requestId: "r-1", behavior: "allow", source: "user", decidedBy: "own-workspace", folderTrustLate: "finished" },
    { ...env, type: "thread.token-usage.updated", input: 1, output: 2, cachedInput: 3 },
    { ...env, type: "turn.served-model", routed: "flux/a", requested: "flux/b" },
    { ...env, type: "runtime.error", message: content, details: content, errorKind: "engine_exit", engineCode: "QUOTA", providerError: { status: 500, message: content, body: content } },
    { ...env, type: "runtime.error", message: "Codex ran `cat /w/a.md` without Murage's check; the turn was stopped" },
    { ...env, type: "future.event", text: content, payload: { content } },
  ];
  const NATIVE: unknown[] = [
    { type: "assistant", message: { id: "m-1", role: "assistant", content: [{ type: "text", text: content }, { type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/w/a.md", content } }], usage: { input_tokens: 1 } } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: content }], is_error: false }, { type: "tool_result", tool_use_id: "toolu_2", content }] } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: content } } },
    { method: "item/started", params: { item: { type: "fileChange", id: "i-1", status: "inProgress", changes: [{ path: "/w/a.md", kind: { type: "update" }, diff: content }] } } },
    { method: "item/completed", params: { item: { type: "commandExecution", id: "i-2", command: content, cwd: "/w", aggregatedOutput: content, exitCode: 0 } } },
    { method: "item/completed", params: { item: { type: "agentMessage", id: "i-3", text: content } } },
    { method: "item/commandExecution/outputDelta", params: { itemId: "i-2", delta: content } },
    { method: "codex/event/exec_command_output_delta", params: { msg: { type: "exec_command_output_delta", call_id: "c-1", chunk: content } } },
    { type: "function_call_output", call_id: "c-1", output: content },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c-1", output: { content, success: true } } },
    { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", title: content, content: [{ type: "diff", path: "/w/a.md", oldText: content, newText: content }], rawOutput: { content } } } },
    { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: content } } } },
    { jsonrpc: "2.0", id: 3, method: "session/request_permission", params: { sessionId: "s-1", toolCall: { toolCallId: "tc-1", title: content, kind: "edit", rawInput: { path: "/w/a.md", content } }, options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }] } },
    { choices: [{ message: { role: "assistant", content, tool_calls: [{ id: "c-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "/w/a.md", content }) } }] } }] },
    { type: "tool_execution_end", toolCallId: "p-1", toolName: "read", result: { content: [{ type: "text", text: content }] }, isError: false },
    { error: { code: -32000, message: content, data: { stderr: content } } },
    content,
  ];
  const DECISIONS: Array<Record<string, unknown>> = [
    { threadId: "t-sink", requestId: "r-1", tool: "shell", summary: `printf ${content}`, decision: "card-shown", source: "no-grant" },
    { threadId: "t-sink", requestId: "r-1", botId: "b-1", botName: "Ember", tool: "Bash", summary: `cat ${content}`, decision: "user-approved", source: "user", rule: `Bash:cat ${content}` },
    { threadId: "t-sink", requestId: "r-2", tool: "Write", summary: `/w/${content}`, decision: "auto-approved", source: "own-workspace", rule: `Write(${content})`, unattended: true },
    { threadId: "t-sink", tool: "folder-trust", summary: `/w/${content}`, decision: "folder-trusted", source: "full-access" },
    { threadId: "t-sink", requestId: "r-3", summary: content, decision: "card-shown", source: "question" },
  ];

  for (const mode of ["all", "all-but-discriminators", "non-id"] as const) {
    it(`event log, native trace and decision log written with marker mode ${mode} hold no marker`, async () => {
      const root = mkdtempSync(join(tmpdir(), `murage-sink-${mode}-`));
      try {
        const eventsFile = join(root, "events.ndjson");
        const bus = new EventBus(((_file: string, data: string) => { appendFileSync(eventsFile, data); }) as never);
        for (const event of EVENTS) bus.publish(mark(event, mode) as unknown as RuntimeEvent);
        const thread = `t-sink-${mode}`;
        for (const msg of NATIVE) appendNative(thread, { dir: "in", source: "fixture", msg: mark(msg, mode) });
        for (const row of DECISIONS) appendDecision(root, mark(row, mode) as never);
        await flushDecisionLog(root);
        const files = [eventsFile, join(NATIVE_DIR, `${thread}.ndjson`), join(root, "decisions.ndjson")];
        for (const file of files) {
          const text = readFileSync(file, "utf8");
          expect(text.trim().split("\n").length, file).toBeGreaterThan(0);
          for (const marker of [A, B, "7f3a", "7f3b", "file words", "the plan"]) expect(text, `${file} ${marker}`).not.toContain(marker);
        }
        // the structure a bug report needs is still there (unmarked ids and labels)
        if (mode === "non-id") {
          const rows = readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(rows.find((row) => row.requestId === "r-1" && row.type === "request.opened")).toMatchObject({ tool: "Write", summary: "edit", toolInput: JSON.stringify({ file_path: "/w/a.md" }), filePaths: ["/w/a.md"] });
          expect(rows.find((row) => row.type === "item.completed" && row.itemType === "tool")).toMatchObject({ itemId: "i-1", ok: true });
          const native = readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8").trim().split("\n").map((line) => JSON.parse(line).msg);
          expect(native[4].params.item).toEqual({ type: "fileChange", id: "i-1", status: "inProgress", changes: [{ path: "/w/a.md", kind: "update" }] });
          expect(native[1].message.content).toEqual([{ type: "tool_result", tool_use_id: "toolu_1", is_error: false }, { type: "tool_result", tool_use_id: "toolu_2" }]);
          expect(native.at(-1)).toBe(out.NATIVE_TEXT_LABEL);
          const decisions = readFileSync(join(root, "decisions.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(decisions.map((row) => [row.summary, row.rule])).toEqual([["shell", undefined], ["shell", "rule"], ["tool", "rule"], ["folder", undefined], ["question", undefined]]);
        }
      } finally {
        removeTempDirSync(root);
      }
    });
  }

  it("readers: a session line keeps what conversation deletion reads back (engine session handle, instance id)", () => {
    const session = (sessionId: unknown, providerInstanceId = "hermes-profile-work") => loggedRuntimeEvent({ ...env, providerInstanceId, type: "session.started", sessionId, model: "m-1" }) as Record<string, unknown>;
    for (const id of ["0b6f2a8e-6a4c-4c1e-9d55-1f0f6f1c2b3a", "ses_01JABCDEF", "/home/u/.pi/agent/sessions/--w--/2026-11-06_x.jsonl"]) {
      expect(session(id)).toMatchObject({ type: "session.started", sessionId: id, providerInstanceId: "hermes-profile-work", threadId: "t-sink" });
    }
    expect(session(null).sessionId).toBeNull();
    for (const bad of ["$(id)", "a b", "x;y", "a\nb"]) expect(Object.hasOwn(session(bad), "sessionId"), bad).toBe(false);
  });

  // ql2 red fold (logger red fixer): the wire-order readers of the native trace (folder-trust-v2, acp, fuigo) read a JSON-RPC
  // answer's enums and Murage's own driver labels; a result's text, output and content never reach disk.
  it("readers: a native JSON-RPC result keeps its stopReason, outcome and optionId, never its text", () => {
    const S = "confidential plan text 7f3a";
    expect(out.nativeTraceFrame({ jsonrpc: "2.0", id: 4, result: { outcome: { outcome: "selected", optionId: "allow-once" }, _meta: { followup_message: S } } }))
      .toEqual({ jsonrpc: "2.0", id: 4, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
    expect(out.nativeTraceFrame({ jsonrpc: "2.0", id: 5, result: { stopReason: "refusal", usage: { inputTokens: 3 } } }))
      .toEqual({ jsonrpc: "2.0", id: 5, result: { stopReason: "refusal", usage: { inputTokens: 3 } } });
    expect(out.nativeTraceFrame({ jsonrpc: "2.0", id: 6, result: { outcome: "trust" } })).toEqual({ jsonrpc: "2.0", id: 6, result: { outcome: "trust" } });
    for (const frame of [{ id: 7, result: S }, { id: 8, result: { content: [{ type: "text", text: S }], structuredContent: { S } } }, { id: 9, result: { content: S, output: S, text: S } }, { type: "result", subtype: "success", result: S }]) {
      expect(JSON.stringify(out.nativeTraceFrame(frame))).not.toContain(S);
    }
  });

  it("readers: Murage's own native records keep their fixed labels (acpPool, askStop, fuigoInterjection) and their reason", () => {
    expect(out.nativeTraceFrame({ acpPool: "close", reason: "folder-trust-card" })).toEqual({ acpPool: "close", reason: "folder-trust-card" });
    expect(out.nativeTraceFrame({ fuigoInterjection: "ack_timeout", interjectionId: "j-1", ackMs: 50 })).toEqual({ fuigoInterjection: "ack_timeout", interjectionId: "j-1", ackMs: 50 });
    expect(out.nativeTraceFrame({ askStop: "refused", kind: null })).toEqual({ askStop: "refused", kind: null });
    // a label is a label: prose under the same keys is dropped
    expect(out.nativeTraceFrame({ acpPool: "close", reason: "the folder holds a confidential plan" })).toEqual({ acpPool: "close" });
  });

  it("sink: decidedBy is never logged, folderTrustLate keeps its contract values only, toolInputMissing is a field name or a label", () => {
    const resolved = (extra: Record<string, unknown>) => loggedRuntimeEvent({ ...env, type: "request.resolved", requestId: "r-1", behavior: "allow", source: "user", ...extra }) as Record<string, unknown>;
    expect(Object.hasOwn(resolved({ decidedBy: "own-workspace" }), "decidedBy")).toBe(false);
    expect(resolved({ folderTrustLate: "stopped" }).folderTrustLate).toBe("stopped");
    expect(Object.hasOwn(resolved({ folderTrustLate: B }), "folderTrustLate")).toBe(false);
    const ask = (toolInputMissing: unknown) => loggedRuntimeEvent({ ...env, type: "request.opened", requestId: "r-1", requestType: "permission", tool: "Read", summary: "x", toolInputMissing }) as Record<string, unknown>;
    expect(ask("tool_name").toolInputMissing).toBe("tool_name");
    expect(ask(B).toolInputMissing).toBe("field");
    expect(ask("the call's arguments run past what Murage's self-check reads").toolInputMissing).toBe("field");
    expect(Object.hasOwn(ask(undefined), "toolInputMissing")).toBe(false);
  });

  it("sink: a decision row names its bot by id, never by the name the owner typed", async () => {
    const root = mkdtempSync(join(tmpdir(), "murage-sink-botname-"));
    try {
      appendDecision(root, { threadId: "t-1", requestId: "r-1", botId: "b-1", botName: "My private bot", tool: "Read", summary: "/w/a.md", decision: "user-approved", source: "user" });
      await flushDecisionLog(root);
      const text = readFileSync(join(root, "decisions.ndjson"), "utf8");
      expect(text).not.toContain("My private bot");
      expect(readDecisions(root, 10)).toEqual([expect.objectContaining({ threadId: "t-1", requestId: "r-1", botId: "b-1", tool: "Read", summary: "tool", decision: "user-approved", source: "user" })]);
      expect(Object.hasOwn(readDecisions(root, 10)[0]!, "botName")).toBe(false);
    } finally {
      removeTempDirSync(root);
    }
  });

  it("H10 (Astra's rows): a native fileChange and a tool_result frame keep no content", () => {
    const S = "confidential plan text 7f3a";
    expect(JSON.stringify(out.nativeTraceFrame({ method: "item/started", params: { item: { type: "fileChange", id: "i1", changes: [{ path: "/w/a.md", diff: S }] } } }))).not.toContain(S);
    expect(JSON.stringify(out.nativeTraceFrame({ type: "tool_result", tool_use_id: "i1", content: S }))).not.toContain(S);
  });

  it("H11 (Astra's row): a card-shown shell decision row keeps no command", async () => {
    const S = "confidential plan text 7f3a";
    const root = mkdtempSync(join(tmpdir(), "murage-sink-h11-"));
    try {
      appendDecision(root, { threadId: "t1", tool: "shell", summary: `printf ${S}`, decision: "card-shown", source: "no-grant" });
      await flushDecisionLog(root);
      expect(JSON.stringify(readDecisions(root, 10))).not.toContain(S);
      expect(readDecisions(root, 10)[0]).toMatchObject({ threadId: "t1", tool: "shell", summary: "shell", decision: "card-shown", source: "no-grant" });
    } finally {
      removeTempDirSync(root);
    }
  });
});
