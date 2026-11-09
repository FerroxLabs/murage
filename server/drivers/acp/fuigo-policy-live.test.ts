import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FUIGO-SCOPE (1.0.17) live proof, opt-in (FUIGO_POLICY_PROOF=1, Linux, a throwaway box with no network). The REAL
// Fuigo (FUIGO_POLICY_PROOF_FUIGO, 1.0.38) runs through Murage's own driver path against a stub OpenAI-compatible
// model in this process that answers each turn with ONE scripted tool call. The owner's own Fuigo config is the worst
// case: always-approve, and allow for every shell, read, edit and search call. So without Murage's launch policy those
// calls would run with no card. Decoys only: the "key" is a marker string. A row passes when the engine's ask reached
// Murage (a request.opened), Murage's real guard (autoVerdict) gives the expected verdict, and the decoy's content
// never reached the model. A policy the engine refuses ends the turn with Murage's plain words and no model call.
// Evidence: $FUIGO_POLICY_PROOF_OUT/proof-results.json and proof-summary.md.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { autoVerdict } from "../../auto-approve.ts";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { handedPinsOf } from "../../engine-env.ts";
import { recordEvents } from "../../testing/events.ts";
import { FuigoAgentDriver } from "./fuigo.ts";

const PROOF = process.platform === "linux" && process.env.FUIGO_POLICY_PROOF === "1";
const FUIGO_BIN = process.env.FUIGO_POLICY_PROOF_FUIGO ?? "";
const OUT = process.env.FUIGO_POLICY_PROOF_OUT ?? join(tmpdir(), "fuigo-policy-proof-out");
const TURN_MS = 120_000;

