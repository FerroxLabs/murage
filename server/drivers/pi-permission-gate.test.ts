// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { PHONE_TOOL_NAMES } from "../../shared/phone-jobs-contract.ts";
import {execFileSync} from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {fileURLToPath} from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OWN_UNASKED } from "../../shared/own-servers.ts";
import { walkRoot } from "../../shared/in-project.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import piPermissionGate, {
  DEFAULT_HOOKS,
  GATE_UNASKED,
  MCP_TABLE_KEY,
  PI_FILTER_STALE,
  PI_FILTER_WITHHELD,
  PI_GATE_MESSAGE_MAX,
  PI_GATE_TITLE_PREFIX,
  PI_GATE_UNCHECKED,
  PI_GATE_UNIDENTIFIED,
  filterSelfCheck,
  visibleDeleteTarget,
  filterToolResult,
  piGateMessage,
  type FilterHooks,
  type McpToolEntry,
} from "./pi-permission-gate.ts";

import {wipeBreaker,nativeWipeBreaker} from '../wipe-breaker.ts';
import {RootRegistry} from '../wipe/registry.ts';
import {wipeBreaker as carriedWipeBreaker, RootRegistry as CarriedRootRegistry} from './pi-wipe-check.generated.mjs';

const SECRET = "s3cret";
type Handler = (event: any, ctx: any) => any;
const here = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

let root = "";
let project = "";
let outside = "";
const holder = globalThis as Record<string, unknown>;

// Owners: shared inventory producer and staged consumer fixtures — pi-roots-b.
function writeInventory(file: string, context: object, roots: readonly string[] = []) {
  const inventoryPath = file + '.roots';
  writeFileSync(inventoryPath, 'MURAGE-PI-ROOTS 1 R 00000000-0000-4000-8000-000000000001\n' + JSON.stringify(roots));
  writeFileSync(file, JSON.stringify({context, inventoryPath}));
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-gate-")));
  project = join(root, "project");
  outside = join(root, "outside");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(outside, ".ssh"), { recursive: true });
  writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(project, "README.md"), "hello\n");
  writeFileSync(join(outside, ".ssh", "id_rsa"), "KEY\n");
  writeFileSync(join(outside, "plain.txt"), "plain\n");
  holder[MCP_TABLE_KEY] = new Map<string, McpToolEntry>();
  writeInventory(join(root, 'default-context'), {});
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE = join(root, 'default-context');
});
afterEach(() => {
  removeTempDirSync(root);
  delete holder[MCP_TABLE_KEY];
  delete process.env.MURAGE_PI_GATE;
  delete process.env.MURAGE_PI_GATE_MODE;
  delete process.env.MURAGE_PI_GATE_ONLY;
  delete process.env.MURAGE_PI_WIPE_CONTEXT_FILE;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("murage.piGate")];
});

interface Rig {
  call(event: Record<string, unknown>, ctxOver?: Record<string, unknown>): Promise<any>;
  result(event: Record<string, unknown>): any;
  fire(name: string): void;
  asked: { title: string; prefill: string }[];
  answer: { next: (prefill: string) => string | undefined | Promise<string | undefined> };
  on: Map<string, Handler>;
}

function rig(options: { hooks?: FilterHooks; onThrows?: string; only?: string; now?: () => number; mode?: "open" | "bound" | null } = {}): Rig {
  process.env.MURAGE_PI_GATE = SECRET;
  // These controls model native non-consuming Pi with legacy editor replies.
  // Missing-mode and bound controls below retain the closed default.
  if (options.mode === null) delete process.env.MURAGE_PI_GATE_MODE;
  else process.env.MURAGE_PI_GATE_MODE = options.mode ?? "open";
  if (options.only) process.env.MURAGE_PI_GATE_ONLY = options.only;
  const on = new Map<string, Handler>();
  const api = {
    on(name: string, handler: Handler) {
      if (name === options.onThrows) throw new Error("no such event");
      on.set(name, handler);
    },
  };
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
  piPermissionGate(api as never, { hooks: options.hooks, now: options.now });
  const asked: { title: string; prefill: string }[] = [];
  const answer: Rig["answer"] = { next: () => JSON.stringify({ deny: true, reason: "no" }) };
  const ctx = (over: Record<string, unknown> = {}) => ({
    cwd: project,
    hasUI: true,
    ui: { editor: async (title: string, prefill: string) => { asked.push({ title, prefill }); return answer.next(prefill); } },
    ...over,
  });
  return {
    call: (event, over) => on.get("tool_call")!({ toolCallId: "c1", ...event }, ctx(over)),
    result: (event) => on.get("tool_result")!(event, { cwd: project }),
    fire: (name) => on.get(name)?.({}, {}),
    asked,
    answer,
    on,
  };
}

const allowAs = (input: Record<string, unknown>) => JSON.stringify({ allow: true, input });

