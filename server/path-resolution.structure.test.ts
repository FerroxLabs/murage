// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Path resolution on approval paths, structurally
// (lanes/release103/APP-GRANT-FIXPLAN-r6.md section (b); Rules 63.2, 63.3, 67
// and 75d). A path an approval reads is placed by shared/in-project.ts only:
// `realPathInOrder` and `realDir` resolve each part in order and are the only
// code that mints a RealPath, and `joinReal` is the one way to add a name to
// one. Anywhere else in the approval modules, a node:path `join`, `resolve` or
// `normalize` call, or a `catch` that hands back the path or root it could not
// resolve, is a bypass and fails here. A new module on an approval path joins
// APPROVAL_PATH_MODULES in the same commit.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repo, file), "utf8");

/** A region starts at the line holding `from` and ends at `to`, or at the
 * first line that closes a top-level declaration. */
interface Region { from: string; to?: string }
interface Module { file: string; regions?: readonly Region[]; why?: string }

/** The approval modules (r3's list, the index.ts stop-line block and
 * server/stop-line-state.ts). A module that also builds Murage's own file
 * names (its settings, its hook files, its temp folders) is read over its
 * approval regions, each named by a marker that must exist. */
export const APPROVAL_PATH_MODULES: readonly Module[] = [
  { file: "server/drivers/codex-hook.ts", why: "the hook's own files are written beside it", regions: [
    { from: "const sameDestinations =" }, { from: "export function routeDelivery(" }, { from: "export class HookDecisionTable" },
  ] },
  { file: "server/drivers/codex.ts" },
  { file: "server/drivers/claude.ts", why: "Claude's own settings files are named in the rest", regions: [{ from: "export function claudeGitRoots(" }] },
  { file: "server/drivers/pi-permission-gate.ts" },
  { file: "server/drivers/acp/core.ts" },
  { file: "server/stop-line.ts" },
  { file: "server/auto-approve.ts" },
  { file: "server/contracts.ts" },
  { file: "server/drivers/contracts.ts" },
  { file: "server/own-workspace-approval.ts" },
  { file: "server/permission-proxy.ts" },
  { file: "shared/disk-facts.ts" },
  { file: "shared/readonly-shell.ts" },
  { file: "server/stop-line-state.ts" },
  { file: "server/index.ts", why: "the stop-line block only", regions: [
    { from: "// ── the stop line (server/stop-line.ts)", to: "/** The stop line's verdict on one permission request" },
  ] },
];

const INLINE_BEGIN = "// @inline begin shared/in-project.ts\n";
const INLINE_END = "\n// @inline end shared/in-project.ts";

/** Code with comments and the text of quoted strings taken out, so a word in
 * a message or a comment is never read as a call. Template text stays. */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, "\"\"").replace(/\/\/.*$/, ""))
    .join("\n");
}

/** The node:path names a module can call: functions imported by name (with
 * their local alias) and namespaces (`posix`, `win32`, `* as path`, and a
 * local picked from them, such as `const p = ... ? win32 : posix`). */
function pathNames(source: string): { fns: Set<string>; ns: Set<string> } {
  const fns = new Set<string>();
  const ns = new Set<string>();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(?:node:)?path"/g)) {
    for (const spec of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [name, alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (["join", "resolve", "normalize"].includes(name!)) fns.add(alias ?? name!);
      if (["posix", "win32"].includes(name!)) ns.add(alias ?? name!);
    }
  }
  for (const m of source.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*"(?:node:)?path"/g)) ns.add(m[1]!);
  for (const m of source.matchAll(/\b(?:const|let)\s+(\w+)\s*(?::[^=]+)?=([^;\n]*)/g)) {
    if ([...ns].some((n) => new RegExp(`\\b${n}\\b`).test(m[2]!)) && !/\(/.test(m[2]!.replace(/\b\w+\.(isAbsolute|sep)\b/g, ""))) ns.add(m[1]!);
  }
  return { fns, ns };
}

function regionsOf(file: string, source: string, regions?: readonly Region[]): { start: number; text: string }[] {
  if (!regions) return [{ start: 0, text: source }];
  const lines = source.split("\n");
  return regions.map((region) => {
    const at = lines.findIndex((line) => line.includes(region.from));
    expect(at, `${file}: the marker "${region.from}" must exist`).toBeGreaterThanOrEqual(0);
    let end = region.to ? lines.findIndex((line, i) => i > at && line.includes(region.to!)) : lines.findIndex((line, i) => i > at && /^\}/.test(line));
    expect(end, `${file}: the region from "${region.from}" must end`).toBeGreaterThan(at);
    if (!region.to) end += 1;
    return { start: at, text: lines.slice(at, end).join("\n") };
  });
}

