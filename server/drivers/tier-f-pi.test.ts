// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piPermissionGate, { type FilterHooks } from "./pi-permission-gate.ts";
import { piGateControlAnswer } from "./pi.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const SECRET = "/private/owner-sentinel-💥/.env";
const POLICY = { block: true, reason: "Murage did not allow this call" };
const UNCHECKED = { block: true, reason: "Murage could not check this call" };
const ROWS = [
  ["deny.policy", POLICY.reason],
  ["deny.owner", "The owner did not allow this call. Do not try it again; carry on without it or ask the owner."],
  ["deny.timeout", "Murage: nobody answered this permission request in time. Skip this action and finish what you can without it."],
  ["deny.ended", "Murage: the turn ended"], ["deny.unchecked", UNCHECKED.reason],
  ["deny.nohook", "Murage held this call back because its check is not ready yet. Carry on without it for now, or try it again later."],
] as const;
let root: string;
const slot = globalThis as Record<symbol, unknown>;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tier-f-pi-")); mkdirSync(join(root, "project")); });
afterEach(() => {
  for (const name of ["MURAGE_PI_GATE", "MURAGE_PI_GATE_MODE", "MURAGE_PI_GATE_ONLY"]) delete process.env[name];
  delete slot[Symbol.for("murage.piGate")]; removeTempDirSync(root);
});
type Handler = (...args: any[]) => any;
function rig(mode?: string, hooks?: FilterHooks, noFilter = false) {
  process.env.MURAGE_PI_GATE = "isolated-fixture-token";
  if (mode === undefined) delete process.env.MURAGE_PI_GATE_MODE; else process.env.MURAGE_PI_GATE_MODE = mode;
  let answer: unknown = { code: "allow" };
  const on = new Map<string, Handler>();
  const api = { on(name: string, handler: Handler) { if (noFilter && name === "tool_result") throw Error(SECRET); on.set(name, handler); } };
  piPermissionGate(api as never, { hooks });
  const ctx = { cwd: join(root, "project"), hasUI: true, ui: { editor: async () => JSON.stringify(answer) } };
  return {
    setAnswer(value: unknown) { answer = value; }, ctx, on,
    call(event: unknown = { toolName: "bash", input: { command: SECRET } }) { return on.get("tool_call")!(event, ctx); },
    reload() { piPermissionGate(api as never, { hooks }); },
  };
}
describe("Tier F Pi decisions", () => {
  it.each(ROWS)("T-PI-DECISION-FIXED: %s is the exact frozen block", async (code, reason) => {
    const f = rig("bound"); f.setAnswer({ code });
    const result = await f.call(); expect(result).toEqual({ block: true, reason }); expect(Object.isFrozen(result)).toBe(true);
  });
  it("T-PI-DECISION-FIXED: allow never changes the held input, even a frozen one", async () => {
    const f = rig(); const input = Object.freeze({ command: SECRET, nested: Object.freeze({ secret: SECRET }) });
    const event = Object.freeze({ toolName: "bash", input });
    expect(await f.call(event)).toBeUndefined(); expect(event.input).toBe(input); expect(input.command).toBe(SECRET);
  });
  it.each([
    { allow: true, input: { command: SECRET } }, { allow: true, keep: true }, { deny: true, reason: SECRET },
    { code: "deny.owner", reason: SECRET }, { code: "allow", input: { command: SECRET } },
    { code: "allow", additionalContext: SECRET }, { code: "stop.end" }, { code: "session.ok" },
    { code: "unknown" }, null, [{ code: "allow" }],
  ])("T-PI-DECISION-FIXED: malformed/content-bearing replies fail closed %#", async reply => {
    const f = rig(); f.setAnswer(reply); expect(await f.call()).toEqual(UNCHECKED);
  });
  it("T-PI-NARROW-DENIES: server uses deny.policy and the extension leaves input untouched", async () => {
    for (const decision of [
      { behavior: "allow" as const, updatedInput: { command: "narrowed" } },
      { behavior: "allow" as const, source: "narrow" as const },
      { behavior: "deny" as const, source: "narrow" as const, message: SECRET },
    ]) {
      const f = rig(); const reply = piGateControlAnswer(decision);
      expect(reply).toEqual({ code: "deny.policy" }); f.setAnswer(reply);
      const input = { command: SECRET }; const before = JSON.stringify(input);
      expect(await f.call({ toolName: "bash", input })).toEqual(POLICY);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(piGateControlAnswer({ behavior: "allow" })).toEqual({ code: "allow" });
    expect(piGateControlAnswer({ behavior: "deny", message: SECRET })).toEqual({ code: "deny.owner" });
  });
  it.each([undefined, "", "Open", "bound", "open "])("T-PI-MODE: %s defaults bound and survives new_session", async mode => {
    const f = rig(mode); f.setAnswer({ deny: true, reason: SECRET });
    expect(await f.call()).toEqual(UNCHECKED);
    expect(process.env.MURAGE_PI_GATE_MODE).toBeUndefined();
    f.reload(); expect(await f.call()).toEqual(UNCHECKED);
    f.setAnswer({ code: "allow" }); expect(await f.call()).toBeUndefined();
  });
  it("T-PI-MODE: exact open preserves tip variable reasons and input rewrite across reload", async () => {
    const f = rig("open"); f.setAnswer({ deny: true, reason: SECRET });
    expect(await f.call()).toEqual({ block: true, reason: SECRET });
    f.reload(); expect(await f.call()).toEqual({ block: true, reason: SECRET });
    f.setAnswer({ allow: true, input: { command: "narrowed" } });
    const event = { toolName: "bash", input: { command: SECRET } };
    expect(await f.call(event)).toBeUndefined(); expect(event.input).toEqual({ command: "narrowed" });
  });
  it("T-PI-MODE: packaged extension ships its shared pure control module", () => {
    const bundler = readFileSync(new URL("../../scripts/bundle-server.mjs", import.meta.url), "utf8");
    expect(bundler).toContain('copyFileSync(join(server, "drivers", "hook-control.ts"), join(root, "dist-server", "drivers", "hook-control.ts"))');
  });
  it("T-PI-DIAG-NO-PATH: walk errors, sensitive hits, incomplete walks, no UI, unknown tools and exceptions", async () => {
    const walks: Array<[FilterHooks["walk"], typeof POLICY]> = [
      [() => ({ ok: false, why: SECRET }), UNCHECKED],
      [() => ({ ok: true, root: SECRET, hits: [{ path: SECRET, dir: false, rule: "env" }], unwalked: [] }), POLICY],
      [() => ({ ok: true, root: SECRET, hits: [], unwalked: [SECRET] }), UNCHECKED],
      [() => { throw Error(SECRET); }, UNCHECKED],
    ];
    for (const [walk, expected] of walks) {
      // PRODUCT CHANGE §7.2: an untrusted bound filter terminates, including
      // every old walk fixture. Exercise it in a child, never the test runner.
      const status = join(root, "status");
      const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
        import gate, { DEFAULT_HOOKS } from ${JSON.stringify(new URL("./pi-permission-gate.ts", import.meta.url).href)};
        const SECRET = ${JSON.stringify(SECRET)};
        process.env.MURAGE_PI_GATE = "fixture";
        process.env.MURAGE_PI_GATE_MODE = "bound";
        process.env.MURAGE_PI_GATE_STATUS_FILE = ${JSON.stringify(status)};
        const handlers = new Map();
        gate({ on(name, handler) { if (name === "tool_result") throw Error(SECRET); handlers.set(name, handler); } },
          { hooks: { ...DEFAULT_HOOKS, walk: (${walk.toString()}) } });
        await handlers.get("tool_call")({ toolName: "grep", input: { pattern: "x", path: "." } },
          { cwd: ${JSON.stringify(join(root, "project"))}, hasUI: true });
        process.stdout.write(JSON.stringify(${JSON.stringify(expected)}));
      `], { encoding: "utf8", timeout: 10_000, env: { ...process.env, MURAGE_PI_GATE_MODE_FILE: "" } });
      expect(child.signal).toBe("SIGKILL");
      expect(readFileSync(status, "utf8")).toBe("refuse.pi.filter");
      expect(child.stdout).toBe(""); expect(child.stderr).not.toContain(SECRET);
    }
    const f = rig();
    f.ctx.hasUI = false; expect(await f.call()).toEqual(UNCHECKED);
    expect(await f.call({ toolName: SECRET, input: {} })).toEqual(POLICY);
    f.ctx.hasUI = true; f.ctx.ui.editor = async () => { throw Error(SECRET); };
    expect(await f.call()).toEqual(UNCHECKED);
    f.ctx.ui.editor = async () => "malformed"; expect(await f.call()).toEqual(UNCHECKED);
  });
});