describe("Rule 14: three trusted sets, nothing else", () => {
  it("T13: a tool in neither set is blocked, never asked, never run", async () => {
    const gate = rig();
    const out = await gate.call({ toolName: "mystery_tool", input: {} });
    expect(out).toEqual({ block: true, reason: PI_GATE_UNIDENTIFIED });
    expect(gate.asked).toHaveLength(0);
  });

  it("the whole body is one try: a throwing editor or a throwing input getter RETURNS a block", async () => {
    const gate = rig();
    const boom = await gate.call({ toolName: "bash", input: { command: "ls" } }, { ui: { editor: async () => { throw new Error("x"); } } });
    expect(boom).toEqual({ block: true, reason: PI_GATE_UNCHECKED });
    const event = { toolName: "bash", get input(): never { throw new Error("getter"); } };
    await expect(gate.on.get("tool_call")!(event, { cwd: project, hasUI: true, ui: {} })).resolves.toEqual({ block: true, reason: PI_GATE_UNCHECKED });
  });

  it("T12/T37: a table tool asks with {tool, mount, mcpTool, input}; the mount comes from the table, never from the piName", async () => {
    (holder[MCP_TABLE_KEY] as Map<string, McpToolEntry>).set("a_b_c_2", { piName: "a_b_c_2", mount: "a", mcpTool: "b_c", mountId: "custom:a" });
    const gate = rig();
    gate.answer.next = () => allowAs({ q: 1 });
    const event = { toolName: "a_b_c_2", input: { q: 1 } };
    expect(await gate.call(event)).toBeUndefined();
    expect(gate.asked[0]!.title).toBe(`${PI_GATE_TITLE_PREFIX}${SECRET}`);
    expect(JSON.parse(gate.asked[0]!.prefill)).toEqual({ tool: "a_b_c_2", mount: "a", mcpTool: "b_c", input: { q: 1 } });
  });

  it("T59: an own tool runs unasked only for an exact (mountId, tool) pair; every other tool of the mount asks", async () => {
    const table = holder[MCP_TABLE_KEY] as Map<string, McpToolEntry>;
    table.set("murage_memory_memory_search", { piName: "murage_memory_memory_search", mount: "murage-memory", mcpTool: "memory_search", mountId: "own:memory" });
    table.set("murage_memory_other", { piName: "murage_memory_other", mount: "murage-memory", mcpTool: "other", mountId: "own:memory" });
    table.set("custom_memory_search", { piName: "custom_memory_search", mount: "custom", mcpTool: "memory_search", mountId: "custom:custom" });
    table.set("nomount_memory_search", { piName: "nomount_memory_search", mount: "x", mcpTool: "memory_search" });
    const gate = rig();
    expect(await gate.call({ toolName: "murage_memory_memory_search", input: {} })).toBeUndefined();
    expect(gate.asked).toHaveLength(0);
    for (const name of ["murage_memory_other", "custom_memory_search", "nomount_memory_search"]) await gate.call({ toolName: name, input: {} });
    expect(gate.asked).toHaveLength(3);
    expect(GATE_UNASKED.flatMap(([mount, tools]) => tools.map((tool) => `${mount}/${tool}`)).sort())
      .toEqual(OWN_UNASKED.flatMap((row) => row.tools.map((tool) => `${row.mount}/${tool}`)).filter((v, i, all) => all.indexOf(v) === i).sort());
  });

  it("S13b: every phone tool of the phoneJobs mount runs unasked on Pi (no desktop card)", async () => {
    const table = holder[MCP_TABLE_KEY] as Map<string, McpToolEntry>;
    for (const tool of PHONE_TOOL_NAMES) table.set(`phoneJobs_${tool}`, { piName: `phoneJobs_${tool}`, mount: "phoneJobs", mcpTool: tool, mountId: "own:phoneJobs" });
    table.set("custom_phone_calendar_read", { piName: "custom_phone_calendar_read", mount: "custom", mcpTool: "phone_calendar_read", mountId: "custom:custom" });
    const gate = rig();
    for (const tool of PHONE_TOOL_NAMES) expect(await gate.call({ toolName: `phoneJobs_${tool}`, input: {} })).toBeUndefined();
    expect(gate.asked).toHaveLength(0);
    await gate.call({ toolName: "custom_phone_calendar_read", input: {} });
    expect(gate.asked).toHaveLength(1);
  });

  it("the proposal-only turn runs only its one tool and asks for everything else, reads included", async () => {
    (holder[MCP_TABLE_KEY] as Map<string, McpToolEntry>).set("agents_project_propose", { piName: "agents_project_propose", mount: "agents", mcpTool: "project_propose", mountId: "own:agents" });
    const gate = rig({ only: "agents_project_propose" });
    expect(await gate.call({ toolName: "agents_project_propose", input: {} })).toBeUndefined();
    await gate.call({ toolName: "read", input: { path: "README.md" } });
    expect(gate.asked).toHaveLength(1);
  });

  it("venue_read_messages is unasked only on Murage's own agents mount", async () => {
    const table = holder[MCP_TABLE_KEY] as Map<string, McpToolEntry>;
    table.set("agents_venue_read_messages", { piName: "agents_venue_read_messages", mount: "agents", mcpTool: "venue_read_messages", mountId: "own:agents" });
    table.set("custom_venue_read_messages", { piName: "custom_venue_read_messages", mount: "custom", mcpTool: "venue_read_messages", mountId: "custom:custom" });
    expect(OWN_UNASKED.some(row => row.mount === "own:agents" && row.tools.includes("venue_read_messages"))).toBe(true);
    const gate = rig();
    expect(await gate.call({ toolName: "agents_venue_read_messages", input: { venue_id: "venue" } })).toBeUndefined();
    expect(gate.asked).toHaveLength(0);
    await gate.call({ toolName: "custom_venue_read_messages", input: { venue_id: "venue" } });
    expect(gate.asked).toHaveLength(1);
  });

  it("removes the secret from the environment, so the commands pi runs never inherit it", () => {
    rig();
    expect(process.env.MURAGE_PI_GATE).toBeUndefined();
    expect(process.env.MURAGE_PI_GATE_ONLY).toBeUndefined();
  });

  // Real pi 1.3.0 in RPC mode runs every extension's factory again on `new_session`, in the same process and with the
  // handlers of the first load dropped; the driver sends `new_session` before every prompt. Seen on the real CLI
  // (test-server probe, 2026-10-21): `{"type":"new_session"}` then a bash call ran with no `extension_ui_request` at all,
  // while the same pi without `new_session` asked with method "editor" and title "murage-gate:<secret>". The second
  // load found the secret already removed from the environment and registered nothing: Ask let bash and the host
  // computer run with no card (real-engine gate, pi C1 and A1).
  it("a second load in the same process (pi's new_session) still asks, with the first load's secret and proposal tool", async () => {
    (holder[MCP_TABLE_KEY] as Map<string, McpToolEntry>).set("agents_project_propose", { piName: "agents_project_propose", mount: "agents", mcpTool: "project_propose", mountId: "own:agents" });
    rig({ only: "agents_project_propose" });
    expect(process.env.MURAGE_PI_GATE).toBeUndefined();
    const reloaded = new Map<string, Handler>();
    process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
    piPermissionGate({ on: (name: string, handler: Handler) => reloaded.set(name, handler) } as never);
    const asked: string[] = [];
    const ctx = { cwd: project, hasUI: true, ui: { editor: async (title: string) => { asked.push(title); return JSON.stringify({ deny: true, reason: "no" }); } } };
    expect(await reloaded.get("tool_call")!({ toolCallId: "c2", toolName: "bash", input: { command: "echo hi" } }, ctx)).toEqual({ block: true, reason: "no" });
    expect(asked).toEqual([`${PI_GATE_TITLE_PREFIX}${SECRET}`]);
    expect(await reloaded.get("tool_call")!({ toolCallId: "c3", toolName: "agents_project_propose", input: {} }, ctx)).toBeUndefined();
  });

  it("loaded with no secret at all, every tool call is blocked, never run unasked", async () => {
    delete process.env.MURAGE_PI_GATE;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("murage.piGate")];
    const on = new Map<string, Handler>();
    process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
    piPermissionGate({ on: (name: string, handler: Handler) => on.set(name, handler) } as never);
    const ctx = { cwd: project, hasUI: true, ui: { editor: async () => JSON.stringify({ allow: true, input: { command: "ls" } }) } };
    expect(await on.get("tool_call")!({ toolCallId: "c1", toolName: "bash", input: { command: "ls" } }, ctx)).toEqual({ block: true, reason: PI_GATE_UNCHECKED });
    expect(await on.get("tool_call")!({ toolCallId: "c2", toolName: "read", input: { path: "README.md" } }, ctx)).toEqual({ block: true, reason: PI_GATE_UNCHECKED });
  });
});

