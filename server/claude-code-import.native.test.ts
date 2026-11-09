// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Claude Code copy import on Windows (CONTRACTS-B 1.3 tests 8a, 8a2, 8b, 8c, 8d): the REAL native helper from dist-native
// (the engine-exclusion addon, anchored-win.c), driven by junction races and pins on a real Windows file system.
// Runs only on win32. With CI set it FAILS, never skips, if the addon lacks anchorBegin.
//
// Test notes (known bounds, not bugs): a non-cancellable filter wait can keep ONE stalled call's pins past the budget (R16, one per
// process by R21); WOF-compressed (CompactOS) files and cloud placeholders such as OneDrive are refused as reparse points (R10),
// and a profile folder reached through a junction is refused (R18). Not covered here: a held folder opened by another program with
// DELETE access (Node cannot open one); native/engine-exclusion/anchored-win.node-test.mjs covers the sharing rules directly.
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleClaudeCodeImport, resetClaudeCodeImportState, realImportFs, type ImportDeps, type ImportFs } from "./claude-code-import.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";

const onWindows = process.platform === "win32";
const addon = (onWindows ? loadExclusionAddon() : null) as unknown as Record<string, (...args: unknown[]) => unknown> | null;
const haveHelper = typeof addon?.anchorBegin === "function";
const CANARY = "CANARY-do-not-import-9f3a";

let home: string;
let outside: string;

