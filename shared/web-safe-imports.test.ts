import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

// Guard: any repo-local module reachable from src/ (shared/, and server/ files the web imports, such as server/phone-jobs-engines.ts)
// ends up in the browser bundle, so it must not import node:* or a Node builtin (the 1.0.9 phone card crashed on node:crypto this way).
const ROOT = resolve(__dirname, "..");
const SHARED = join(ROOT, "shared");
const SRC = join(ROOT, "src");
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]));
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) && !/\.spec\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}
function specs(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const r: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    // `import type` and `export type` are erased at build time, so they pull nothing into the bundle.
    if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue;
    r.push(m[1] ?? m[2] ?? m[3]);
  }
  return r;
}
/** A repo-local module a specifier names: relative, `@/` (src) or `@shared/`. Anything under node_modules or outside the repo is not followed. */
function resolveLocal(from: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith(".")) p = resolve(dirname(from), spec);
  else if (spec.startsWith("@shared/")) p = join(SHARED, spec.slice(8));
  else if (spec.startsWith("@/")) p = join(SRC, spec.slice(2));
  else return null;
  for (const c of [p, p.replace(/\.js$/, ".ts"), p + ".ts", p + ".tsx", join(p, "index.ts"), join(p, "index.tsx")]) {
    if (c.startsWith(ROOT + sep) && !c.includes(`${sep}node_modules${sep}`) && existsSync(c) && statSync(c).isFile() && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
}
function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0]);
}

describe("web bundle loads no node modules", () => {
  it("every module reachable from src/ (shared/ and server/ included) imports no Node builtins", () => {
    // the browser entry is everything in src/ except the Playwright specs and configs, which run under Node
    // .d.ts files only declare types (`import("...")` there is a type position), so they pull nothing into the bundle
    const queue: string[] = walk(SRC).filter((f) => !f.includes(`${join("src", "e2e")}${sep}`) && !f.endsWith(".d.ts"));
    const roots = new Set(queue);
    const seen = new Set<string>();
    const bad: string[] = [];
    const reached: string[] = [];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (!roots.has(f)) reached.push(f.slice(ROOT.length + 1).split(sep).join("/"));
      for (const s of specs(f)) {
        if (isBuiltin(s)) bad.push(`${f.slice(ROOT.length + 1)} imports ${s}`);
        const t = resolveLocal(f, s);
        if (t) queue.push(t);
      }
    }
    expect(reached.some((f) => f.startsWith("shared/"))).toBe(true);
    // the walk follows into server/: the engine table the Phone card reads
    expect(reached).toContain("server/phone-jobs-engines.ts");
    expect(bad).toEqual([]);
  });
  it("the checks themselves: a builtin import is seen, a type-only one is not, and the card's server/ import resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-safe-"));
    try {
      const file = join(dir, "fake.ts");
      writeFileSync(file, 'import { createHash } from "node:crypto";\nimport type { Server } from "node:http";\nimport { z } from "zod";\n');
      const found = specs(file);
      expect(found).toEqual(["node:crypto", "zod"]);
      expect(found.filter(isBuiltin)).toEqual(["node:crypto"]);
    } finally { removeTempDirSync(dir); }
    expect(isBuiltin("fs/promises")).toBe(true);
    expect(isBuiltin("zod")).toBe(false);
    expect(resolveLocal(join(SRC, "components", "PhoneAccessCard.tsx"), "../../server/phone-jobs-engines.ts")).toBe(join(ROOT, "server", "phone-jobs-engines.ts"));
  });
});
