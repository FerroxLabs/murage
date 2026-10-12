// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// pi bot turns load Murage's own extensions and none of the owner's personal pi setup
// (pi.ts PI_ISOLATION_FLAGS, piIsolationArgs). Synthetic owner home only.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { PiDriver, piIsolationArgs, piProjectContextFiles } from "./pi.ts";
import { ScopeUnavailableError } from "./scoped-cli-home.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-pi-cli.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** An owner home with a personal AGENTS.md at home level and a project two levels down. */
function layout() {
  const root = mkdtempSync(join(tmpdir(), "murage-pi-iso-"));
  dirs.push(root);
  const home = join(root, "home"), project = join(home, "Documents", "proj"), sub = join(project, "pkg");
  mkdirSync(sub, { recursive: true });
  mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), "PERSONAL GLOBAL");
  writeFileSync(join(home, ".pi", "agent", "extensions", "personal.ts"), "export default () => {}");
  writeFileSync(join(home, "AGENTS.md"), "PERSONAL HOME");
  writeFileSync(join(root, "CLAUDE.md"), "ABOVE HOME");
  writeFileSync(join(project, "AGENTS.md"), "PROJECT");
  writeFileSync(join(sub, "CLAUDE.md"), "PACKAGE");
  return { root, home, project, sub };
}

describe("pi personal setup isolation", () => {
  it("passes every discovery switch from the first pi that has them all, and rejects an unknown or older pi (update-required)", () => {
    for (const version of ["", undefined, "pi 0.38.0", "0.47.2", "0.50.0", "0.67.3"]) {
      let error: unknown = null;
      try { piIsolationArgs(version, undefined, "/h"); } catch (e) { error = e; }
      expect(error, String(version)).toBeInstanceOf(ScopeUnavailableError);
      expect((error as ScopeUnavailableError).code).toBe("update-required");
      expect((error as ScopeUnavailableError).engine).toBe("Pi");
    }
    expect(piIsolationArgs("0.67.4", undefined, "/h")).toEqual(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]);
    expect(piIsolationArgs("0.73.1", undefined, "/h")).toEqual(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]);
  });

  it("hands back the project's own context files, never the owner's home or global ones", () => {
    const { root, home, project, sub } = layout();
    expect(piProjectContextFiles(sub, home)).toEqual([join(project, "AGENTS.md"), join(sub, "CLAUDE.md")]);
    expect(piProjectContextFiles(home, home)).toEqual([]);
    // a folder outside home keeps pi's own walk to the root
    expect(piProjectContextFiles(root, join(root, "elsewhere"))).toEqual([join(root, "CLAUDE.md")]);
    expect(piIsolationArgs("0.73.1", sub, home).slice(5)).toEqual(
      ["--append-system-prompt", join(project, "AGENTS.md"), "--append-system-prompt", join(sub, "CLAUDE.md")]);
  });

  it("spawns a bot turn with Murage's extensions and servers and none of the owner's setup", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const { home, project, sub } = layout();
    const dump = join(home, "dump.jsonl");
    const instance = await PiDriver.create({ instanceId: "pi-iso", displayName: "pi", enabled: true,
      environment: { HOME: home, USERPROFILE: home, FAKE_PI_DUMP: dump }, config: { cli: FAKE_CLI, fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "pi-iso-1", text: "hi", cwd: sub,
        integrations: { memory: { command: "node", args: ["memory-proxy.js"], env: {} } } });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      const rows = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; mcpConfig?: { mcpServers?: Record<string, unknown> } | null });
      const turnRow = rows.find((row) => row.mcpConfig != null)!;
      expect(turnRow).toBeTruthy();
      for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]) expect(turnRow.argv).toContain(flag);
      // Murage's own extensions still ride -e, after the switches
      const ext = turnRow.argv.indexOf("-e");
      expect(turnRow.argv[ext + 1]).toContain("pi-mcp-extension");
      expect(ext).toBeGreaterThan(turnRow.argv.indexOf("--no-extensions"));
      expect(Object.keys(turnRow.mcpConfig!.mcpServers!)).toContain("murage-memory");
      const appended = turnRow.argv.flatMap((arg, i) => turnRow.argv[i - 1] === "--append-system-prompt" ? [arg] : []);
      expect(appended).toEqual([join(project, "AGENTS.md"), join(sub, "CLAUDE.md")]);
      expect(JSON.stringify(turnRow.argv)).not.toMatch(/PERSONAL|personal\.ts|\.pi[/\\]agent/);
    } finally { recorder.stop(); await instance.dispose(); }
  }, 30000);
});
