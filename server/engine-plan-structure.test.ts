// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shape that keeps engine-history deletion honest, kept by the source itself (the rules are engine-structure-check.ts):
// one reader and one writer of the engines' files (engine-fs.ts), planners that can only read through it, an executor that
// changes things only through its mutation layer, a driver and a worker that touch no file at all, and a swallowed error
// only where it is deliberate. The negative tests feed the rules real sources with one forbidden line added: they must fail.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ENGINE_FILES, evalWorkerViolations, graphViolations, importsOf, stripComments, violations } from "./engine-structure-check.ts";

const SERVER = dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(join(SERVER, name), "utf8");
const code = (name: string) => stripComments(source(name));

describe("engine-history deletion structure", () => {
  for (const name of Object.keys(ENGINE_FILES)) {
    it(`${name}: keeps every rule of its role (${ENGINE_FILES[name]})`, () => {
      expect(violations(name, source(name))).toEqual([]);
    });
  }

  it("only the strict reader imports the file system, sqlite or zlib", () => {
    const using = (module: string) => Object.keys(ENGINE_FILES).filter((name) => importsOf(source(name)).modules.includes(module)).sort();
    expect(using("node:sqlite")).toEqual(["engine-fs.ts"]);
    expect(using("node:zlib")).toEqual(["engine-fs.ts"]);
    // the strict reader, the loader of the native addon (it only looks for the file), and the audited leaf that finds the worker
    expect(using("node:fs")).toEqual(["engine-exclusion.ts", "engine-fs.ts", "proxy-paths.ts"]);
    // proxy-paths.ts reads its name list from shared/spawned-proxies.mjs: that file must stay import-free data
    expect(importsOf(readFileSync(join(SERVER, "..", "shared", "spawned-proxies.mjs"), "utf8")).modules).toEqual([]);
  });

  it("the import graph is closed: no planner reaches the reader or the executor, and the app's thread reaches no deletion module", () => {
    const sources = Object.fromEntries(Object.keys(ENGINE_FILES).map((name) => [name, source(name)]));
    expect(graphViolations(sources)).toEqual([]);
    // a helper that re-exports the reader puts it inside every planner's reach
    expect(graphViolations({ ...sources, "engine-history-deletion.ts": `${sources["engine-history-deletion.ts"]}\nexport { fsOps } from "./engine-fs.ts";` }).some((item) => /engine-plan-acp\.ts: reaches engine-fs\.ts/.test(item))).toBe(true);
    expect(graphViolations({ ...sources, "engine-history-offthread.ts": `${sources["engine-history-offthread.ts"]}\nexport { planEngineHistory } from "./engine-history-run.ts";` }).some((item) => /engine-history-offthread\.ts: reaches/.test(item))).toBe(true);
  });

  it("every raw call in the strict reader sits in the fsOps or mutOps layer that tests can replace", () => {
    const text = code("engine-fs.ts");
    for (const layer of ["export const fsOps", "export const mutOps", "export const exclOps"]) expect(text.includes(layer), layer).toBe(true);
    // the helpers a layer member is made of are above its object; nothing but those layers is exported as a raw call
    const exported = [...text.matchAll(/^export (?:const|function) (\w+)/gm)].map((match) => match[1]);
    expect(exported.sort()).toEqual(["exclOps", "fsOps", "isAbsent", "mentions", "mutOps", "parseJsonLines", "realEngineFs"].sort());
  });

  it("the executor swallows an error only where it is deliberate", () => {
    const lines = code("engine-exec.ts").split("\n");
    const allowed = new Set(["lstatOrNull", "removeConfined", "allowOwnerWrites", "noWriters", "sweepPrivateLocks", "moveAside", "putBack", "giveName", "sameFileAt", "deleteTree", "removeGuarded", "settleAside", "joinInto", "mergedRows", "mergeAside", "finishJoin", "removeListed", "removeEmptyDir", "withDirLock", "sameFile", "chunk", "recoverAll", "removeUnlessReferenced", "clearExclusively", "sqlDeleteOn", "ownerCheckOn", "ftsOptimizeOn", "executeEnginePlans"]);
    lines.forEach((line, index) => {
      if (!/\bcatch\b/.test(line)) return;
      let owner = "";
      for (let at = index; at >= 0 && !owner; at--) owner = /^(?:export )?function (\w+)/.exec(lines[at]!)?.[1] ?? "";
      expect(allowed.has(owner), `line ${index + 1}: catch in ${owner || "?"}`).toBe(true);
    });
  });

  it("the engines' history is never read or removed from conversation-deletion.ts itself", () => {
    const text = code("conversation-deletion.ts");
    for (const forbidden of ["rmSync(", "unlinkSync(", "new DatabaseSync(", "zstdDecompressSync", "readlinkSync("]) expect(text.includes(forbidden), forbidden).toBe(false);
  });

  describe("the rules refuse what they are there to refuse", () => {
    const planner = "engine-plan-files.ts", executor = "engine-exec.ts", worker = "engine-history-worker.ts", driver = "engine-history-run.ts", offthread = "engine-history-offthread.ts";
    const withLine = (name: string, line: string) => `${source(name)}\n${line}\n`;
    const forbiddenLines: Array<[string, string]> = [
      ["a static fs import", 'import { readFileSync } from "node:fs";'],
      ["a bare fs import", 'import { readFileSync } from "fs";'],
      ["fs/promises", 'import { readFile } from "node:fs/promises";'],
      ["bare fs/promises", 'import * as fsp from "fs/promises";'],
      ["a sqlite import", 'import { DatabaseSync } from "node:sqlite";'],
      ["a zlib import", 'import zlib from "node:zlib";'],
      ["a re-export from fs", 'export { readFileSync } from "node:fs";'],
      ["require", 'const fs = require("node:fs");'],
      ["createRequire", 'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);'],
      ["a dynamic import", 'const fs = await import("node:fs");'],
      ["a computed dynamic import", 'const fs = await import(name);'],
      ["process.binding", 'const b = process.binding("fs");'],
    ];
    for (const [what, line] of forbiddenLines) {
      for (const name of [planner, worker, driver, offthread, executor]) {
        it(`${name} with ${what} is rejected`, () => {
          expect(violations(name, withLine(name, line)).length, `${name} + ${what}`).toBeGreaterThan(0);
        });
      }
    }
    // the six additions the r15 review showed the old text rules accepted, and the neighbours of each
    const bypasses: Array<[string, string]> = [
      ["process.getBuiltinModule", 'const f = process.getBuiltinModule("fs"); f.readFileSync ("/fixture");'],
      ["process.getBuiltinModule by a computed name", 'const f = process["getBuiltin" + "Module"]("fs");'],
      ["destructured process.binding", 'const { binding } = process; binding("fs");'],
      ["process held in a variable", 'const p = process; p.binding("fs");'],
      ["globalThis.process", 'const b = globalThis.process.binding("fs");'],
      ["an import after another statement on the same line", 'const noop = 1; import fs from "node:fs"; fs.readFileSync ("/fixture");'],
      ["a computed require", 'const f = require("node:" + "fs");'],
      ["a computed dynamic import", 'const f = await import("node:" + "fs");'],
      ["an aliased import from a helper that is not allowed", 'import { readFileSync as read } from "./world-helper.ts";'],
      ["an aliased import from an allowed-looking name", 'import { fsOps as ops } from "./engine-history-deletion-more.ts";'],
      ["a call with a space before the parenthesis", 'const t = readFileSync ("/x", "utf8");'],
      ["a member call on an imported module", 'const t = fs.readFileSync("/x");'],
      ["eval", 'eval("require(\'node:fs\')");'],
      ["a Function constructor", 'new Function("return process")();'],
    ];
    for (const [what, line] of bypasses) {
      for (const name of [planner, "engine-plan-acp.ts", "engine-plan-core.ts", worker, driver, offthread, executor]) {
        it(`${name} with ${what} is rejected`, () => {
          expect(violations(name, withLine(name, line)).length, `${name} + ${what}`).toBeGreaterThan(0);
        });
      }
    }
    it("the executor may not discover: a planning reader, or a raw fsOps read, is rejected", () => {
      expect(violations(executor, withLine(executor, "const x = reader.withDb(path, () => 1);")).some((item) => /withDb/.test(item))).toBe(true);
      expect(violations(executor, withLine(executor, "const x = reader.readHead(path, 10);")).some((item) => /readHead/.test(item))).toBe(true);
      expect(violations(executor, withLine(executor, "const x = fsOps.readdir(path);")).some((item) => /fsOps\.readdir/.test(item))).toBe(true);
      expect(violations(executor, withLine(executor, 'const x = mutOps["unlink"](path);')).some((item) => /computed name/.test(item))).toBe(true);
    });
    it("type-only imports are free and a name used only in a type is not a call", () => {
      expect(violations(planner, withLine(planner, 'import type { Stats } from "node:fs";\nexport type T = Stats;')).filter((item) => /imports/.test(item))).toEqual([]);
      expect(violations(executor, withLine(executor, "type D = DatabaseSync;")).filter((item) => /DatabaseSync/.test(item))).toEqual([]);
    });
    it("a raw read added to the executor is rejected", () => {
      expect(violations(executor, withLine(executor, 'const text = readFileSync("/x", "utf8");')).some((item) => /readFileSync/.test(item))).toBe(true);
      expect(violations(executor, withLine(executor, 'const db = new DatabaseSync("/x");')).some((item) => /DatabaseSync/.test(item))).toBe(true);
    });
    it("a try added to a planner is rejected", () => {
      expect(violations(planner, withLine(planner, "function f() { try { return 1; } catch { return 2; } }")).some((item) => /try or catch/.test(item))).toBe(true);
    });
    it("a second catch in the driver is rejected", () => {
      expect(violations(driver, withLine(driver, "function f() { try { return 1; } catch { return 2; } }")).length).toBeGreaterThan(0);
    });
    it("a worker that imports anything but worker_threads and the driver is rejected", () => {
      expect(violations(worker, withLine(worker, 'import { realEngineFs } from "./engine-fs.ts";')).length).toBeGreaterThan(0);
    });
    it("the thread that serves the app may not load the executor", () => {
      expect(violations(offthread, withLine(offthread, 'import { executeEnginePlans } from "./engine-exec.ts";')).length).toBeGreaterThan(0);
    });
    // r16b finding 9: the routes the first version of the guard left open
    it("a worker started from a string (eval) is read as a worker source and rejected in every engine module", () => {
      for (const name of [planner, executor, driver, "engine-fs.ts", "engine-keys.ts"]) {
        expect(violations(name, withLine(name, 'import { Worker } from "node:worker_threads";\nnew Worker(\'const fs = require("node:fs"); fs.readFileSync("/x")\', { eval: true });')).some((item) => /eval worker/.test(item)), name).toBe(true);
        expect(violations(name, withLine(name, "declare const src: string;\nnew Worker(src, { eval: true });")).some((item) => /starts a worker from a string/.test(item)), name).toBe(true);
      }
    });
    it("the one eval worker that is allowed (wal-maintenance.ts) may require only its own list", () => {
      const wal = source("wal-maintenance.ts");
      const allowed = ["node:worker_threads", "node:sqlite"];
      expect(evalWorkerViolations("wal-maintenance.ts", wal, allowed)).toEqual([]);
      expect(evalWorkerViolations("wal-maintenance.ts", wal.replace('require("node:sqlite")', 'require("node:sqlite"); require("node:fs")'), allowed).some((item) => /node:fs/.test(item))).toBe(true);
      expect(evalWorkerViolations("wal-maintenance.ts", wal.replace('require("node:sqlite")', 'require("node:" + "sqlite")'), allowed).some((item) => /computed/.test(item))).toBe(true);
      expect(evalWorkerViolations("wal-maintenance.ts", wal.replace("const WORKER_SOURCE = `", "const WORKER_SOURCE = `eval('1');"), allowed).some((item) => /eval/.test(item))).toBe(true);
      expect(evalWorkerViolations("x.ts", "declare const s: string;\nnew Worker(s, { eval: true });", allowed).some((item) => /cannot be read/.test(item))).toBe(true);
    });
    // r17 finding 11: the aliases and option forms the first version of the guard let through
    it("a layer reached through an import alias is still a layer: destructuring or handing on the alias is rejected", () => {
      const aliased = `${source(executor)}\nimport { fsOps as f } from "./engine-fs.ts";\nconst { readFile: read } = f;\nread("/fixture");\n`;
      expect(violations(executor, aliased).some((item) => /uses f other than as a direct named property/.test(item))).toBe(true);
      for (const line of ["import { mutOps as m } from \"./engine-fs.ts\";\nconst copy = m;", "import { exclOps as e } from \"./engine-fs.ts\";\nfoo(e);", "import { fsOps as f } from \"./engine-fs.ts\";\nf.readFile(\"/x\");"]) {
        expect(violations(executor, withLine(executor, line)).some((item) => /other than as a direct named property|only lstat is raw/.test(item)), line).toBe(true);
      }
      expect(violations(executor, withLine(executor, 'import * as engineFs from "./engine-fs.ts";')).some((item) => /namespace/.test(item))).toBe(true);
      expect(violations(executor, source(executor))).toEqual([]);
    });
    it("a worker whose options can carry eval: true is rejected however the options are written", () => {
      const forms = [
        'const opts = { eval: true };\nnew Worker(\'require("node:fs")\', opts);',
        'const eval_ = true;\nnew Worker(src, { eval: eval_ });',
        'const eval = true;\nnew Worker(src, { eval });',
        'declare const more: object;\nnew Worker(src, { ...more });',
        'declare const key: string;\nnew Worker(src, { [key]: true });',
        'declare const options: object;\nnew Worker(src, options);',
        'function start(options: object) { return new Worker(src, options); }',
        'const W = Worker;\nnew W(src, { eval: true });',
        'import { Worker as Thread } from "node:worker_threads";\nnew Thread(src, { eval: true });',
        'import * as wt from "node:worker_threads";\nnew wt.Worker(src, { eval: true });',
        'const opts = {};\nopts.eval = true;\nnew Worker(src, opts);',
        'let opts = { eval: false };\nopts = { eval: true };\nnew Worker(src, opts);',
      ];
      for (const form of forms) {
        for (const name of [planner, executor, driver, "engine-fs.ts", "engine-keys.ts"]) {
          const found = violations(name, withLine(name, `declare const src: string;\n${form}`));
          expect(found.some((item) => /eval|options could carry/.test(item)), `${name}: ${form}`).toBe(true);
        }
      }
      // and the ordinary forms are not mistaken for it
      for (const form of ['new Worker("/x");', 'new Worker("/x", { workerData: 1 });', 'new Worker("/x", { eval: false, workerData: 1 });', 'const opts = { workerData: 1 };\nnew Worker("/x", opts);']) {
        expect(violations(offthread, withLine(offthread, form)).some((item) => /eval|options could carry/.test(item)), form).toBe(false);
      }
      expect(evalWorkerViolations("x.ts", "declare const o: object;\nnew Worker('1', o);", ["node:worker_threads"]).some((item) => /could carry eval/.test(item))).toBe(true);
    });
    it("a leaf is walked like every other module: a world import in a leaf, or a leaf that reaches the reader, is rejected", () => {
      for (const leaf of ["blake3.ts", "sqlite-checkpoint.ts", "observe.ts"]) {
        expect(violations(leaf, source(leaf))).toEqual([]);
        expect(violations(leaf, withLine(leaf, 'import { readFileSync } from "node:fs";')).length, leaf).toBeGreaterThan(0);
        expect(violations(leaf, withLine(leaf, 'import { fsOps } from "./engine-fs.ts";')).length, leaf).toBeGreaterThan(0);
      }
      const sources = Object.fromEntries(Object.keys(ENGINE_FILES).map((name) => [name, source(name)]));
      expect(graphViolations({ ...sources, "observe.ts": `${sources["observe.ts"]}\nexport { realEngineFs } from "./engine-fs.ts";` }).some((item) => /reaches engine-fs\.ts/.test(item))).toBe(true);
      // and only the strict reader may load the native addon
      expect(graphViolations({ ...sources, "engine-exec.ts": `${sources["engine-exec.ts"]}\nimport { loadExclusionAddon } from "./engine-exclusion.ts";` }).some((item) => /only engine-fs\.ts loads the native addon/.test(item))).toBe(true);
    });
    it("fsOps, mutOps and exclOps are used only as a direct named property: destructuring, aliasing, a computed name, a spread and passing one on are each rejected", () => {
      for (const layer of ["fsOps", "mutOps", "exclOps"]) {
        for (const line of [`const { x } = ${layer};`, `const alias = ${layer};`, `const m = ${layer}["unlink"];`, `const copy = { ...${layer} };`, `call(${layer});`, `export const again = ${layer};`]) {
          expect(violations(executor, withLine(executor, line)).length, `${layer}: ${line}`).toBeGreaterThan(0);
        }
        expect(violations(executor, withLine(executor, `const fn = ${layer}.lstat;`)).filter((item) => /other than as a direct named property/.test(item))).toEqual([]);
      }
    });
    it("the executor's reader is used only as reader.method(...): a computed method, a destructure, an alias and a handed-on reader are each rejected", () => {
      for (const line of ['const x = reader["readHead"](path, 10);', "const { readHead } = reader;", "const other = reader;", "elsewhere(reader);", "const { lstat } = realEngineFs();", "elsewhere(realEngineFs());"]) {
        expect(violations(executor, withLine(executor, `function extra() { const reader = realEngineFs(); ${line} }`)).length, line).toBeGreaterThan(0);
      }
      expect(violations(executor, withLine(executor, "function extra() { const reader = realEngineFs(); return associationsOf(reader, '/x'); }")).filter((item) => /reader/.test(item))).toEqual([]);
    });
    it("a comment that names an import is not an import", () => {
      expect(violations(planner, withLine(planner, '// import fs from "node:fs"; try { } catch { }')).filter((item) => /imports/.test(item))).toEqual([]);
    });
  });
});