/** Every bypass in one module, as `file:line: code`. */
function bypasses(module: Module): string[] {
  let source = read(module.file);
  if (module.file === "server/drivers/pi-permission-gate.ts") {
    // the inline copy of shared/in-project.ts is the source itself (checked equal below)
    const from = source.indexOf(INLINE_BEGIN);
    const to = source.indexOf(INLINE_END);
    source = source.slice(0, from) + source.slice(from, to).replace(/[^\n]/g, " ") + source.slice(to);
  }
  const { fns, ns } = pathNames(source);
  const call = new RegExp([
    ...(fns.size ? [`(?<![\\w$.])(?:${[...fns].join("|")})\\s*\\(`] : []),
    ...(ns.size ? [`\\b(?:${[...ns].join("|")})\\.(?:join|resolve|normalize)\\s*\\(`] : []),
    "catch\\s*(?:\\([^)]*\\))?\\s*\\{\\s*return\\s+(?:path|root)\\b",
  ].join("|"));
  const out: string[] = [];
  for (const { start, text } of regionsOf(module.file, source, module.regions)) {
    codeOf(text).split("\n").forEach((code, i) => {
      if (call.test(code)) out.push(`${module.file}:${start + i + 1}: ${code.trim()}`);
    });
  }
  return out;
}

const strip = (src: string) => {
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.startsWith("//") || lines[i]!.trim() === "")) i++;
  return lines.slice(i).filter((line) => !/^import .* from ".*";$/.test(line)).map((line) => line.replace(/^export /, "")).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(repo, dir))) {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(join(repo, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

describe("path resolution structure (APP-GRANT-FIXPLAN-r6 (b))", () => {
  it("no approval module joins, resolves or normalizes a path itself, or keeps one it could not resolve", () => {
    expect(APPROVAL_PATH_MODULES.flatMap(bypasses)).toEqual([]);
  });

  it("the scan sees a bypass: a lexical join, a namespace call and a fail-open catch are each found", () => {
    const probe = (text: string) => {
      const { fns, ns } = pathNames(text);
      const call = new RegExp([`(?<![\\w$.])(?:${[...fns, "zz"].join("|")})\\s*\\(`, `\\b(?:${[...ns, "zz"].join("|")})\\.(?:join|resolve|normalize)\\s*\\(`,
        "catch\\s*(?:\\([^)]*\\))?\\s*\\{\\s*return\\s+(?:path|root)\\b"].join("|"));
      return codeOf(text).split("\n").filter((line) => call.test(line)).length;
    };
    expect(probe("import { join as j } from \"node:path\";\nconst a = j(cwd, raw);")).toBe(1);
    expect(probe("import { posix, win32 } from \"node:path\";\nconst p = win ? win32 : posix;\nconst a = p.normalize(x);")).toBe(1);
    expect(probe("try { return real(path); } catch { return path; }")).toBe(1);
    expect(probe("import { join } from \"node:path\";\n// join(a, b) in a comment\nconst s = \"join(a, b)\";\nconst t = list.join(\",\");")).toBe(0);
  });

  it("the Pi gate's inline copy equals shared/in-project.ts", () => {
    const gate = read("server/drivers/pi-permission-gate.ts");
    const from = gate.indexOf(INLINE_BEGIN);
    const to = gate.indexOf(INLINE_END);
    expect(from).toBeGreaterThan(-1);
    expect(gate.slice(from + INLINE_BEGIN.length, to)).toBe(strip(read("shared/in-project.ts")));
  });

  it("a RealPath is minted only by realPathInOrder and realDir", () => {
    const own = read("shared/in-project.ts");
    expect(own).toMatch(/export function realPathInOrder\(/);
    expect(own).toMatch(/export function realDir\(/);
    expect(own).toMatch(/export function joinReal\(base: RealPath/);
    // inside the module, the cast appears only in the shared walk the two mints return through
    const casts = own.split("\n").filter((line) => /\bas (?:readonly )?RealPath\b/.test(line)).length;
    expect(casts).toBeGreaterThan(0);
    const elsewhere = [...sourceFiles("server"), ...sourceFiles("shared")]
      .filter((file) => file !== "shared/in-project.ts" && file !== "server/drivers/pi-permission-gate.ts")
      .filter((file) => /\bas (?:readonly )?RealPath\b|\bas unknown as RealPath\b/.test(read(file)));
    expect(elsewhere).toEqual([]);
  });

  it("the stop line's resolver is required, and the old fail-open forms are gone", () => {
    const stopLine = read("server/stop-line.ts");
    expect(stopLine).toMatch(/realpath: \(path: string\) => string \| null;/);
    expect(stopLine).not.toMatch(/realpath\?:/);
    expect(read("server/index.ts")).not.toMatch(/function stopLineRealpath\(/);
    expect(read("server/drivers/codex-hook.ts")).not.toMatch(/function placeAgainst\(/);
  });
});
