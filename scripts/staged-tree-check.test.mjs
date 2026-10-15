// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createHoistedStager } from "./stage-hoisted.mjs";
import { checkStagedTree } from "./staged-tree-check.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const semver = { satisfies: () => true };

/** Builds an installed package `p` (name "p") with the given manifest extras and files, stages it with the real
 * stager (so the real pruning rules apply), and checks the staged tree against the unpruned install. */
function stageAndCheck(manifest, files, others = [], { withSource = true, warnings = false, remove = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "staged-check-")); roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  const put = (name, pkg, tree) => {
    const dir = join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license: "MIT", ...pkg }));
    for (const [file, text] of Object.entries(tree)) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); }
  };
  put("p", manifest, files);
  for (const [name, pkg, tree] of others) put(name, pkg, tree);
  const dist = join(root, "dist-server"); mkdirSync(dist);
  const stager = createHoistedStager({ distRoot: dist });
  stager.stage("p", root);
  for (const path of remove) rmSync(join(dist, "node_modules", path), { force: true }); // simulate a file the stager dropped
  const result = checkStagedTree(dist, { semver, overrides: {}, sourceRoot: withSource ? root : join(root, "nowhere") });
  return warnings ? result.warnings : result.problems;
}

it("passes a package whose main, bin, exports and requires all survive pruning", () => {
  expect(stageAndCheck({ main: "index.js", bin: { p: "bin/p.js" }, exports: { ".": { import: "./index.js", require: "./index.js" }, "./util": "./lib/util.js" } },
    { "index.js": "require('./lib/util.js')", "bin/p.js": "", "lib/util.js": "" })).toEqual([]);
});

it("fails when an exports subpath target is missing", () => {
  const problems = stageAndCheck({ exports: { ".": "./index.js", "./extra": "./lib/extra.js" } }, { "index.js": "" }, [], { withSource: false });
  expect(problems.join("\n")).toMatch(/exports \.\/extra -> \.\/lib\/extra\.js is missing/);
});

it("fails when an exports target lives in a pruned directory (all conditions are checked)", () => {
  const problems = stageAndCheck({ exports: { ".": { import: "./index.js", types: "./docs/types.js" } } }, { "index.js": "", "docs/types.js": "" }, [], { remove: ["p/docs/types.js"] });
  expect(problems.join("\n")).toMatch(/docs\/types\.js is missing \(removed by pruning\)/);
});

it("resolves a wildcard exports pattern against the unpruned source and fails on pruned matches", () => {
  const problems = stageAndCheck({ exports: { ".": "./index.js", "./feat/*": "./lib/*.js" } }, { "index.js": "", "lib/a.js": "", "lib/tests/b.js": "" }, [], { remove: ["p/lib/tests/b.js"] });
  expect(problems.join("\n")).toMatch(/exports \.\/feat\/\* -> \.\/lib\/\*\.js: \.\/lib\/tests\/b\.js is missing/);
  expect(stageAndCheck({ exports: { ".": "./index.js", "./feat/*": "./lib/*.js" } }, { "index.js": "", "lib/a.js": "" })).toEqual([]);
});

it("fails a wildcard pattern that matches nothing", () => {
  expect(stageAndCheck({ exports: { "./feat/*": "./lib/*.js" } }, { "index.js": "" }, [], { withSource: false }).join("\n")).toMatch(/source inventory is unavailable/);
});

it("fails when a staged file requires a relative path the pruner removed", () => {
  const problems = stageAndCheck({ main: "index.js" }, { "index.js": "const t = require('./test/helper.js'); import('./docs/x.js');", "test/helper.js": "", "docs/x.js": "" }, [], { remove: ["p/test/helper.js", "p/docs/x.js"] });
  expect(problems.join("\n")).toMatch(/\.\/test\/helper\.js is required but was removed by pruning/);
  expect(problems.join("\n")).toMatch(/\.\/docs\/x\.js is required but was removed by pruning/);
});

it("ignores a guarded require of a file that the unpruned package never had", () => {
  expect(stageAndCheck({ main: "index.js" }, { "index.js": "try { require('./native.node.js') } catch {}" })).toEqual([]);
});

it("fails when another staged package's pruned subpath is required", () => {
  const problems = stageAndCheck({ main: "index.js", dependencies: { q: "1.0.0" } }, { "index.js": "require('q/test/h.js'); require('q/lib/ok.js'); require('q/missing')" },
    [["q", {}, { "index.js": "", "lib/ok.js": "", "test/h.js": "" }]], { remove: ["q/test/h.js"] });
  expect(problems.join("\n")).toMatch(/q\/test\/h\.js is required but was removed by pruning/);
  expect(problems.join("\n")).not.toMatch(/q\/lib\/ok/);
});

