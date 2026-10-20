// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 63 (inProjectCheck) and Rule 73a (walkRoot) on a real tree
// (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md, T86 and the pure
// rows of T77, T92, T101).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inProjectCheck, joinReal, placePath, realDir, realPathInOrder, WalkCache, walkRoot } from "./in-project.ts";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

let base: string;
let project: string;
let home: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "in-project-"))); // Windows CI: the long name of RUNNER~1, as the gate reads it
  project = join(base, "proj");
  home = join(base, "home");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_rsa"), "key");
  writeFileSync(join(home, "notes.txt"), "x");
  writeFileSync(join(project, "README.md"), "hi");
  writeFileSync(join(project, "src", "a.ts"), "a");
  writeFileSync(join(project, ".env"), "SECRET=1");
  writeFileSync(join(project, ".env.example"), "SECRET=");
});

afterEach(() => removeTempDirSync(base));

describe("placePath: real path, segment by segment (Rule 63 step 2)", () => {
  // Windows CI hands out an 8.3 temp folder (C:\Users\RUNNER~1\...): the root is read by its long real name, so every part of the
  // path must be too, or an in-project file is placed "outside" and `.env.example` loses its carve-out.
  it.runIf(process.platform === "win32")("places a path spelled with an 8.3 short name by its long real name", () => {
    const long = join(base, "a long folder name");
    mkdirSync(join(long, "src"), { recursive: true });
    writeFileSync(join(long, "src", "a.ts"), "a");
    const out = spawnSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", `for %I in ("${long}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true });
    const short = out.stdout.trim();
    if (!short || short.toLowerCase() === long.toLowerCase()) return; // no 8.3 names on this volume
    for (const root of [long, short]) {
      for (const path of [join(short, "src", "a.ts"), join(long, "src", "a.ts"), join(short, "src", "new.ts"), join(short, ".env.example")]) {
        expect(placePath(path, root), `${path} in ${root}`).toMatchObject({ kind: "inside" });
      }
      expect(inProjectCheck(join(short, ".env.example"), root, "PORT=1")).toMatchObject({ ok: true });
      expect(inProjectCheck(join(short, ".env"), root, "K=1")).toMatchObject({ ok: false, reason: "sensitive" });
    }
  });

  it("places an ordinary in-project file, and a file about to be written", () => {
    expect(placePath("README.md", project)).toMatchObject({ kind: "inside", real: join(project, "README.md") });
    expect(placePath("src/new/file.ts", project)).toMatchObject({ kind: "inside", real: join(project, "src", "new", "file.ts") });
    expect(placePath(join(project, "src", "a.ts"), project)).toMatchObject({ kind: "inside" });
  });

  it("a symlink inside the project that points out is outside, and `..` climbs from the link's target", () => {
    symlinkSync(join(home, ".ssh"), join(project, "link"));
    expect(placePath("link/id_rsa", project)).toMatchObject({ kind: "outside", real: join(home, ".ssh", "id_rsa") });
    // link/../notes.txt climbs from ~/.ssh, so it is ~/notes.txt: outside
    expect(placePath("link/../notes.txt", project)).toMatchObject({ kind: "outside", real: join(home, "notes.txt") });
    // a lexical collapse would have said proj/notes.txt
  });

  it("a symlink loop, a NUL byte, a climb past a missing folder and a drive-relative path cannot be placed", () => {
    symlinkSync(join(project, "loop-b"), join(project, "loop-a"));
    symlinkSync(join(project, "loop-a"), join(project, "loop-b"));
    expect(placePath("loop-a/x", project)).toMatchObject({ kind: "cannot-place" });
    expect(placePath("a\u0000b", project)).toMatchObject({ kind: "cannot-place" });
    expect(placePath("missing/../../x", project)).toMatchObject({ kind: "cannot-place" });
    expect(placePath("C:foo", project, { platform: "win32" })).toMatchObject({ kind: "cannot-place" });
    expect(placePath("\\foo", project, { platform: "win32" })).toMatchObject({ kind: "cannot-place" });
  });

  it("a home path is placed only with the home given", () => {
    expect(placePath("~/.ssh/id_rsa", project)).toMatchObject({ kind: "cannot-place" });
    expect(placePath("~/.ssh/id_rsa", project, { home })).toMatchObject({ kind: "outside" });
    expect(placePath("~other/x", project, { home })).toMatchObject({ kind: "cannot-place" });
  });

  // Astra BLOCK 3: a home path is joined as written, so `~/link/..` climbs from the link's target
  it("never collapses `..` in a home path before the link resolves", () => {
    symlinkSync(join(home, ".ssh"), join(project, "link"));
    // with the project as the home, ~/link/../notes.txt is lexically proj/notes.txt (inside) and really home/notes.txt (outside)
    expect(placePath("~/link/../notes.txt", project, { home: project })).toMatchObject({ kind: "outside", real: join(home, "notes.txt") });
    expect(placePath("~", project, { home: project })).toMatchObject({ kind: "inside" });
  });
});