describe("Rules 13, 15, 73d: the editor ask", () => {
  it("sends the whole input of edit and write, content included", async () => {
    const gate = rig();
    await gate.call({ toolName: "write", input: { path: "/etc/x", content: "BODY" } });
    await gate.call({ toolName: "edit", input: { path: "/etc/y", oldText: "o", newText: "n", edits: [{ oldText: "o", newText: "n" }] } });
    expect(JSON.parse(gate.asked[0]!.prefill)).toEqual({ tool: "write", input: { path: "/etc/x", content: "BODY" } });
    expect(JSON.parse(gate.asked[1]!.prefill).input).toMatchObject({ oldText: "o", newText: "n" });
  });

  it("a call larger than the cap goes as {tool, truncated: true}", () => {
    const big = JSON.parse(piGateMessage("bash", { command: "x".repeat(PI_GATE_MESSAGE_MAX + 1) }));
    expect(big).toEqual({ tool: "bash", truncated: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(JSON.parse(piGateMessage("bash", circular))).toEqual({ tool: "bash", truncated: true });
  });

  it("in-project content over the cap cannot be read whole: the write asks", async () => {
    const gate = rig();
    await gate.call({ toolName: "write", input: { path: "src/big.ts", content: "x".repeat(PI_GATE_MESSAGE_MAX + 1) } });
    expect(gate.asked).toHaveLength(1);
    expect(JSON.parse(gate.asked[0]!.prefill)).toMatchObject({ tool: "write", truncated: true });
  });

  it.each([
    ["over the cap", { command: "x".repeat(PI_GATE_MESSAGE_MAX + 1) }],
    ["a missing required field", {}],
  ])("S4: keep runs the held call unchanged on %s", async (_name, input) => {
    const gate = rig();
    const event: any = { toolName: "bash", input };
    const before = JSON.stringify(input);
    gate.answer.next = () => JSON.stringify({ allow: true, keep: true });
    expect(await gate.call(event)).toBeUndefined();
    expect(gate.asked).toHaveLength(1);
    expect(JSON.stringify(event.input)).toBe(before);
  });

  it("S4: keep needs Allow, and a deny stays a deny whatever else it says", async () => {
    const gate = rig();
    gate.answer.next = () => JSON.stringify({ keep: true });
    expect((await gate.call({ toolName: "bash", input: { command: "ls" } }))?.block).toBe(true);
    gate.answer.next = () => JSON.stringify({ deny: true, keep: true, allow: true, reason: "no" });
    expect(await gate.call({ toolName: "bash", input: { command: "ls" } })).toEqual({ block: true, reason: "no" });
    gate.answer.next = () => JSON.stringify({ allow: "true", keep: true });
    expect((await gate.call({ toolName: "bash", input: { command: "ls" } }))?.block).toBe(true);
  });

  it("S4: keep drops the read of the old call, so the next call is walked fresh", async () => {
    const gate = rig();
    gate.answer.next = () => JSON.stringify({ allow: true, keep: true });
    expect(await gate.call({ toolName: "bash", input: { command: "rm a" } })).toBeUndefined();
    gate.answer.next = () => JSON.stringify({ deny: true, reason: "no" });
    expect((await gate.call({ toolName: "bash", input: { command: "rm a" } }))?.block).toBe(true);
    expect(gate.asked).toHaveLength(2);
  });

  it("allow mutates event.input in place with the row's keys only; any other answer blocks", async () => {
    const gate = rig();
    const event: any = { toolName: "bash", input: { command: "ls" } };
    gate.answer.next = () => allowAs({ command: "ls -la" });
    expect(await gate.call(event)).toBeUndefined();
    expect(event.input.command).toBe("ls -la");
    for (const bad of [allowAs({ command: "x", extra: 1 }), allowAs({}), JSON.stringify({ allow: true }), "not json", "", undefined, JSON.stringify([1])]) {
      gate.answer.next = () => bad as string | undefined;
      const out = await gate.call({ toolName: "bash", input: { command: "ls" } });
      expect(out?.block).toBe(true);
    }
  });

  it("a deny carries the verdict's reason (a narrowing denial reaches the model as its reason)", async () => {
    const gate = rig();
    gate.answer.next = () => JSON.stringify({ deny: true, reason: "this would read .env; exclude it" });
    expect(await gate.call({ toolName: "bash", input: { command: "cat .env" } })).toEqual({ block: true, reason: "this would read .env; exclude it" });
  });

  it("no UI: the call is blocked, not run", async () => {
    const gate = rig();
    const out = await gate.call({ toolName: "bash", input: { command: "ls" } }, { hasUI: false });
    expect(out?.block).toBe(true);
  });
});

describe("Rules 60 and 63: reads and searches", () => {
  it("T77: read inside the project and not sensitive runs unasked; sensitive, outside and unplaceable ask with full input", async () => {
    const gate = rig();
    expect(await gate.call({ toolName: "read", input: { path: "README.md" } })).toBeUndefined();
    expect(await gate.call({ toolName: "read", input: { path: "src/a.ts", offset: 1 } })).toBeUndefined();
    expect(gate.asked).toHaveLength(0);
    writeFileSync(join(project, ".env"), "K=1\n");
    symlinkSync(join(outside, ".ssh", "id_rsa"), join(project, "link.txt"));
    for (const path of [".env", join(outside, "plain.txt"), "link.txt", "a\u0000b"]) await gate.call({ toolName: "read", input: { path } });
    expect(gate.asked).toHaveLength(4);
    expect(JSON.parse(gate.asked[0]!.prefill)).toEqual({ tool: "read", input: { path: ".env" }, sensitive: "env" });
  });

  it("1.0.4 09-1: a link to a key file asks with the gate's own verdict, so no mode answers it as an ordinary read", async () => {
    symlinkSync(join(outside, ".ssh", "id_rsa"), join(project, "config-link"));
    const gate = rig();
    await gate.call({ toolName: "read", input: { path: "config-link" } });
    await gate.call({ toolName: "read", input: { path: join(outside, "plain.txt") } });
    expect(JSON.parse(gate.asked[0]!.prefill)).toEqual({ tool: "read", input: { path: "config-link" }, sensitive: "ssh" });
    // outside the project is not a key file: no verdict rides along
    expect(JSON.parse(gate.asked[1]!.prefill)).toEqual({ tool: "read", input: { path: join(outside, "plain.txt") } });
  });

  it("T86: link/../x climbs from the link's target and is outside", async () => {
    symlinkSync(join(outside, ".ssh"), join(project, "lnk"));
    const gate = rig();
    await gate.call({ toolName: "read", input: { path: "lnk/../plain.txt" } });
    expect(gate.asked).toHaveLength(1);
  });

  it("a missing contract field is asked (the driver files it unread)", async () => {
    const gate = rig();
    await gate.call({ toolName: "grep", input: {} });
    await gate.call({ toolName: "read", input: {} });
    expect(gate.asked).toHaveLength(2);
    expect(JSON.parse(gate.asked[0]!.prefill).input).toEqual({});
  });

  // Astra BLOCK 6 (Rules 55, 63.1): an edit with only a path, or a write with no content, is never a quiet run
  it("an in-project edit or write missing a required field asks", async () => {
    const gate = rig();
    await gate.call({ toolName: "edit", input: { path: "src/a.ts" } });
    await gate.call({ toolName: "edit", input: { path: "src/a.ts", edits: [] } });
    await gate.call({ toolName: "edit", input: { path: "src/a.ts", edits: [{ oldText: "a" }] } });
    await gate.call({ toolName: "edit", input: { path: "src/a.ts", oldText: "a" } });
    await gate.call({ toolName: "write", input: { path: "src/a.ts" } });
    expect(gate.asked).toHaveLength(5);
    expect(await gate.call({ toolName: "edit", input: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] } })).toBeUndefined();
  });

  it("a template file's body is read by the verdict, so the write asks", async () => {
    const gate = rig();
    await gate.call({ toolName: "write", input: { path: ".env.example", content: "A=1" } });
    expect(gate.asked).toHaveLength(1);
    expect(await gate.call({ toolName: "write", input: { path: "src/b.ts", content: "ok" } })).toBeUndefined();
  });

  it("a search over a clean root runs unasked and is recorded in the pending table", async () => {
    const gate = rig();
    expect(await gate.call({ toolName: "grep", input: { pattern: "a", path: "src" } })).toBeUndefined();
    expect(await gate.call({ toolName: "ls", input: {} })).toBeUndefined();
    expect(gate.asked).toHaveLength(0);
  });
});