function skill(name: string, extra: Record<string, string> = {}) {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name.toLowerCase()}\ndescription: Does ${name}\n---\nBody for ${name}.\n`);
  for (const [file, content] of Object.entries(extra)) writeFileSync(join(dir, file), content);
}

function world() {
  const skills = new Map<string, Array<{ path: string; content: string }>>();
  const mcp: Record<string, unknown> = {};
  const receipt: unknown[] = [];
  const deps: ImportDeps = {
    existingSkillNames: () => new Set(skills.keys()),
    skillPathExists: (name) => skills.has(name),
    addSkill: (files) => {
      const name = /name:\s*(\S+)/.exec(files.find((f) => f.path === "SKILL.md")!.content)?.[1] ?? "";
      skills.set(name, files);
      return { name };
    },
    removeSkill: (name) => { skills.delete(name); },
    mcpCurrent: () => ({ ...mcp }),
    persistMcp: (next) => { Object.assign(mcp, next); },
    writeReceipt: (r) => { receipt.push(r); },
    restoreReceipt: () => { receipt.length = 0; },
  };
  return { skills, mcp, receipt, deps };
}

/** The addon with a hook that runs immediately before and after each anchorOpen (CONTRACTS-B 1.3 tests). */
function hooked(before?: (name: string) => void, after?: (name: string) => void) {
  const real = addon!;
  const opens: string[] = [];
  const anchor = {
    ...real,
    anchorOpen: (parent: unknown, name: string, want: string) => {
      opens.push(name);
      before?.(name);
      try { return real.anchorOpen!(parent, name, want); } finally { after?.(name); }
    },
  };
  const fs = { ...realImportFs, platform: () => "win32", winAnchor: () => anchor } as unknown as ImportFs;
  return { fs, opens };
}

const run = (body: unknown, deps: ImportDeps, fs: ImportFs) =>
  handleClaudeCodeImport({ body, enabled: true, home, deps, ownerToken: "desktop-session-a", fs });

function everything(...values: unknown[]): string { return JSON.stringify(values, (_k, v) => (typeof v === "bigint" ? v.toString() : v)); }

beforeEach(() => {
  resetClaudeCodeImportState();
  home = realpathSync(mkdtempSync(join(tmpdir(), "cci-win-home-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "cci-win-out-")));
  writeFileSync(join(outside, "SKILL.md"), `---\nname: canary\ndescription: ${CANARY}\n---\n${CANARY}\n`);
  writeFileSync(join(outside, "secret.md"), CANARY);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe.skipIf(!onWindows)("the Windows native helper is present", () => {
  it("exports anchorBegin (fails, never skips, on a CI Windows runner)", () => {
    if (process.env.CI) expect(haveHelper).toBe(true);
  });
});

describe.skipIf(!onWindows || (!haveHelper && !process.env.CI))("Windows anchored import against the real helper", () => {
  it("imports an untouched skill and a server with no race (positive control)", () => {
    skill("Beta", { "notes.md": "beta notes" });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { plain: { command: "uvx", args: ["reviewed-tool"] } } }));
    const { skills, deps } = world();
    const { fs } = hooked();
    const dry = run({ scope: "both", dryRun: true }, deps, fs);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ skills: [{ name: "Beta" }], servers: [{ name: "plain" }], skipped: [] });
    const done = run({ scope: "both", dryRun: false, dryRunId: (dry.body as { dryRunId: string }).dryRunId }, deps, fs);
    expect(done.status).toBe(201);
    expect(skills.get("beta")?.find((f) => f.path === "notes.md")?.content).toBe("beta notes");
  });

  it("8a: a junction swapped in for a skill folder at its open is never read", () => {
    skill("Alpha");
    skill("Beta", { "notes.md": "beta notes" });
    const alpha = join(home, ".claude", "skills", "Alpha");
    const saved = join(home, ".claude", "Alpha-original");
    let swapped = false;
    let sawJunction = false;
    const { fs } = hooked(
      (name) => {
        if (name !== "Alpha") return;
        renameSync(alpha, saved);
        symlinkSync(outside, alpha, "junction");
        swapped = true;
        sawJunction = lstatSync(alpha).isSymbolicLink();
      },
      (name) => {
        if (name !== "Alpha" || !swapped) return;
        rmdirSync(alpha);
        renameSync(saved, alpha);
      },
    );
    const { skills, deps } = world();
    const dry = run({ scope: "skills", dryRun: true }, deps, fs);
    expect(swapped).toBe(true);
    expect(sawJunction).toBe(true);
    expect(dry.status).toBe(200);
    const body = dry.body as { skills: Array<{ name: string }>; skipped: string[] };
    expect(body.skills.map((s) => s.name)).toEqual(["Beta"]);
    expect(body.skipped.every((n) => n === "(could not read)")).toBe(true);
    const done = run({ scope: "skills", dryRun: false, dryRunId: (dry.body as { dryRunId: string }).dryRunId }, deps, fs);
    expect(everything(dry, done, [...skills.values()])).not.toContain(CANARY);
    expect([...skills.keys()]).toEqual(["beta"]);
  });

  it("8a2: an identity-preserving swap (rename to Saved, junction back, retarget after the open) opens the junction itself and is refused", () => {
    skill("Alpha");
    skill("Beta", { "notes.md": "beta notes" });
    const alpha = join(home, ".claude", "skills", "Alpha");
    const saved = join(home, ".claude", "skills", "Saved");
    let ran = false;
    const { fs } = hooked(
      (name) => {
        if (name !== "Alpha") return;
        renameSync(alpha, saved);
        symlinkSync(saved, alpha, "junction");
        ran = true;
      },
      (name) => {
        if (name !== "Alpha" || !ran) return;
        rmdirSync(alpha);
        symlinkSync(outside, alpha, "junction");
      },
    );
    const { skills, deps } = world();
    const dry = run({ scope: "skills", dryRun: true }, deps, fs);
    expect(ran).toBe(true);
    expect(dry.status).toBe(200);
    const body = dry.body as { skills: Array<{ name: string }>; skipped: string[] };
    expect(body.skills.map((s) => s.name)).toContain("Beta");
    expect(body.skills.map((s) => s.name)).not.toContain("Alpha");
    expect(everything(dry, [...skills.values()])).not.toContain(CANARY);
  });

  it("8b: a held folder cannot be renamed, removed or replaced while the request runs, and can be afterwards", () => {
    skill("Beta", { "notes.md": "beta notes" });
    mkdirSync(join(home, ".claude", "skills", "Empty"));
    const skillsDir = join(home, ".claude", "skills");
    const codes: string[] = [];
    const attempt = (action: () => void) => {
      try { action(); codes.push("none"); } catch (error) { codes.push((error as NodeJS.ErrnoException).code ?? "?"); }
    };
    let hookRuns = 0;
    let emptyRuns = 0;
    const { fs } = hooked(undefined, (name) => {
      if (name === "skills") {
        hookRuns++;
        attempt(() => renameSync(skillsDir, `${skillsDir}2`));
        attempt(() => renameSync(join(home, ".claude"), join(home, ".claude2")));
      }
      if (name === "Empty") {
        emptyRuns++;
        attempt(() => rmdirSync(join(skillsDir, "Empty")));
        attempt(() => renameSync(join(skillsDir, "Empty"), join(skillsDir, "Empty2")));
      }
    });
    const { deps } = world();
    const dry = run({ scope: "skills", dryRun: true }, deps, fs);
    expect(hookRuns).toBe(1);
    expect(emptyRuns).toBe(1);
    expect(codes).toHaveLength(4);
    for (const code of codes) expect(["EBUSY", "EPERM", "EACCES"]).toContain(code);
    expect((dry.body as { skills: Array<{ name: string }> }).skills.map((s) => s.name)).toEqual(["Beta"]);
    // the pins are released with the request
    renameSync(skillsDir, `${skillsDir}2`);
    expect(lstatSync(`${skillsDir}2`).isDirectory()).toBe(true);
  });

  it("8c: static junctions, links and hardlinks are refused; each ancestor case is its own request next to a clean one", () => {
    skill("Beta", { "notes.md": "beta notes" });
    const clean = () => {
      const { deps } = world();
      const { fs } = hooked();
      const dry = run({ scope: "skills", dryRun: true }, deps, fs);
      expect(dry.status).toBe(200);
      expect((dry.body as { skills: Array<{ name: string }> }).skills.map((s) => s.name)).toContain("Beta");
    };
    const skillsDir = join(home, ".claude", "skills");
    // a junction as ~/.claude/skills: refused as a whole
    renameSync(skillsDir, join(home, ".claude", "skills-real"));
    symlinkSync(outside, skillsDir, "junction");
    {
      const { deps } = world();
      const { fs } = hooked();
      const refused = run({ scope: "skills", dryRun: true }, deps, fs);
      expect(refused.status).toBe(422);
      expect(everything(refused)).not.toContain(CANARY);
    }
    rmdirSync(skillsDir);
    renameSync(join(home, ".claude", "skills-real"), skillsDir);
    clean();
    // ~/.claude itself a junction: the "reached through a link" copy
    const dotClaude = join(home, ".claude");
    renameSync(dotClaude, join(home, "claude-real"));
    symlinkSync(join(home, "claude-real"), dotClaude, "junction");
    {
      const { deps } = world();
      const { fs } = hooked();
      const linked = run({ scope: "skills", dryRun: true }, deps, fs);
      expect(linked.status).toBe(422);
      expect(linked.body).toEqual({ code: "source-linked", error: "Claude Code files are reached through a link, so Murage did not read them." });
    }
    rmdirSync(dotClaude);
    renameSync(join(home, "claude-real"), dotClaude);
    clean();
    // a junction and a directory symlink as skill folders, a file symlink as SKILL.md, a hardlinked notes.md
    symlinkSync(outside, join(skillsDir, "Junction"), "junction");
    symlinkSync(outside, join(skillsDir, "DirLink"), "dir");
    skill("FileLink");
    rmSync(join(skillsDir, "FileLink", "SKILL.md"));
    symlinkSync(join(outside, "SKILL.md"), join(skillsDir, "FileLink", "SKILL.md"), "file");
    skill("HardLink");
    linkSync(join(outside, "secret.md"), join(skillsDir, "HardLink", "notes.md"));
    const { skills, deps } = world();
    const { fs } = hooked();
    const dry = run({ scope: "skills", dryRun: true }, deps, fs);
    expect(dry.status).toBe(200);
    const body = dry.body as { skills: Array<{ name: string }>; skipped: string[] };
    expect(body.skills.map((s) => s.name)).toEqual(["Beta"]);
    expect(body.skipped).toEqual(["FileLink", "HardLink", "(could not read)"]);
    expect(body.skipped.filter((n) => n === "(could not read)")).toHaveLength(1);
    run({ scope: "skills", dryRun: false, dryRunId: (dry.body as { dryRunId: string }).dryRunId }, deps, fs);
    expect(everything(dry, [...skills.values()])).not.toContain(CANARY);
    expect(everything(dry)).not.toMatch(/Junction|DirLink/);
  });

  it("8d: a skill file another handle holds open for writing makes that skill 'Alpha' (named), within the budget; Beta imports", () => {
    skill("Alpha");
    skill("Beta", { "notes.md": "beta notes" });
    const writer = openSync(join(home, ".claude", "skills", "Alpha", "SKILL.md"), "r+");
    const started = Date.now();
    try {
      const { deps } = world();
      const { fs } = hooked();
      const dry = run({ scope: "skills", dryRun: true }, deps, fs);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(dry.status).toBe(200);
      const body = dry.body as { skills: Array<{ name: string }>; skipped: string[] };
      expect(body.skills.map((s) => s.name)).toEqual(["Beta"]);
      expect(body.skipped).toEqual(["Alpha"]);
    } finally { closeSync(writer); }
  });
});