it("fails a missing main and a missing bin, even when exports is present", () => {
  const problems = stageAndCheck({ main: "gone.js", bin: { p: "bin/gone.js" }, exports: { ".": "./index.js" } }, { "index.js": "" }, [], { withSource: false });
  expect(problems.join("\n")).toMatch(/main gone\.js is missing/);
  expect(problems.join("\n")).toMatch(/bin bin\/gone\.js is missing/);
});

it("only warns about a target the installed package itself never shipped, and skips legacy directory and doc-file patterns", () => {
  const manifest = { exports: { ".": "./index.js", "./gone": "./lib/gone.js", "./": "./", "./*": "./*" } };
  const files = { "index.js": "", "README.md": "", "SECURITY.md": "" };
  expect(stageAndCheck(manifest, files)).toEqual([]);
  expect(stageAndCheck(manifest, files, [], { warnings: true }).join("\n")).toMatch(/\.\/lib\/gone\.js is missing from the installed package too/);
});

it("finding 1: the stager keeps every non-doc file wherever it sits, and removes only maps and known-name docs", () => {
  const root = mkdtempSync(join(tmpdir(), "staged-check-")); roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  const dir = join(root, "node_modules", "p"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", license: "MIT" }));
  const tree = { "index.js": "", "docs/worker.js": "", "docs/data.json": "{}", "docs/engine.wasm": "", "docs/addon.node": "", "docs/notice.js": "", "test/fixture.js": "", ".github/a.yml": "", "docs/README.md": "", "templates/prompt.md": "", "__snapshots__/data.json": "{}", "lib/a.js.map": "{}" };
  for (const [file, text] of Object.entries(tree)) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); }
  const dist = join(root, "dist-server"); mkdirSync(dist);
  createHoistedStager({ distRoot: dist }).stage("p", root);
  const at = file => existsSync(join(dist, "node_modules/p", file));
  for (const kept of ["docs/worker.js", "docs/data.json", "docs/engine.wasm", "docs/addon.node", "docs/notice.js", "test/fixture.js", ".github/a.yml", "templates/prompt.md", "__snapshots__/data.json"]) expect(at(kept), kept).toBe(true);
  for (const dropped of ["docs/README.md", "lib/a.js.map"]) expect(at(dropped), dropped).toBe(false);
});

it("finding 2: a source-side directory resolved through package.json main is not treated as guarded", () => {
  const problems = stageAndCheck({ main: "index.js" }, { "index.js": "require('./impl')", "impl/package.json": '{"main":"lib/real.js"}', "impl/lib/real.js": "" }, [], { remove: ["p/impl/lib/real.js"] });
  expect(problems.join("\n")).toMatch(/\.\/impl is required but was removed by pruning/);
});

it("finding 3: every * in a wildcard target is the same subpath", () => {
  const manifest = { exports: { "./features/*": "./features/*/tests/*.js" } };
  const files = { "features/a/tests/a.js": "", "features/b/tests/b.js": "", "features/a/tests/other.js": "" };
  const problems = stageAndCheck(manifest, files, [], { remove: ["p/features/a/tests/a.js"] });
  expect(problems.join("\n")).toMatch(/features\/a\/tests\/a\.js is missing/);
  expect(problems.join("\n")).not.toMatch(/other\.js/);
});

it("finding 4: a wildcard pattern fails when the source inventory is unavailable, even if one sibling survived", () => {
  const problems = stageAndCheck({ exports: { "./f/*": "./lib/*.js" } }, { "lib/a.js": "", "lib/b.js": "" }, [], { withSource: false, remove: ["p/lib/b.js"] });
  expect(problems.join("\n")).toMatch(/source inventory is unavailable/);
});

it("finding 5: a code file named like a licence is still required by a wildcard export", () => {
  const problems = stageAndCheck({ exports: { "./d/*": "./docs/*.js" } }, { "docs/notice.js": "", "docs/a.js": "" }, [], { remove: ["p/docs/notice.js"] });
  expect(problems.join("\n")).toMatch(/docs\/notice\.js is missing/);
});

it("finding r2-2: a numeric suffix after * does not turn the backreference into \\11", () => {
  const manifest = { exports: { "./features/*": "./features/*/__snapshots__/*1.js" } };
  const problems = stageAndCheck(manifest, { "features/a/__snapshots__/a1.js": "", "features/b/__snapshots__/b1.js": "" }, [], { remove: ["p/features/a/__snapshots__/a1.js"] });
  expect(problems.join("\n")).toMatch(/features\/a\/__snapshots__\/a1\.js is missing/);
});