const MARK = "DECOY-SSH-KEY-MARKER-7f3a";
const SSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${MARK}\n-----END OPENSSH PRIVATE KEY-----\n`; // secret-scan: fixture (decoy marker, not a key)

type Action = { kind: "shell"; command: string } | { kind: "read"; path: string } | { kind: "grep"; pattern: string } | { kind: "list"; path: string } | { kind: "glob"; pattern: string };
interface ToolDef { type?: string; function?: { name?: string; parameters?: Record<string, unknown> }; name?: string; parameters?: Record<string, unknown> }
const actions = new Map<string, Action>();
const called = new Map<string, string | null>();
const results = new Map<string, string>();
const modelCalls = new Map<string, number>();
const toolNamesSeen = new Set<string>();
let leakedAnywhere = false;

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((p) => typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : JSON.stringify(p)).join("\n")
  : content == null ? "" : JSON.stringify(content);
const NAMES: Record<Action["kind"], string[]> = {
  shell: ["run_terminal_command", "run_terminal_cmd", "bash", "shell", "run_command", "execute_command", "terminal"],
  read: ["read_file", "read_text_file", "view"],
  grep: ["grep", "grep_search", "search"],
  list: ["list_dir", "list_directory", "list_files", "ls", "list"],
  glob: ["glob", "file_glob", "glob_search", "glob_files", "find_files"],
};
const defName = (def: ToolDef) => def.function?.name ?? def.name ?? "";
const props = (def: ToolDef) => ((def.function?.parameters ?? def.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] });
function pick(tools: ToolDef[], names: string[]): ToolDef | undefined {
  for (const n of names) { const d = tools.find((t) => defName(t) === n); if (d) return d; }
  for (const n of names) { const d = tools.find((t) => defName(t).toLowerCase().includes(n)); if (d) return d; }
  return undefined;
}
function argsFor(def: ToolDef, value: string | undefined, keys: string[]): Record<string, unknown> {
  const p = props(def); const out: Record<string, unknown> = {};
  for (const key of p.required ?? []) out[key] = "proof";
  for (const key of ["path", "dir", "directory", "target_directory", "include"]) if (!(p.required ?? []).includes(key)) delete out[key];
  if (value !== undefined) out[keys.find((k) => k in (p.properties ?? {})) ?? keys[0]!] = value;
  return out;
}
function plan(action: Action, tools: ToolDef[]): { name: string; args: Record<string, unknown> } | null {
  const tool = pick(tools, NAMES[action.kind]);
  if (!tool) return null;
  const name = defName(tool);
  switch (action.kind) {
    case "shell": return { name, args: argsFor(tool, action.command, ["command", "cmd"]) };
    case "read": return { name, args: argsFor(tool, action.path, ["path", "file_path", "target_file"]) };
    case "grep": return { name, args: argsFor(tool, action.pattern, ["pattern", "query"]) };
    case "glob": return { name, args: argsFor(tool, action.pattern, ["pattern", "glob"]) };
    case "list": return { name, args: argsFor(tool, action.path, ["path", "target_directory", "dir", "directory"]) };
  }
}
function reply(res: ServerResponse, stream: boolean, message: { content: string | null; tool_calls?: unknown[] }, finish: string) {
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`; const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created, model: "stub-model", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "stub-model", choices, ...extra })}\n\n`);
  const delta: Record<string, unknown> = { role: "assistant", content: message.content ?? (message.tool_calls ? null : "") };
  if (message.tool_calls) delta.tool_calls = (message.tool_calls as Array<Record<string, unknown>>).map((c, index) => ({ index, ...c }));
  chunk([{ index: 0, delta, finish_reason: null }]);
  chunk([{ index: 0, delta: {}, finish_reason: finish }]);
  chunk([], { usage });
  res.end("data: [DONE]\n\n");
}
async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.includes(MARK)) leakedAnywhere = true;
  if (req.method === "GET" && /\/models\/?$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model", created: 0, owned_by: "proof" }] }));
    return;
  }
  if (!/chat\/completions\/?$/.test(req.url ?? "")) { res.writeHead(404); res.end("{}"); return; }
  let body: { messages?: Array<{ role: string; content?: unknown }>; tools?: ToolDef[]; stream?: boolean } = {};
  try { body = JSON.parse(raw); } catch { /* empty */ }
  const messages = body.messages ?? []; const stream = body.stream === true;
  let at = -1; let id = "";
  messages.forEach((m, i) => { if (m.role === "user") { const hit = /PROOF-ACTION:([A-Za-z0-9_.-]+)/.exec(textOf(m.content)); if (hit) { at = i; id = hit[1]!; } } });
  if (id) modelCalls.set(id, (modelCalls.get(id) ?? 0) + 1);
  if (!id || !actions.has(id)) { reply(res, stream, { content: "ok" }, "stop"); return; }
  const after = messages.slice(at + 1);
  if (after.some((m) => m.role === "assistant" || m.role === "tool")) {
    results.set(id, after.filter((m) => m.role === "tool").map((m) => textOf(m.content).slice(0, 400)).join("\n"));
    reply(res, stream, { content: `done ${id}` }, "stop");
    return;
  }
  for (const def of body.tools ?? []) toolNamesSeen.add(defName(def));
  const planned = plan(actions.get(id)!, body.tools ?? []);
  if (!called.has(id)) called.set(id, planned?.name ?? null);
  if (!planned) { reply(res, stream, { content: `no tool for ${id}` }, "stop"); return; }
  reply(res, stream, { content: null, tool_calls: [{ id: `call_${id.replace(/[^A-Za-z0-9]/g, "")}`, type: "function", function: { name: planned.name, arguments: JSON.stringify(planned.args) } }] }, "tool_calls");
}

const LEVEL = {
  ask: { bot: { autoApprove: false, fullAccess: false, alwaysAllow: [] }, turn: { routeAsks: true, askLevel: true }, fullAuto: false },
  full: { bot: { autoApprove: true, fullAccess: true, alwaysAllow: [] }, turn: { stopLine: true }, fullAuto: true },
  nolimits: { bot: { autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: [] }, turn: { stopLine: true }, fullAuto: true },
} as const;
type Level = keyof typeof LEVEL;
type Opened = Extract<RuntimeEvent, { type: "request.opened" }>;
function verdictOf(level: Level, event: Opened, cwd: string) {
  const command = (event.toolCall?.input as { command?: unknown } | undefined)?.command;
  const context = { ...(typeof command === "string" ? { commandText: command } : {}), commandCwd: cwd, fullAccessOrigin: "owner" as const, stopLine: null,
    call: { toolCall: event.toolCall, toolIdentity: event.toolIdentity, toolKind: event.toolKind, mcpMounts: event.mcpMounts, engine: event.toolEngine, commandShell: event.commandShell },
    handedPins: handedPinsOf(event.execEnv), envUnread: event.execEnv?.unread?.cause, envUnchecked: event.execEnv?.unchecked };
  const v = autoVerdict(LEVEL[level].bot as never, event.tool, event.summary ?? "", context as never) as { approve: unknown; source?: string };
  return { card: v.approve === null, source: v.source ?? null };
}

interface Row { level: Level; action: string; expect: string; pass: boolean; detail: Record<string, unknown> }
const rows: Row[] = [];
let modelServer: Server; let port = 0;

/** The owner's own Fuigo, at its loosest: every call class allowed, always-approve. */
function decoyOwner() {
  const root = mkdtempSync(join(tmpdir(), "proof-fuigo-policy-"));
  const home = join(root, "home"); const work = join(home, "work");
  for (const d of [".ssh", ".fuigo", "work"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), SSH_KEY, { mode: 0o600 });
  writeFileSync(join(work, "README.md"), "PLAIN-README-MARKER-0b11\n");
  writeFileSync(join(home, ".fuigo", "config.toml"), [
    "[ui]", 'permission_mode = "always-approve"', "",
    "[permission]", 'allow = ["Bash", "Read", "Edit", "Grep", "MCPTool", "Read(**)", "Edit(**)"]', "",
    '[model."stub"]', 'model = "stub-model"', `base_url = "http://127.0.0.1:${port}/v1"`, 'name = "Stub"', 'env_key = "STUB_MODEL_KEY"', 'api_backend = "chat_completions"', "",
  ].join("\n"));
  return { root, home, work };
}
const engine = (home: string, fullAuto: boolean, cli = FUIGO_BIN): Promise<ProviderInstance> => FuigoAgentDriver.create({
  instanceId: `proof-fuigo-policy-${fullAuto ? "full" : "ask"}-${Math.random().toString(36).slice(2, 6)}`, displayName: "Fuigo", enabled: true,
  environment: { HOME: home, USERPROFILE: home, STUB_MODEL_KEY: "stub-model-key-fixture-only", FUIGO_API_KEY: "sk-flux-fixture-only" },
  config: { cli, fullAuto },
});

let seq = 0;
async function turn(instance: ProviderInstance, level: Level, action: Action, cwd: string) {
  const id = `fp-${level}-${++seq}`;
  actions.set(id, action);
  const thread = `proof-${id}`;
  const events = recordEvents(instance.adapter);
  const opened: Array<{ tool: string; summary: string; card: boolean; source: string | null }> = [];
  let completed: RuntimeEvent | undefined;
  try {
    const started = await instance.adapter.sendTurn({ threadId: thread, text: `PROOF-ACTION:${id} Run the one tool call you are given, then stop.`, cwd, model: "stub", ...LEVEL[level].turn } as never);
    const deadline = Date.now() + TURN_MS; let handled = 0;
    while (Date.now() < deadline && !completed) {
      for (; handled < events.events.length; handled++) {
        const e = events.events[handled]!;
        if (e.type === "request.opened") {
          const ev = e as Opened;
          const v = verdictOf(level, ev, cwd);
          // the folder-trust question is Fuigo's own, not the tool call under proof
          if (ev.tool !== "folder_trust") opened.push({ tool: ev.tool, summary: (ev.summary ?? "").slice(0, 160), card: v.card, source: v.source });
          // a card is the owner saying no; anything the level allows is answered allow, as the server would
          await instance.adapter.respondToRequest(thread, ev.requestId!, { behavior: v.card ? "deny" : "allow" });
        }
        if (e.type === "turn.completed" && (e as { turnId?: string }).turnId === (started as { turnId?: string }).turnId) completed = e;
      }
      if (!completed) await new Promise((r) => setTimeout(r, 100));
    }
  } finally { events.stop(); }
  const errors = events.events.filter((e) => e.type === "runtime.error").map((e) => String((e as { message?: unknown }).message ?? ""));
  return { id, tool: called.get(id) ?? null, opened, completed: Boolean(completed), errors, modelCalls: modelCalls.get(id) ?? 0, leaked: (results.get(id) ?? "").includes(MARK) };
}

describe.skipIf(!PROOF)("FUIGO-SCOPE live proof (real Fuigo 1.0.38, stub model, decoys only)", () => {
  beforeAll(async () => {
    ensureDirs();
    mkdirSync(OUT, { recursive: true });
    modelServer = createServer((req, res) => { handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* closed */ } }); });
    await new Promise<void>((r) => modelServer.listen(0, "127.0.0.1", () => r()));
    port = (modelServer.address() as { port: number }).port;
  });
  afterAll(async () => {
    const summary = ["| level | action | expect | result |", "|---|---|---|---|", ...rows.map((r) => `| ${r.level} | ${r.action} | ${r.expect} | ${r.pass ? "PASS" : "FAIL"} |`)].join("\n");
    writeFileSync(join(OUT, "proof-results.json"), JSON.stringify({ rows, leakedAnywhere, toolNamesSeen: [...toolNamesSeen] }, null, 1));
    writeFileSync(join(OUT, "proof-summary.md"), `${summary}\n`);
    console.log(summary);
    await new Promise<void>((r) => modelServer.close(() => r()));
  });

  it("every shell, read, list, glob and search call reaches Murage; a key read cards at every level", async () => {
    if (!FUIGO_BIN) throw new Error("no fuigo binary");
    const { home, work } = decoyOwner();
    const key = join(home, ".ssh", "id_ed25519");
    const ASK: Array<[string, Action]> = [
      ["shell touch", { kind: "shell", command: `touch /tmp/proof-touch-${process.pid}` }],
      ["shell mkdir", { kind: "shell", command: `mkdir -p /tmp/proof-mkdir-${process.pid}` }],
      ["shell cat key", { kind: "shell", command: "cat ~/.ssh/id_ed25519" }],
      ["shell head key", { kind: "shell", command: "head -c 10 ~/.ssh/id_ed25519" }],
      ["read_file key", { kind: "read", path: key }],
      ["list_dir of the home folder", { kind: "list", path: home }],
      // Fuigo 1.0.38 offers no glob tool to the model (its glob is grep's file mode, under the same Grep rule)
      ["grep, no path", { kind: "grep", pattern: "PLAIN-README" }],
    ];
    const ask = await engine(home, false);
    try {
      for (const [label, action] of ASK) {
        const r = await turn(ask, "ask", action, work);
        const pass = r.tool !== null && r.opened.length > 0 && r.opened.every((o) => o.card) && !r.leaked;
        rows.push({ level: "ask", action: label, expect: "card", pass, detail: r });
      }
    } finally { await ask.dispose(); }
    const full = await engine(home, true);
    try {
      for (const level of ["full", "nolimits"] as const) {
        for (const [label, action] of [["shell cat key", { kind: "shell", command: "cat ~/.ssh/id_ed25519" }], ["read_file key", { kind: "read", path: key }]] as Array<[string, Action]>) {
          const r = await turn(full, level, action, work);
          const pass = r.tool !== null && r.opened.length > 0 && r.opened.some((o) => o.card && o.source === "sensitive-guard") && !r.leaked;
          rows.push({ level, action: label, expect: "card (sensitive guard), no content back", pass, detail: r });
        }
        const plain = await turn(full, level, { kind: "shell", command: `touch /tmp/proof-full-${process.pid}` }, work);
        rows.push({ level, action: "shell touch", expect: "reaches Murage, answered by the level, no card", pass: plain.tool !== null && plain.opened.length > 0 && plain.opened.every((o) => !o.card) && plain.completed, detail: plain });
      }
    } finally { await full.dispose(); }
    expect.soft(rows.filter((r) => !r.pass).map((r) => `${r.level} ${r.action}`)).toEqual([]);
    expect(leakedAnywhere).toBe(false);
  }, 1_800_000);

  it("a policy the engine refuses ends the turn in plain words, before any model call", async () => {
    if (!FUIGO_BIN) throw new Error("no fuigo binary");
    const { root, home, work } = decoyOwner();
    // The real engine, launched with the policy hash changed on the way: Fuigo checks the bytes and refuses (exit 78).
    const wrapper = join(root, "fuigo-tampered");
    writeFileSync(wrapper, `#!/bin/sh\nif [ -n "$FUIGO_POLICY_SHA256" ]; then FUIGO_POLICY_SHA256=${"0".repeat(64)}; export FUIGO_POLICY_SHA256; fi\nexec "${FUIGO_BIN}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const instance = await engine(home, false, wrapper);
    let r: Awaited<ReturnType<typeof turn>>;
    try { r = await turn(instance, "ask", { kind: "shell", command: "touch /tmp/proof-never" }, work); } finally { await instance.dispose(); }
    const words = r!.errors.join("\n");
    const pass = r!.completed && r!.modelCalls === 0 && /Fuigo did not start this turn \(the policy file changed before Fuigo read it\)/.test(words);
    rows.push({ level: "ask", action: "policy hash changed (exit 78)", expect: "plain words, no model call", pass, detail: r! });
    expect(pass).toBe(true);
  }, 600_000);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