describe("T92: the tool_result filter", () => {
  const text = (value: string) => ({ toolName: "grep", input: { pattern: "K" }, content: [{ type: "text", text: value }] });

  it("withholds the .env and linked key entries of a grep, find and ls result and says how many", () => {
    writeFileSync(join(project, ".env"), "K=1\n");
    symlinkSync(join(outside, ".ssh", "id_rsa"), join(project, "key.txt"));
    const gate = rig();
    const out = gate.result(text(".env:1: K=1\nsrc/a.ts:1: K here\nkey.txt:1: KEY\n[100 matches limit reached. Use limit=200 for more]"));
    expect(out.content[0].text).toBe("src/a.ts:1: K here\n[100 matches limit reached. Use limit=200 for more]\n[2 entries withheld: sensitive files]");
    expect(out.structuredContent).toBe(out.content[0].text);
    const found = gate.result({ toolName: "find", input: { pattern: "*" }, content: [{ type: "text", text: ".env\nsrc/a.ts\nREADME.md" }] });
    expect(found.content[0].text).toBe("src/a.ts\nREADME.md\n[1 entries withheld: sensitive files]");
    const listed = gate.result({ toolName: "ls", input: {}, content: [{ type: "text", text: ".env\nREADME.md\nsrc/" }] });
    expect(listed.content[0].text).toContain("[1 entries withheld: sensitive files]");
    expect(listed.content[0].text).not.toContain(".env\n");
  });

  it("leaves a clean result and the known empty results untouched", () => {
    const gate = rig();
    expect(gate.result(text("src/a.ts:1: x\nsrc/a.ts-2- y\n--\nREADME.md:1: z"))).toBeUndefined();
    for (const empty of ["No matches found", "No files found matching pattern", "(empty directory)"]) expect(gate.result(text(empty))).toBeUndefined();
    expect(gate.result({ toolName: "read", input: { path: "README.md" }, content: [{ type: "text", text: "hello" }] })).toBeUndefined();
  });

  it("a path holding -3- is still read as a path", () => {
    mkdirSync(join(project, "a-1-b"));
    writeFileSync(join(project, "a-1-b", ".env"), "K\n");
    const out = rig().result(text("a-1-b/.env:3: K"));
    expect(out.content[0].text).toBe("[1 entries withheld: sensitive files]");
  });

  it("an unparsable result, or a non-text part, is replaced whole", () => {
    const gate = rig();
    expect(gate.result(text("garbage without any path shape")).content[0].text).toBe("[1 entries withheld: sensitive files]");
    expect(gate.result({ toolName: "grep", input: {}, content: [{ type: "image", data: "x" }] }).content[0].text).toBe(PI_FILTER_WITHHELD);
  });
});

describe("T105: the filter fails closed on its own", () => {
  const fixture = { toolName: "find", input: {}, content: [{ type: "text", text: "src/a.ts" }] };
  const faults: [string, Partial<FilterHooks>][] = [
    ["a parser that throws", { line: () => { throw new Error("parse"); } }],
    ["a placement that throws", { place: () => { throw new Error("place"); } }],
  ];
  for (const [label, fault] of faults) {
    it(`returns the whole-result replacement for ${label}`, () => {
      const out = filterToolResult(fixture, project, { ...DEFAULT_HOOKS, ...fault });
      expect(out).toEqual({ content: [{ type: "text", text: PI_FILTER_WITHHELD }], structuredContent: PI_FILTER_WITHHELD, isError: true, details: {} });
    });
  }

  it("reproduces the runner: a throwing handler leaves the result intact, so the filter must never throw", () => {
    const runner = (handler: Handler, event: any) => { try { return handler(event, {}) ?? event; } catch { return event; } };
    expect(runner(() => { throw new Error("x"); }, fixture)).toBe(fixture);
    const faulty: FilterHooks = { ...DEFAULT_HOOKS, line: () => { throw new Error("x"); } };
    const handler: Handler = (event) => filterToolResult(event, project, faulty);
    expect(runner(handler, fixture)).not.toBe(fixture);
    expect(runner(handler, fixture).isError).toBe(true);
  });

  it("the load-time self-check passes on the real hooks and fails on a filter that keeps everything", () => {
    expect(filterSelfCheck()).toBe(true);
    expect(filterSelfCheck({ ...DEFAULT_HOOKS, line: () => "keep" })).toBe(false);
  });

  it("a stale pending search entry is reported on the next ask AND clears filterTrusted", async () => {
    writeFileSync(join(project, ".env"), "K=1\n");
    const gate = rig();
    expect(await gate.call({ toolCallId: "g1", toolName: "grep", input: { pattern: "K" } })).toBeUndefined();
    gate.fire("agent_end");
    const out = await gate.call({ toolName: "grep", input: { pattern: "K" } });
    expect(out.block).toBe(true);
    expect(gate.asked).toHaveLength(0);
    await gate.call({ toolName: "bash", input: { command: "ls" } });
    expect(JSON.parse(gate.asked[0]!.prefill).note).toBe(PI_FILTER_STALE);
  });

  it("a result that arrives clears its pending entry (no stale report)", async () => {
    const gate = rig();
    await gate.call({ toolCallId: "g2", toolName: "ls", input: {} });
    gate.result({ toolCallId: "g2", toolName: "ls", input: {}, content: [{ type: "text", text: "README.md" }] });
    gate.fire("turn_end");
    await gate.call({ toolName: "bash", input: { command: "ls" } });
    expect(JSON.parse(gate.asked[0]!.prefill).note).toBeUndefined();
  });

  it("an entry older than the stale bound is found by the next tool_call", async () => {
    let clock = 0;
    const gate = rig({ now: () => clock });
    await gate.call({ toolCallId: "old", toolName: "read", input: { path: "README.md" } });
    clock = 10 * 60_000;
    await gate.call({ toolName: "bash", input: { command: "ls" } });
    await gate.call({ toolName: "bash", input: { command: "ls" } });
    expect(JSON.parse(gate.asked[0]!.prefill).note).toBe(PI_FILTER_STALE);
  });

  describe("with filterTrusted false the tool_call walks the root", () => {
    it("blocks a root holding .env with a narrowing reason: never asked, never run", async () => {
      writeFileSync(join(project, ".env"), "K=1\n");
      const gate = rig({ onThrows: "tool_result" });
      const out = await gate.call({ toolName: "grep", input: { pattern: "K" } });
      expect(out.block).toBe(true);
      expect(out.reason).toContain(".env");
      expect(gate.asked).toHaveLength(0);
    });

    it("blocks a walk that stopped at the bound, naming the unwalked subtrees", async () => {
      for (let i = 0; i < 20; i++) writeFileSync(join(project, "src", `f${i}.ts`), "x");
      const hooks: FilterHooks = { ...DEFAULT_HOOKS, walk: (r, p) => walkRoot(r, p, { maxEntries: 5 }) };
      const gate = rig({ onThrows: "tool_result", hooks });
      const out = await gate.call({ toolName: "find", input: { pattern: "*" } });
      expect(out.block).toBe(true);
      expect(out.reason).toContain("exclude node_modules");
      expect(gate.asked).toHaveLength(0);
    });

    it("blocks an unreadable root and a walk that throws; runs on a clean finished walk; a named file still asks", async () => {
      const throwing = rig({ onThrows: "tool_result", hooks: { ...DEFAULT_HOOKS, walk: () => { throw new Error("walk"); } } });
      expect((await throwing.call({ toolName: "ls", input: {} })).reason).toBe(PI_GATE_UNCHECKED);
      const clean = rig({ onThrows: "tool_result" });
      expect(await clean.call({ toolName: "grep", input: { pattern: "a", path: "src" } })).toBeUndefined();
      expect(await clean.call({ toolName: "grep", input: { pattern: "a", path: "README.md" } })).toBeUndefined();
      await clean.call({ toolName: "read", input: { path: join(outside, "plain.txt") } });
      expect(clean.asked).toHaveLength(1);
    });

    it("an engine whose self-check fails is untrusted from the start", async () => {
      writeFileSync(join(project, ".env"), "K=1\n");
      const gate = rig({ hooks: { ...DEFAULT_HOOKS, line: () => "keep" } });
      expect((await gate.call({ toolName: "grep", input: { pattern: "K" } })).block).toBe(true);
    });
  });
});

