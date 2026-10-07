import { describe, expect, it } from "vitest";
import { pid1ReaperWarning } from "./pid1-reaper-check.ts";

describe("pid1ReaperWarning", () => {
  for (const name of ["systemd", "init", "tini", "docker-init", "dumb-init", "s6-svscan", "runit", "catatonit", "supervisord", "launchd"]) {
    it(`stays quiet for ${name}`, () => {
      expect(pid1ReaperWarning("linux", 42, `${name}\n`)).toBeUndefined();
    });
  }
  it("warns when node is PID 1", () => {
    const w = pid1ReaperWarning("linux", 42, "node\n");
    expect(w).toContain("PID 1 (node) does not reap orphaned processes");
    expect(w).toContain("--init or tini");
  });
  it("warns when the server itself is PID 1, even under a reaping name", () => {
    expect(pid1ReaperWarning("linux", 1, "tini\n")).toContain("does not reap");
  });
  it("warns for an unknown comm", () => {
    expect(pid1ReaperWarning("linux", 42, "weirdinit")).toContain("PID 1 (weirdinit)");
  });
  it("is a no-op on macOS and Windows", () => {
    expect(pid1ReaperWarning("darwin", 1, undefined)).toBeUndefined();
    expect(pid1ReaperWarning("win32", 1, "node")).toBeUndefined();
  });
  it("warns as unknown when /proc is unreadable", () => {
    expect(pid1ReaperWarning("linux", 42, undefined)).toContain("PID 1 (unknown)");
  });
});