describe("inProjectCheck (Rule 63 steps 2, 3, 5)", () => {
  it("passes an ordinary in-project read and an ordinary write", () => {
    expect(inProjectCheck("README.md", project)).toEqual({ ok: true, real: join(project, "README.md") });
    expect(inProjectCheck("src/b.ts", project, "export const b = 1;")).toMatchObject({ ok: true });
  });

  it("holds the sensitive rows inside the project too, with the template carve-out", () => {
    expect(inProjectCheck(".env", project)).toMatchObject({ ok: false, reason: "sensitive", rule: "env" });
    expect(inProjectCheck("./.env", project)).toMatchObject({ ok: false, reason: "sensitive" });
    expect(inProjectCheck(".env.example", project)).toMatchObject({ ok: true });
    for (const path of [".env.local", ".env.production", ".envrc", ".git/config", ".git/hooks/pre-commit", ".claude/settings.local.json", ".vscode/tasks.json", ".husky/pre-push", "node_modules/.bin/vitest"]) {
      expect(inProjectCheck(path, project), path).toMatchObject({ ok: false, reason: "sensitive" });
    }
  });

  it("a symlink to a key file is sensitive by its real path, whatever its own name", () => {
    symlinkSync(join(home, ".ssh", "id_rsa"), join(project, "docs.png"));
    expect(inProjectCheck("docs.png", project)).toMatchObject({ ok: false, reason: "sensitive", rule: "ssh" });
  });

  it("outside the project asks; the template carve-out does not apply there", () => {
    expect(inProjectCheck(join(home, "notes.txt"), project)).toMatchObject({ ok: false, reason: "outside" });
    writeFileSync(join(home, ".env.example"), "x");
    expect(inProjectCheck(join(home, ".env.example"), project)).toMatchObject({ ok: false, reason: "sensitive" });
  });

  // Astra BLOCK 4 (Rule 64): a template file's body is read by the secret-shape rules
  it("a real secret in an in-project template file's body is sensitive; a placeholder is ordinary", () => {
    const key = ["sk", "ant", "api03", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3"].join("-");
    expect(inProjectCheck(".env.example", project, "ANTHROPIC_API_KEY=\n")).toMatchObject({ ok: true });
    expect(inProjectCheck(".env.example", project, `ANTHROPIC_API_KEY=${key}\n`)).toMatchObject({ ok: false, reason: "sensitive", rule: "key-literal" });
    expect(inProjectCheck(".env.template", project, "-----BEGIN RSA PRIVATE KEY-----\nabc")).toMatchObject({ ok: false, reason: "sensitive", rule: "private-key" });
    expect(inProjectCheck(".env.dist", project, "CARD=4242 4242 4242 4242")).toMatchObject({ ok: false, reason: "sensitive", rule: "card-number" });
    expect(inProjectCheck(".env.dist", project, "PORT=4242424242424241")).toMatchObject({ ok: true });
    // an ordinary file's body is the bot's own work and is not scanned here
    expect(inProjectCheck("src/config.ts", project, `const k = "${key}"`)).toMatchObject({ ok: true });
  });

  it("a content it cannot read whole is unread", () => {
    expect(inProjectCheck("src/b.ts", project, { not: "text" })).toMatchObject({ ok: false, reason: "unread" });
    expect(inProjectCheck("src/b.ts", project, "x".repeat(16 * 1024 * 1024 + 1))).toMatchObject({ ok: false, reason: "unread" });
  });
});

describe("walkRoot (Rule 73a)", () => {
  it("finds every sensitive entry; a sensitive directory is one hit and is not descended", () => {
    mkdirSync(join(project, ".git", "hooks"), { recursive: true });
    writeFileSync(join(project, ".git", "config"), "[core]");
    mkdirSync(join(project, "deep", "er"), { recursive: true });
    writeFileSync(join(project, "deep", "er", ".env"), "x");
    const result = walkRoot(".", project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.hits.map((hit) => hit.path).sort();
    expect(paths).toEqual([".env", ".git", "deep/er/.env"]);
    expect(result.hits.find((hit) => hit.path === ".git")).toMatchObject({ dir: true });
    expect(result.unwalked).toEqual([]);
  });

  it("a symlink inside the project to a key file is a hit; a link to a folder outside is not walked", () => {
    symlinkSync(join(home, ".ssh", "id_rsa"), join(project, "src", "key"));
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(project, "out"));
    const result = walkRoot(".", project);
    if (!result.ok) throw new Error("walk failed");
    expect(result.hits.map((hit) => hit.path)).toContain("src/key");
    expect(result.unwalked).toContain("out");
  });

  it("a clean root has no hit", () => {
    rmSync(join(project, ".env"));
    const result = walkRoot("src", project);
    expect(result).toEqual({ ok: true, hits: [], unwalked: [] });
  });

  it("the bound leaves what it did not finish in unwalked, breadth-first", () => {
    mkdirSync(join(project, "node_modules", "pkg"), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(project, "node_modules", "pkg", `f${i}.js`), "");
    const result = walkRoot(".", project, { maxEntries: 8 });
    if (!result.ok) throw new Error("walk failed");
    expect(result.unwalked.length).toBeGreaterThan(0);
    expect(result.unwalked.some((dir) => dir.startsWith("node_modules"))).toBe(true);
  });

  it("a root that cannot be read at all is not ok", () => {
    expect(walkRoot("no-such-dir", project).ok).toBe(false);
  });

  it("caches per (turn, root) for a while and drops on an approved write under the root", () => {
    let now = 0;
    const cache = new WalkCache(() => now, 10_000);
    const result = walkRoot(".", project);
    cache.set("t1", project, result);
    expect(cache.get("t1", project)).toBe(result);
    expect(cache.get("t2", project)).toBeUndefined();
    now = 10_001;
    expect(cache.get("t1", project)).toBeUndefined();
    now = 0;
    cache.set("t1", project, result);
    cache.invalidateWrite(join(project, "src", "a.ts"));
    expect(cache.get("t1", project)).toBeUndefined();
  });
});

// APP-GRANT-FIXPLAN-r6 (b): the one resolver, its two mints and the one joining API (Rules 63.2, 63.3, 75d)
describe("realPathInOrder, realDir and joinReal", () => {
  it("returns the real path with every intermediate, so the key guard still sees a climb through ~/.ssh", () => {
    symlinkSync(join(home, ".ssh"), join(project, "link"));
    expect(realPathInOrder("link/../notes.txt", project)).toEqual({ real: join(home, "notes.txt"), intermediates: [join(home, ".ssh"), home, join(home, "notes.txt")] });
    expect(realPathInOrder("~/.ssh/../notes.txt", project, { home })).toMatchObject({ real: join(home, "notes.txt"), intermediates: expect.arrayContaining([join(home, ".ssh")]) });
    expect(inProjectCheck("~/.ssh/../notes.txt", project, undefined, { home })).toMatchObject({ ok: false, reason: "sensitive", rule: "ssh" });
  });

  it("keeps a missing tail as written in the default mode, and refuses it in must-exist mode", () => {
    expect(realPathInOrder("src/new/file.ts", project)).toMatchObject({ real: join(project, "src", "new", "file.ts") });
    expect(realPathInOrder("missing/../x", project)).toMatchObject({ cannot: expect.any(String) });
    expect(realPathInOrder("nope", project, { mustExist: true })).toEqual({ cannot: "missing" });
    expect(realPathInOrder("gone/a/b", project, { mustExist: true })).toEqual({ cannot: "missing" });
    expect(realPathInOrder("src/a.ts", project, { mustExist: true })).toMatchObject({ real: join(project, "src", "a.ts") });
  });

  it("places a relative path from a folder that does not exist yet as written, and never climbs out of one", () => {
    expect(realPathInOrder("a.md", join(base, "work"))).toMatchObject({ real: join(base, "work", "a.md") });
    expect(realPathInOrder("../a.md", join(base, "work"))).toMatchObject({ cannot: expect.any(String) });
    expect(realPathInOrder("a.md", "relative/base")).toMatchObject({ cannot: expect.any(String) });
  });

  it("realDir resolves the whole path in order and needs a folder; joinReal takes one name per part", () => {
    symlinkSync(join(home, ".ssh"), join(project, "link"));
    // written out, not joined: path.join would collapse the `..` before the link is read
    expect(realDir(`${project}/link/..`)).toBe(home);
    expect(realDir(join(project, "README.md"))).toBeNull();
    expect(realDir(join(project, "none"))).toBeNull();
    const dir = realDir(project)!;
    expect(joinReal(dir, "src", "a.ts")).toEqual({ path: join(project, "src", "a.ts") });
    for (const bad of ["a/b", "a\\b", "..", ".", "", "a\u0000b"]) expect(joinReal(dir, bad), bad).toMatchObject({ cannot: expect.any(String) });
  });
});
