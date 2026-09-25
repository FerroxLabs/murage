// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";

import piPermissionGate, { PI_GATE_MESSAGE_MAX, piGateAsks, piGateMessage } from "./pi-permission-gate.ts";

describe("which pi calls wait for Murage", () => {
  const cwd = "/work/project";
  it("asks before every shell command", () => {
    expect(piGateAsks("bash", { command: "ls" }, cwd, [])).toBe(true);
    expect(piGateAsks("powershell", { command: "dir" }, cwd, [])).toBe(true);
  });
  it("lets edits inside the working folder through and asks about the rest", () => {
    expect(piGateAsks("edit", { path: "src/a.ts" }, cwd, [])).toBe(false);
    expect(piGateAsks("write", { path: "/work/project/notes.md" }, cwd, [])).toBe(false);
    expect(piGateAsks("write", { path: "/work/project-other/x" }, cwd, [])).toBe(true);
    expect(piGateAsks("write", { path: "../outside.md" }, cwd, [])).toBe(true);
    expect(piGateAsks("edit", { path: "/Users/owner/.zshrc" }, cwd, [])).toBe(true);
    expect(piGateAsks("edit", {}, cwd, [])).toBe(true);
  });
  it("never asks about reading, and asks about connected apps only when told to", () => {
    for (const tool of ["read", "grep", "find", "ls"]) expect(piGateAsks(tool, {}, cwd, [])).toBe(false);
    expect(piGateAsks("composio_composio_multi_execute_tool", {}, cwd, [])).toBe(false);
    expect(piGateAsks("composio_composio_multi_execute_tool", {}, cwd, ["composio_"])).toBe(true);
    expect(piGateAsks("memory_search", {}, cwd, ["composio_"])).toBe(false);
  });
  it("sends a file's path, not its contents, and drops an input too large to send", () => {
    expect(JSON.parse(piGateMessage("write", { path: "/x", content: "secret body" }))).toEqual({ tool: "write", input: { path: "/x" } });
    expect(JSON.parse(piGateMessage("composio_x", { blob: "a".repeat(PI_GATE_MESSAGE_MAX) }))).toEqual({ tool: "composio_x" });
  });
});

describe("the gate inside pi", () => {
  type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: { cwd: string; hasUI: boolean; ui: { confirm(t: string, m: string): Promise<boolean> } }) => Promise<unknown>;
  const load = (env: Record<string, string>) => {
    Object.assign(process.env, env);
    let handler: Handler | undefined;
    piPermissionGate({ on: (_event, h) => { handler = h as Handler; } });
    return handler;
  };
  afterEach(() => { delete process.env.MURAGE_PI_GATE; delete process.env.MURAGE_PI_GATE_PREFIXES; });

  it("does nothing without the driver's secret", () => {
    expect(load({})).toBeUndefined();
  });
  it("takes the secret out of the environment the tools inherit", () => {
    load({ MURAGE_PI_GATE: "s3cret", MURAGE_PI_GATE_PREFIXES: "[]" });
    expect(process.env.MURAGE_PI_GATE).toBeUndefined();
    expect(process.env.MURAGE_PI_GATE_PREFIXES).toBeUndefined();
  });
  it("asks with the secret, and blocks what the owner does not allow", async () => {
    const handler = load({ MURAGE_PI_GATE: "s3cret" })!;
    const asked: Array<[string, string]> = [];
    const ctx = (answer: boolean) => ({ cwd: "/w", hasUI: true, ui: { confirm: async (t: string, m: string) => { asked.push([t, m]); return answer; } } });
    expect(await handler({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, ctx(false))).toEqual({ block: true, reason: "The owner did not allow this in Murage." });
    expect(asked[0]).toEqual(["murage-gate:s3cret", JSON.stringify({ tool: "bash", input: { command: "rm -rf /tmp/x" } })]);
    expect(await handler({ toolName: "bash", input: { command: "ls" } }, ctx(true))).toBeUndefined();
    expect(await handler({ toolName: "read", input: { path: "/etc/hosts" } }, ctx(false))).toBeUndefined();
  });
  it("blocks rather than runs when there is nobody to ask", async () => {
    const handler = load({ MURAGE_PI_GATE: "s3cret" })!;
    expect(await handler({ toolName: "bash", input: { command: "ls" } }, { cwd: "/w", hasUI: false, ui: { confirm: async () => true } })).toMatchObject({ block: true });
  });
});