// Astra BLOCK 8 (Rule 60): a bracketed grep line is parsed, never kept on its shape
describe("Rule 60: bracketed grep lines", () => {
  it("judges a bracketed line by its path, keeps Pi's notices, and drops any other bracketed line", () => {
    const gate = rig();
    writeFileSync(join(project, ".env"), "K=1\n");
    const out = gate.result({ toolName: "grep", input: { pattern: "K" }, content: [{ type: "text", text: "[x/.env:1: SECRET]\n[.env:1: K=1]\nsrc/a.ts:1: K here\n[100 matches limit reached. Use limit=200 for more]\n[made up: anything]" }] });
    const textOut = out.content[0].text as string;
    expect(textOut).not.toContain("SECRET");
    expect(textOut).not.toContain("K=1");
    expect(textOut).not.toContain("made up");
    expect(textOut).toContain("src/a.ts:1: K here");
    expect(textOut).toContain("[100 matches limit reached. Use limit=200 for more]");
  });
});

describe("T105: the inlined copies equal their modules", () => {
  const gate = here("./pi-permission-gate.ts");
  const strip = (src: string) => {
    const lines = src.split("\n");
    let i = 0;
    while (i < lines.length && (lines[i]!.startsWith("//") || lines[i]!.trim() === "")) i++;
    return lines.slice(i).filter((line) => !/^import .* from ".*";$/.test(line)).map((line) => line.replace(/^export /, "")).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  };
  const block = (file: string) => {
    const begin = `// @inline begin ${file}\n`;
    const from = gate.indexOf(begin);
    const to = gate.indexOf(`\n// @inline end ${file}`);
    expect(from).toBeGreaterThan(-1);
    return gate.slice(from + begin.length, to);
  };
  it("shared/sensitive-paths.ts and shared/in-project.ts are carried whole", () => {
    // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: wipe source is pinned by the generated-copy equality below.
    for (const file of ["shared/sensitive-paths.ts", "shared/in-project.ts"]) expect(block(file)).toBe(strip(here(`../../${file}`)));
  });
  it("the scan limits the gate uses are the same lines", () => {
    const source = here("../../shared/scan-limits.ts");
    const inline = block("shared/scan-limits.ts");
    for (const name of ["GATE_MESSAGE_BYTES", "WALK_CACHE_MS", "WALK_ENTRIES", "WALK_MS"]) {
      const line = source.match(new RegExp(`^export (const ${name} = .*;)$`, "m"))![1]!;
      expect(inline).toContain(line);
    }
  });
  it("the staged wipe checker equals the approved source bundle", () => {
    // Run the real generator outside Vitest's module transforms, with the same
    // Node loader used to regenerate the shipped artifact.
    const generated = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module'], {
      input: `import {generatePiWipeCheck} from ${JSON.stringify(new URL('../../scripts/generate-pi-wipe-check.ts', import.meta.url).href)};
        process.stdout.write(await generatePiWipeCheck());`,
      encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    expect(here('./pi-wipe-check.generated.mjs')).toBe(generated);
  });
  it("the shipped checker cards a session-written script spelled in another Unicode form after the candidate folders overflowed", () => {
    // Astra n4:8471 (script-bodies.ts): a macOS volume reads a composed and a decomposed accent as one file. Owner checker: q1024-intdev; shipped Pi copy: pi-wipe-seam-b.
    const pathPort = {realpath: (path: string) => path, isBlockDevice: () => false};
    const context = {home: '/home/fixture', cwd: '/work/other', project: '/work/other', dataDir: '/state/app', platform: 'linux' as const,
      pathPort, mountInventory: {contains: () => false}, sessionEdits: new Set(['/work/other/caf\u00e9.sh'])};
    const overflow = Array.from({length: 33}, (_, i) => `cd /e${i}`).join(' ; ');
    for (const check of [wipeBreaker, carriedWipeBreaker]) {
      expect(check(`${overflow} ; bash cafe\u0301.sh`, context)?.rule).toBe('wipe-check-fault');
      expect(check(`${overflow} ; bash notwritten.sh`, context)).toBeNull();
    }
  });
  it("the shipped checker fails closed on protected glob overflow and recovers below the bound", () => {
    // MAIN RULING 1115-C4D2-GROK H2: saturated inventories fail closed, including unmatched globs.
    // Owner checker: wipe-v3; owner shipped Pi consumer regression: t6-pi-wipe.
    const pathPort = {realpath: (path: string) => path, isBlockDevice: () => false};
    const context = {home: '/home/fixture', cwd: '/work/other', project: '/work/other',
      dataDir: '/state/app', platform: 'linux' as const, pathPort, mountInventory: {contains: () => false}};
    for (const CheckerRegistry of [RootRegistry, CarriedRootRegistry]) {
      const registry = new CheckerRegistry(pathPort);
      for (let i = 0; i < 257; i++) registry.replace(`bot:fixture-${i}:cwd`, [`/projects/unrelated-${i}`]);
      for (const check of [wipeBreaker, carriedWipeBreaker]) {
        expect(check('rm -rf /projects/target*', {...context, registry})?.rule).toBe('wipe-check-fault');
        const bounded = {contains: (path: string) => registry.contains(path),
          protectedChildren: (dir: string) => registry.protectedChildren(dir)};
        expect(check('rm -rf /projects/target*', {...context, registry: bounded})?.rule).toBe('wipe-check-fault');
      }
      registry.drop('bot:fixture-256:cwd');
      for (const check of [wipeBreaker, carriedWipeBreaker]) {
        expect(check('rm -rf /projects/target*', {...context, registry})).toBeNull();
        expect(check('rm -rf /projects/unrelated-25[5]', {...context, registry})).toBeTruthy();
      }
    }
  });
  it("the packaged extension loads its checker with only staged siblings and Node built-ins", () => {
    const output=join(root,'staged');
    const script=`
      import {stagePiWindowsHide} from ${JSON.stringify(new URL('../../scripts/stage-pi-windows-hide.mjs',import.meta.url).href)};
      import {readFileSync} from 'node:fs';
      import {pathToFileURL} from 'node:url';
      import assert from 'node:assert/strict';
      stagePiWindowsHide(${JSON.stringify(fileURLToPath(new URL('../../',import.meta.url)))},${JSON.stringify(output)});
      assert.equal(readFileSync(${JSON.stringify(join(output,'drivers/pi-wipe-check.generated.mjs'))},'utf8'),readFileSync(${JSON.stringify(fileURLToPath(new URL('./pi-wipe-check.generated.mjs',import.meta.url)))},'utf8'));
      process.chdir(${JSON.stringify(output)});
      const {default:gate}=await import(pathToFileURL(${JSON.stringify(join(output,'drivers/pi-permission-gate.ts'))}).href);
      const handlers=new Map();process.env.MURAGE_PI_NO_LIMITS='1';delete process.env.MURAGE_PI_GATE;
      process.env.MURAGE_PI_WIPE_CONTEXT_FILE=${JSON.stringify(join(root,'default-context'))};
      gate({on:(name,handler)=>handlers.set(name,handler)});
      for(const [command,wipe] of [
        ['pwsh -Command Remove-Item -Recurse -Force "$HOME/*"',true],
        [\`cmd /c 'rd /s /q "%USERPROFILE%/*"'\`,true],
        ['printf "rm -rf ~/*"',false],['mkfs --help',false],
      ])assert.equal((await handlers.get('tool_call')({toolName:'bash',input:{command}},{cwd:${JSON.stringify(project)},hasUI:false,ui:{}}))?.block===true,wipe);
      console.log('staged-extension: Windows home wipes card; printed examples and help run');
    `;
    const result=execFileSync(process.execPath,['--experimental-strip-types','--input-type=module'],{
      input:script,encoding:'utf8',timeout:30_000,
      env:{...process.env,HOME:root,USERPROFILE:root,MURAGE_PI_GATE:'',MURAGE_PI_NO_LIMITS:'1'},
    });
    expect(result).toContain('staged-extension: Windows home wipes card; printed examples and help run');
  });
  it.each(['registered roots', 'engine environment'])("review context: staged gate preserves %s", finding => {
    const registered = join(outside, 'registered');
    const build = join(registered, 'pkg', 'build');
    mkdirSync(build, {recursive:true});
    const alias = join(outside, 'registered-alias');
    symlinkSync(registered, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const registry = new RootRegistry();
    registry.replace('bot:fixture:cwd', [registered, alias]);
    const context = {home:root,project, dataDir:join(root,'.murage'),platform:process.platform};
    const inventory = join(root, 'wipe-context.json');
    writeInventory(inventory, context, registry.snapshot());
    const env = {...process.env, HOME:root, USERPROFILE:root, BUILD_DIR:build, WIPE_DIR:registered,
      MURAGE_PI_WIPE_CONTEXT_FILE:inventory, MURAGE_PI_NO_LIMITS:'1'};
    const commands: [string, boolean][] = finding === 'registered roots'
      ? [[`rm -rf "${registered}"`,true],[`rm -rf "${alias}"`,false],[`rm -rf "${alias}"/*`,true],
         [`rm -rf "${outside}"`,true],[`rm -rf "${registered}"/*`,true],
         [`rm -rf "${build}"/*`,false],[`rm -rf "${project}"`,true]]
      : [['rm -rf "$BUILD_DIR"/*',false],['rm -rf "$WIPE_DIR"/*',true],
         ['pwsh -Command Remove-Item -Recurse -Force "$env:BUILD_DIR/*"',false],
         ['pwsh -Command Remove-Item -Recurse -Force "$env:WIPE_DIR/*"',true],
         [String.raw`cmd /c rd /s /q "%BUILD_DIR%"`,false],
         [String.raw`cmd /c rd /s /q "%WIPE_DIR%"`,true]];
    const cwd = join(project,'src');
    const expected = commands.map(([command,wipe]) => {
      expect(wipeBreaker(command,{...context,cwd,env,registry}) !== null, command).toBe(wipe);
      return [command,wipe];
    });
    const native = finding === 'registered roots' ? [[registered,true],[build,false]] as const : [];
    for (const [path,wipe] of native) expect(nativeWipeBreaker('delete_file',{path},{...context,cwd,env,registry}) !== null).toBe(wipe);
    const output=join(root,'review-staged');
    const script=`
      import {stagePiWindowsHide} from ${JSON.stringify(new URL('../../scripts/stage-pi-windows-hide.mjs',import.meta.url).href)};
      import {pathToFileURL} from 'node:url';
      import assert from 'node:assert/strict';
      stagePiWindowsHide(${JSON.stringify(fileURLToPath(new URL('../../',import.meta.url)))},${JSON.stringify(output)});
      const {default:gate}=await import(pathToFileURL(${JSON.stringify(join(output,'drivers/pi-permission-gate.ts'))}).href);
      for(const missing of [false,true]) {
        delete globalThis[Symbol.for('murage.piGate')];
        process.env.MURAGE_PI_GATE=missing?'':'fixture-gate';
        process.env.MURAGE_PI_NO_LIMITS='1';
        process.env.MURAGE_PI_WIPE_CONTEXT_FILE=${JSON.stringify(inventory)};
        const handlers=new Map();gate({on:(name,handler)=>handlers.set(name,handler)});
        const ctx={cwd:${JSON.stringify(cwd)},hasUI:false,ui:{}};
        for(const [command,wipe] of ${JSON.stringify(expected)}) {
          const input={command};
          assert.equal((await handlers.get('tool_call')({toolName:'bash',input},ctx))?.block===true,wipe,command);
          assert.deepEqual(input,{command});
        }
        for(const [path,wipe] of ${JSON.stringify(native)})assert.equal((await handlers.get('tool_call')({toolName:'delete_file',input:{path}},ctx))?.block===true,wipe,path);
        // The existing secret-bearing reload slot also retains its root context.
        if(!missing) {
          const reloaded=new Map();gate({on:(name,handler)=>reloaded.set(name,handler)});
          for(const [command,wipe] of ${JSON.stringify(expected)})assert.equal((await reloaded.get('tool_call')({toolName:'bash',input:{command}},ctx))?.block===true,wipe,command);
        }
      }
      console.log('review context verified');
    `;
    // A file-based ESM entry mirrors Pi's loader without making its probe workers ESM.
    const entry=join(root,'review-staged.mjs');
    writeFileSync(entry,script);
    expect(execFileSync(process.execPath,['--experimental-strip-types',entry],{
      encoding:'utf8',timeout:30_000,env,
    })).toContain('review context verified');
  });
  it("the gate imports only its startup installer, staged checker and fixed-control table", () => {
    const imports = gate.split("\n").filter((line) => /^import /.test(line));
    // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: static generated checker import, carried by the extension stager.
    // MAIN RULING INT-CONFLICT-DEFAULT 0a8bdf9c8db6 d7b33d2b5628: retain the reviewed Windows startup installer and exact finite import allowlist.
    expect(imports.filter(line => !/from "node:/.test(line))).toEqual([
      'import "../../shared/win-hide-child-process.mjs";',
      'import { PI_CONTROL_FRAMES, preToolCode } from "./hook-control.ts";',
      'import { noLimitsWipe, nativeWipeBreaker, RootRegistry } from "./pi-wipe-check.generated.mjs";',
    ]);
    const staged = here('./pi-wipe-check.generated.mjs');
    expect(staged.split('\n').filter(line => /^import /.test(line)).every(line => /from "node:/.test(line))).toBe(true);
    expect(staged).not.toMatch(/\bimport\s*\(/);
  });
});

describe("T64: the installed engine's fields, pinned (@earendil-works/pi-coding-agent 1.3.0 sources)", () => {
  const fields: Record<string, Record<string, unknown>> = {
    bash: { command: "ls", timeout: 5 },
    read: { path: "README.md", offset: 1, limit: 5 },
    write: { path: "src/n.ts", content: "x" },
    edit: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
    grep: { pattern: "a", path: "src", glob: "*.ts", ignoreCase: true, literal: true, context: 1, limit: 3 },
    find: { pattern: "*.ts", path: "src", limit: 3 },
    ls: { path: "src", limit: 3 },
  };
  for (const [tool, input] of Object.entries(fields)) {
    it(`${tool}: every field of the engine's schema is a key an Allow answer may carry`, async () => {
      const gate = rig();
      gate.answer.next = () => allowAs(input);
      const event: any = { toolName: tool, input: { ...input } };
      // force an ask by pointing at a place outside the project
      if ("path" in input && tool !== "bash") event.input.path = join(outside, "plain.txt");
      const answerInput = { ...input, ...(event.input.path ? { path: event.input.path } : {}) };
      gate.answer.next = () => allowAs(answerInput);
      expect(await gate.call(event)).toBeUndefined();
      expect(gate.asked).toHaveLength(1);
    });
  }
});

describe('B8 No limits keeps only the local wipe check when the broker UI or secret is unavailable',()=>{
 it.each([false,true])('missing secret=%s: non-wipe runs and real wipe blocks',async missing=>{
  if(!missing)process.env.MURAGE_PI_GATE=SECRET;
  process.env.MURAGE_PI_NO_LIMITS='1';
  const on=new Map<string,Handler>();
  try{
   process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
   piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
   const call=on.get('tool_call')!,ctx={cwd:project,hasUI:false,ui:{}};
   expect(await call({toolName:'bash',input:{command:'touch ~/.ssh/config'}},ctx)).toBeUndefined();
   expect(await call({toolName:'bash',input:{command:'rm -rf ~'}},ctx)).toMatchObject({block:true});
   expect(await call({toolName:'bash',input:{command:'echo "rm -rf /"'}},ctx)).toBeUndefined();
   expect(await call({toolName:'bash',input:{command:'rm -rf "$UNKNOWN"'}},ctx)).toBeUndefined();
  }finally{delete process.env.MURAGE_PI_NO_LIMITS;}
 });
});
// 1.0.23 q1023-nolimits-fix (ASTRA review of 1317c58c66, High 1; MAIN-RULING NOLIMITS-1022 H1 correction): the fallback is the
// No limits wipe read, so an obfuscated wipe (decoded as far as it decodes) blocks here as it asks on every other No limits path.
const PI_OBFUSCATED_WIPES=['rm$IFS-rf$IFS/','$(echo rm) -rf ~','echo cm0gLXJmIH4= | base64 -d | sh',"printf '\\x72\\x6d -\\x72\\x66 ~' | sh",
 "echo '~ fr- mr' | rev | sh",`pwsh -ec ${Buffer.from('Remove-Item -Recurse -Force ~','utf16le').toString('base64')}`,'$(echo cm0gLXJmIC8= | base64 -d)'];
const PI_OBFUSCATED_RUNS=['echo Y2F0IH4vLnNzaC9pZF9yc2E= | base64 -d | sh','eval "$(ssh-agent -s)"',`pwsh -ec ${Buffer.from('Remove-Item -Recurse -Force .\\scratch\\tmp','utf16le').toString('base64')}`,'eval true; echo cm0gLXJmIH4= | base64 -d'];
describe('B9 No limits local fallback reads obfuscated wipes',()=>{
 it.each([false,true])('missing secret=%s: an obfuscated wipe blocks; a decoder with no wipe in what runs does not',async missing=>{
  if(!missing)process.env.MURAGE_PI_GATE=SECRET;else delete process.env.MURAGE_PI_GATE;
  process.env.MURAGE_PI_NO_LIMITS='1';
  const on=new Map<string,Handler>();
  try{
   process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
   piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
   const call=on.get('tool_call')!,ctx={cwd:project,hasUI:false,ui:{}};
   const outcome=async(command:string)=>`${command} => ${(await call({toolName:'bash',input:{command}},ctx) as {block?:boolean}|undefined)?.block===true?'blocked':'runs'}`;
   const wipes:string[]=[],runs:string[]=[];
   for(const command of PI_OBFUSCATED_WIPES)wipes.push(await outcome(command));
   for(const command of PI_OBFUSCATED_RUNS)runs.push(await outcome(command));
   expect(wipes).toEqual(PI_OBFUSCATED_WIPES.map(command=>`${command} => blocked`));
   expect(runs).toEqual(PI_OBFUSCATED_RUNS.map(command=>`${command} => runs`));
  }finally{delete process.env.MURAGE_PI_NO_LIMITS;}
 });
});
const PI_ARGV_DISK_WIPES=[`python3 -c 'import sys; open(sys.argv[1],"wb").write(b"x")' /tmp/../dev/sda`,`node -e 'require("fs").writeFileSync(process.argv[1], "x")' /tmp/../dev/sda`];
const PI_ARGV_DISK_RUNS=[`python3 -c 'import sys; print(sys.argv[1])' /tmp/../dev/sda`,`python3 -c 'import sys; print("write", sys.argv[1])' /tmp/../dev/sda`,`python3 -c 'import sys; open(sys.argv[1],"w").write("x")' /w/out.txt`,`node -e 'console.log(process.argv[1])' /dev/stdout`];
describe('B10 No limits local fallback cards a disk named to argv-writing interpreter code',()=>{
 it.each([false,true])('missing secret=%s',async missing=>{
  if(!missing)process.env.MURAGE_PI_GATE=SECRET;else delete process.env.MURAGE_PI_GATE;
  process.env.MURAGE_PI_NO_LIMITS='1';
  const on=new Map<string,Handler>();
  try{
   process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
   piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
   const call=on.get('tool_call')!,ctx={cwd:project,hasUI:false,ui:{}};
   const outcome=async(command:string)=>`${command} => ${(await call({toolName:'bash',input:{command}},ctx) as {block?:boolean}|undefined)?.block===true?'blocked':'runs'}`;
   const wipes:string[]=[],runs:string[]=[];
   for(const command of PI_ARGV_DISK_WIPES)wipes.push(await outcome(command));
   for(const command of PI_ARGV_DISK_RUNS)runs.push(await outcome(command));
   expect(wipes).toEqual(PI_ARGV_DISK_WIPES.map(command=>`${command} => blocked`));
   expect(runs).toEqual(PI_ARGV_DISK_RUNS.map(command=>`${command} => runs`));
  }finally{delete process.env.MURAGE_PI_NO_LIMITS;}
 });
});
// H3 exercises the deployed fallback through the shared reader.
it.each([['rm -rf ~/*',true],['rm -rf /usr/*',true],['mkfs --help',true],['mkfs.ext4 --version',true],['mkfs.ext4 /dev/fake-fixture',true],['printf "rm -rf ~/*"',true],["rm -rf '/usr/*'",true],['bash -c "rm -rf ~/*"',true]] as const)('H3 Pi local fallback: %s',async(command,_historicalWipe)=>{
 // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: retain every historical input; the approved checker supplies the current verdict.
 const wipe=wipeBreaker(command,{home:homedir(),cwd:project})!==null;
 process.env.MURAGE_PI_NO_LIMITS='1';delete process.env.MURAGE_PI_GATE;
 const on=new Map<string,Handler>();
 try{
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
  piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
  const result=await on.get('tool_call')!({toolName:'bash',input:{command}},{cwd:project,hasUI:false,ui:{}});
  if(wipe)expect(result).toMatchObject({block:true});else expect(result).toBeUndefined();
 }finally{delete process.env.MURAGE_PI_NO_LIMITS;}
});

// R1 exercises the actual Pi fallback with both broker-unavailable paths.
for(const missing of [false,true])it.each([
 ['pwsh -Command Remove-Item -Recurse -Force "$HOME/*"',true],
 ["pwsh -Command Remove-Item -Recurse -Force '/usr/*'",true],
 ['pwsh -Command Remove-Item -Recurse -Force -LiteralPath "$HOME/*"',true],
 ['pwsh -Command \'Remove-Item -Recurse -Force "$HOME/*"\'',true],
 ['pwsh -Command "Remove-Item -Recurse -Force \'/usr/*\'"',true],
 ['pwsh -Command \'Remove-Item -Recurse -Force -LiteralPath "$HOME/*"\'',true],
 ['bash -c \'rm -rf "$HOME/*"\'',true],
 ["rm -rf '~'/*",true],
 ['pwsh -Command \'Write-Output "Remove-Item -Recurse -Force $HOME/*"\'',true],
] as const)(`R1 Pi missing secret=${missing}: %s`,async(command,_historicalWipe)=>{
 // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: retain every historical input; the approved checker supplies the current verdict.
 const wipe=wipeBreaker(command,{home:homedir(),cwd:project})!==null;
 if(!missing)process.env.MURAGE_PI_GATE=SECRET;
 else delete process.env.MURAGE_PI_GATE;
 process.env.MURAGE_PI_NO_LIMITS='1';
 const on=new Map<string,Handler>();
 try{
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
  piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
  const result=await on.get('tool_call')!({toolName:'bash',input:{command}},{cwd:project,hasUI:false,ui:{}});
  if(wipe)expect(result).toMatchObject({block:true});else expect(result).toBeUndefined();
 }finally{delete process.env.MURAGE_PI_NO_LIMITS;}
});

import { visibleWipeCases } from '../../shared/testing/no-limits-visible-wipe-cases.ts';
// MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: current-policy narrowWipe replaces the retained historical raw oracle.
for (const missing of [false, true]) it.each(visibleWipeCases)(`R3 Pi missing secret=${missing} $id: $command`, async ({ command, narrowWipe: wipe }) => {
 if (!missing) process.env.MURAGE_PI_GATE = SECRET;
 else delete process.env.MURAGE_PI_GATE;
 process.env.MURAGE_PI_NO_LIMITS = '1';
 const on = new Map<string, Handler>();
 try {
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
  piPermissionGate({on: (name: string, handler: Handler) => on.set(name, handler)} as never);
  const result = await on.get('tool_call')!({toolName: 'bash', input: {command: command.replaceAll('/fixture/home', homedir())}}, {cwd: project, hasUI: false, ui: {}});
  if (wipe) expect(result).toMatchObject({block: true});
  else expect(result).toBeUndefined();
 } finally { delete process.env.MURAGE_PI_NO_LIMITS; }
});

for (const missing of [false, true]) it(`R4 Pi reader exception holds, missing secret=${missing}`, async () => {
 if (!missing) process.env.MURAGE_PI_GATE = SECRET;
 else delete process.env.MURAGE_PI_GATE;
 process.env.MURAGE_PI_NO_LIMITS = '1';
 const on = new Map<string, Handler>();
 try {
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
  piPermissionGate({on: (name: string, handler: Handler) => on.set(name, handler)} as never);
  const input = Object.defineProperty({}, 'command', {get() {throw new Error('unread fixture');}});
  expect(await on.get('tool_call')!({toolName: 'bash', input}, {cwd: project, hasUI: false, ui: {}})).toMatchObject({block: true});
 } finally {delete process.env.MURAGE_PI_NO_LIMITS;}
});

import {assembledWipeCases} from '../../shared/testing/no-limits-assembled-cases.ts';
for(const missing of [false,true])it.each(assembledWipeCases)(`R4 assembled Pi missing secret=${missing} $id wipe=$wipe`,async({command})=>{
 // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: retain every historical input; the approved checker supplies the current verdict.
 const wipe=wipeBreaker(command,{home:homedir(),cwd:project})!==null;
 if(!missing)process.env.MURAGE_PI_GATE=SECRET;else delete process.env.MURAGE_PI_GATE;
 process.env.MURAGE_PI_NO_LIMITS='1';const on=new Map<string,Handler>();
 try{
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
  piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
  const result=await on.get('tool_call')!({toolName:'bash',input:{command}},{cwd:project,hasUI:false,ui:{}});
  if(wipe)expect(result).toMatchObject({block:true});else expect(result).toBeUndefined();
 }finally{delete process.env.MURAGE_PI_NO_LIMITS;}
});

import {parseFreeWipeCases} from '../../shared/testing/no-limits-parse-free-cases.ts';
for(const missing of [false,true])it.each(parseFreeWipeCases)(`R5 parse-free Pi missing secret=${missing} $id wipe=$wipe`,async({command})=>{
 // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: retain every historical input; the approved checker supplies the current verdict.
 const wipe=wipeBreaker(command,{home:homedir(),cwd:project})!==null;
 if(!missing)process.env.MURAGE_PI_GATE=SECRET;else delete process.env.MURAGE_PI_GATE;
 process.env.MURAGE_PI_NO_LIMITS='1';const on=new Map<string,Handler>();
 try{
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
  piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
  const result=await on.get('tool_call')!({toolName:'bash',input:{command}},{cwd:project,hasUI:false,ui:{}});
  if(wipe)expect(result).toMatchObject({block:true});else expect(result).toBeUndefined();
 }finally{delete process.env.MURAGE_PI_NO_LIMITS;}
});

it.each([null, "bound"] as const)("a %s mode never accepts a legacy editor allow", async mode => {
  const gate = rig({ mode });
  gate.answer.next = () => allowAs({ command: "echo fixture" });
  expect(await gate.call({ toolName: "bash", input: { command: "echo fixture" } })).toMatchObject({ block: true });
});

// Test the real disconnected handler against the authority, independently of table verdicts.
it('Pi offline differential: every visible case agrees with the approved checker', async () => {
 const differences: {missing:boolean;id:string;gate:boolean;approved:boolean}[]=[];
 const registry=new RootRegistry();
 registry.replace('bot:differential:cwd',[project]);
 const inventory=join(root,'differential-context.json');
 const context={home:homedir(),project};
 writeInventory(inventory, context, registry.snapshot());
 let compared=0;
 for(const missing of [false,true]) {
  if(missing)delete process.env.MURAGE_PI_GATE;else process.env.MURAGE_PI_GATE=SECRET;
  process.env.MURAGE_PI_NO_LIMITS='1';
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE=inventory;
  const on=new Map<string,Handler>();
  process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
  piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
  for(const {id,command} of visibleWipeCases) {
   const text=command.replaceAll('/fixture/home',homedir());
   const result=await on.get('tool_call')!({toolName:'bash',input:{command:text}},{cwd:project,hasUI:false,ui:{}});
   const gate=result?.block===true,approved=wipeBreaker(text,{...context,cwd:project,platform:process.platform,env:process.env,registry})!==null;
   if(gate!==approved)differences.push({missing,id,gate,approved});
   compared++;
  }
 }
 console.info(JSON.stringify({kind:'pi-offline-differential',cases:visibleWipeCases.length,compared,differences}));
 expect(differences).toEqual([]);
});

it.each([
 ['powershell-home','pwsh -Command Remove-Item -Recurse -Force "$HOME/*"',true],
 ['cmd-home',`cmd /c 'rd /s /q "%USERPROFILE%/*"'`,true],
 ['executed-substitution','echo "$(rm -rf ~)"',true],
 ['printed-example','printf "rm -rf ~/*"',false],
 ['help','mkfs --help',false],
 ['version','mkfs.ext4 --version',false],
] as const)('Pi offline authority witness: %s',async(id,command,wipe)=>{
 delete process.env.MURAGE_PI_GATE;process.env.MURAGE_PI_NO_LIMITS='1';
 const on=new Map<string,Handler>();
 process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
 piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
 const result=await on.get('tool_call')!({toolName:'bash',input:{command}},{cwd:project,hasUI:false,ui:{}});
 expect(result?.block===true).toBe(wipe);
 expect(wipeBreaker(command,{home:homedir(),cwd:project})!==null).toBe(wipe);
 console.info(JSON.stringify({kind:'pi-offline-witness',id,gate:result?.block?'card':'run',approved:wipe?'card':'run'}));
});

it.each([false,true])('Pi offline native targets use the approved checker, missing secret=%s',async missing=>{
 if(missing)delete process.env.MURAGE_PI_GATE;else process.env.MURAGE_PI_GATE=SECRET;
 process.env.MURAGE_PI_NO_LIMITS='1';
 const on=new Map<string,Handler>();
 process.env.MURAGE_PI_WIPE_CONTEXT_FILE ??= join(root, 'default-context');
 piPermissionGate({on:(name:string,handler:Handler)=>on.set(name,handler)} as never);
 const ctx={cwd:project,hasUI:false,ui:{}};
 const wipe={paths:['/'],padding:'ordinary metadata'};
 expect(await on.get('tool_call')!({toolName:'delete_files',input:wipe},ctx)).toMatchObject({block:true});
 expect(wipe).toEqual({paths:['/'],padding:'ordinary metadata'});
 expect(await on.get('tool_call')!({toolName:'delete_file',input:{path:join(project,'src/a.ts')}},ctx)).toBeUndefined();
 expect(visibleDeleteTarget('/',homedir(),project)).toBe('delete-root');
});
