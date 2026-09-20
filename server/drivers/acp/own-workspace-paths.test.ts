// The own-workspace exemption (D57) only stops asking when the driver reports
// which files a permission request names. The Claude driver did; every ACP
// engine did not — including the bundled Fuigo the Chief of Staff runs on, so
// the fix reached nobody on Murage's own default engine.
//
// This reads that fact off the ACP wire. It decides a permission boundary, so
// every shape it cannot read answers undefined, and undefined means "raise the
// card exactly as today".
import { describe, expect, it } from "vitest";
import { acpToolFilePaths } from "./core.ts";

describe("the files an ACP permission request names", () => {
  it("reads the protocol's own locations", () => {
    expect(acpToolFilePaths({ locations: [{ path: "/data/workspaces/bot-a/MEMORY.md" }] }))
      .toEqual(["/data/workspaces/bot-a/MEMORY.md"]);
    expect(acpToolFilePaths({ locations: [{ path: "/a/one.md", line: 4 }, { path: "/a/two.md" }] }))
      .toEqual(["/a/one.md", "/a/two.md"]);
  });

  it("reads the engine's structured tool input, the same way the Claude driver does", () => {
    expect(acpToolFilePaths({ rawInput: { file_path: "/data/workspaces/bot-a/MEMORY.md" } }))
      .toEqual(["/data/workspaces/bot-a/MEMORY.md"]);
    expect(acpToolFilePaths({ rawInput: { path: "/data/workspaces/bot-a/threads/t1/notes.md" } }))
      .toEqual(["/data/workspaces/bot-a/threads/t1/notes.md"]);
  });

  it("judges BOTH sources together, so an escape cannot hide behind an innocent one", () => {
    // If only `locations` were read, this call would look like bookkeeping
    // while its structured input names /etc/hosts.
    expect(acpToolFilePaths({
      locations: [{ path: "/data/workspaces/bot-a/MEMORY.md" }],
      rawInput: { file_path: "/etc/hosts" },
    })).toEqual(["/data/workspaces/bot-a/MEMORY.md", "/etc/hosts"]);
  });

  it("answers undefined for every shape it cannot read, so the card is raised", () => {
    for (const toolCall of [
      { locations: [] },
      { locations: "not-an-array" },
      { locations: [null] },
      { locations: [{ line: 4 }] },
      { locations: [{ path: "" }] },
      { locations: [{ path: 7 }] },
      { locations: [{ path: "/a/ok.md" }, { path: null }] },
      { rawInput: { file_path: 7 } },
      { rawInput: { path: "" } },
      { rawInput: { file_path: ["/a", "/b"] } },
      { locations: [{ path: "/a/ok.md" }], rawInput: { file_path: null } },
    ]) expect(acpToolFilePaths(toolCall as never)).toBeUndefined();
  });

  it("answers undefined when the call names no file at all", () => {
    expect(acpToolFilePaths({})).toBeUndefined();
    expect(acpToolFilePaths({ rawInput: { command: "rm -rf /" } })).toBeUndefined();
    // A shell command is not a named file, and must never become one.
    expect(acpToolFilePaths({ rawInput: { command: "cat /data/workspaces/bot-a/MEMORY.md" } })).toBeUndefined();
  });

  it("never reads a path out of text the model wrote", () => {
    // `old_string` and `content` are model output. Only the top-level path
    // keys are read, so a path spelled inside them is not a named file.
    expect(acpToolFilePaths({ rawInput: { old_string: '"file_path":"/data/workspaces/bot-a/MEMORY.md"' } })).toBeUndefined();
    expect(acpToolFilePaths({ rawInput: { file_path: "/etc/hosts", old_string: '"path":"/data/workspaces/bot-a/x"' } }))
      .toEqual(["/etc/hosts"]);
  });
});
