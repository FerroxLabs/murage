// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bwrapProcessDeps, hostProcessGone, hostProcessIdentity, hostProcessIsChild, resolveBwrapProcesses } from "./bwrap-process.ts";

const root = { pid: 71001, start: "100" };
const init = { pid: 71002, start: "101" };
const engine = { pid: 71003, start: "102" };
const files = new Map<string, string>();
function stat(pid: number, ppid: number, start: string, state = "S") {
  // comm may itself contain spaces and parentheses; starttime is stat field 22.
  files.set(`/proc/${pid}/stat`, `${pid} (engine (worker)) ${[state, String(ppid), ...Array(17).fill("0"), start].join(" ")}`);
}
beforeEach(() => {
  files.clear();
  stat(root.pid, 70000, root.start);
  stat(init.pid, root.pid, init.start);
  stat(engine.pid, init.pid, engine.start);
  files.set(`/proc/${root.pid}/task/${root.pid}/children`, "");
  files.set(`/proc/${root.pid}/task/71009/children`, `${init.pid} `);
  files.set(`/proc/${init.pid}/task/${init.pid}/children`, `${engine.pid}\n`);
  vi.spyOn(bwrapProcessDeps, "tasks").mockImplementation(path => path === "/proc"
    ? ["self", "thread-self", String(root.pid), String(init.pid), String(engine.pid), "71004"]
    : path === `/proc/${root.pid}/task` ? [String(root.pid), "71009"] : [String(init.pid)]);
  vi.spyOn(bwrapProcessDeps, "read").mockImplementation(path => {
    const value = files.get(path);
    if (value === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return value;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("bwrap host process resolution", () => {
  it("walks every task's children through the namespace init and returns host identities", () => {
    expect(hostProcessIdentity(root.pid)).toEqual(root);
    expect(resolveBwrapProcesses(root)).toEqual({ init, engine });
    expect(bwrapProcessDeps.read).not.toHaveBeenCalledWith("/proc/2/stat");
  });
  it("deduplicates child PIDs reported by more than one task", () => {
    files.set(`/proc/${root.pid}/task/${root.pid}/children`, String(init.pid));
    expect(resolveBwrapProcesses(root)).toEqual({ init, engine });
  });
  it("retains the init when the engine has already exited", () => {
    files.delete(`/proc/${engine.pid}/stat`);
    expect(resolveBwrapProcesses(root)).toEqual({ init, engine: undefined });
  });
  it.each(["", "2", "71002 71004", "not-a-pid"])("falls back on an absent or ambiguous init: %s", children => {
    files.set(`/proc/${root.pid}/task/71009/children`, children);
    expect(resolveBwrapProcesses(root)).toEqual({});
  });
  it("does not select an orphan from an ambiguous init child list", () => {
    files.set(`/proc/${init.pid}/task/${init.pid}/children`, "71003 71004");
    expect(resolveBwrapProcesses(root)).toEqual({ init, engine: undefined });
  });
  it("rejects changed parentage and a reused wrapper PID", () => {
    stat(engine.pid, 70000, engine.start);
    expect(resolveBwrapProcesses(root).engine).toBeUndefined();
    stat(root.pid, 70000, "999");
    expect(resolveBwrapProcesses(root)).toEqual({});
  });
  it.each(["engine reused", "reparented", "init reused", "zombie", "missing", "unreadable"])("rechecks engine identity and pinned parent before TERM: %s", change => {
    expect(hostProcessIsChild(engine, init)).toBe(true);
    if (change === "engine reused") stat(engine.pid, init.pid, "999");
    if (change === "reparented") stat(engine.pid, root.pid, engine.start);
    if (change === "init reused") stat(init.pid, root.pid, "999");
    if (change === "zombie") stat(engine.pid, init.pid, engine.start, "Z");
    if (change === "missing") files.delete(`/proc/${engine.pid}/stat`);
    if (change === "unreadable") files.set(`/proc/${engine.pid}/stat`, "incomplete");
    expect(hostProcessIsChild(engine, init)).toBe(false);
  });
  it("scans stat parentage when task children files are unavailable", () => {
    for (const path of files.keys()) if (path.endsWith("/children")) files.delete(path);
    expect(resolveBwrapProcesses(root)).toEqual({ init, engine });
    expect(bwrapProcessDeps.tasks).toHaveBeenCalledWith("/proc");
  });
  it.each(["ambiguous", "reparented", "wrapper reused", "init reused during scan", "unreadable stat"])("keeps identity and ambiguity checks in the stat fallback: %s", change => {
    for (const path of files.keys()) if (path.endsWith("/children")) files.delete(path);
    if (change === "ambiguous") stat(71004, root.pid, "103");
    if (change === "reparented") stat(init.pid, 70000, init.start);
    if (change === "wrapper reused") stat(root.pid, 70000, "999");
    if (change === "unreadable stat") files.set("/proc/71004/stat", "incomplete");
    if (change === "init reused during scan") {
      const read = vi.mocked(bwrapProcessDeps.read).getMockImplementation()!;
      vi.mocked(bwrapProcessDeps.read).mockImplementation(path => {
        const value = read(path);
        if (path === `/proc/${init.pid}/stat`) stat(init.pid, root.pid, "999");
        return value;
      });
    }
    expect(resolveBwrapProcesses(root)).toEqual({});
  });
  it("handles tasks that exit during enumeration, and rejects unreadable observations", () => {
    files.delete(`/proc/${root.pid}/task/${root.pid}/children`);
    expect(resolveBwrapProcesses(root)).toEqual({ init, engine });
    vi.mocked(bwrapProcessDeps.read).mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(resolveBwrapProcesses(root)).toEqual({});
    expect(hostProcessGone(init)).toBe(false);
  });
  it("distinguishes a live init from a missing, replaced or zombie init", () => {
    expect(hostProcessGone(init)).toBe(false);
    stat(init.pid, root.pid, init.start, "Z");
    expect(hostProcessGone(init)).toBe(true);
    stat(init.pid, root.pid, "999");
    expect(hostProcessGone(init)).toBe(true);
    files.delete(`/proc/${init.pid}/stat`);
    expect(hostProcessGone(init)).toBe(true);
  });
  it("does not treat a malformed stat as proof of disappearance", () => {
    files.set(`/proc/${init.pid}/stat`, "incomplete");
    expect(hostProcessGone(init)).toBe(false);
    expect(resolveBwrapProcesses(root)).toEqual({});
  });
});
