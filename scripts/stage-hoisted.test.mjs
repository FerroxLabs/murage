// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHoistedStager, wipeStagedTree } from "./stage-hoisted.mjs";
import { declaredOnly, generateInventory } from "./whatsapp-inventory.mjs";
import { checkStagedTree } from "./staged-tree-check.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const semver = { satisfies: (version, range) => range.startsWith("^") ? version.split(".")[0] === range.slice(1).split(".")[0] : version === range };

// A plain installed tree: <root>/node_modules/<name>, each with the given dependencies; `nested` places a copy
// under another package, as pnpm/npm do for a version conflict.
function installed(layout) {
  const root = mkdtempSync(join(tmpdir(), "stage-hoisted-")); roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  for (const [where, version, dependencies, extra] of layout) {
    const dir = join(root, "node_modules", where);
    mkdirSync(dir, { recursive: true });
    const name = where.split("node_modules/").pop();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, license: "MIT", dependencies }));
    writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
    for (const [file, text] of Object.entries(extra ?? {})) { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), text); }
  }
  const dist = join(root, "dist-server"); mkdirSync(dist);
  return { root, dist, stager: createHoistedStager({ distRoot: dist }) };
}

it("places each name@version once at the top level and reuses it for every requirer", () => {
  const { root, dist, stager } = installed([["a", "1.0.0", { shared: "^1.0.0" }], ["b", "1.0.0", { shared: "^1.0.0", a: "^1.0.0" }], ["shared", "1.2.0", {}]]);
  stager.stage("a", root); stager.stage("b", root);
  expect(existsSync(join(dist, "node_modules/shared/index.js"))).toBe(true);
  expect(existsSync(join(dist, "node_modules/a/node_modules"))).toBe(false);
  expect(existsSync(join(dist, "node_modules/b/node_modules"))).toBe(false);
  expect(stager.records().map(r => r.path).sort()).toEqual(["node_modules/a", "node_modules/b", "node_modules/shared"]);
  expect(checkStagedTree(dist, { semver }).problems).toEqual([]);
});

it("nests a conflicting version under its requirer and keeps node resolution correct", () => {
  const { root, dist, stager } = installed([
    ["a", "1.0.0", { zod: "^3.0.0" }], ["b", "1.0.0", { zod: "^4.0.0" }],
    ["zod", "3.25.0", {}], ["b/node_modules/zod", "4.4.3", {}],
  ]);
  stager.stage("a", root); stager.stage("b", root);
  expect(JSON.parse(readFileSync(join(dist, "node_modules/zod/package.json"), "utf8")).version).toBe("3.25.0");
  expect(JSON.parse(readFileSync(join(dist, "node_modules/b/node_modules/zod/package.json"), "utf8")).version).toBe("4.4.3");
  expect(checkStagedTree(dist, { semver }).problems).toEqual([]);
  expect(stager.records().filter(r => r.name === "zod").map(r => r.version).sort()).toEqual(["3.25.0", "4.4.3"]);
});

it("terminates on dependency cycles and skips absent optional dependencies", () => {
  const { root, dist, stager } = installed([["a", "1.0.0", { b: "^1.0.0" }], ["b", "1.0.0", { a: "^1.0.0" }]]);
  const file = join(root, "node_modules/b/package.json"), pkg = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...pkg, optionalDependencies: { absent: "^1.0.0" } }));
  stager.stage("a", root);
  expect(stager.records()).toHaveLength(2);
  expect(checkStagedTree(dist, { semver }).problems).toEqual([]);
});

it("drops only source maps and known-name documentation markdown, and keeps licences, source and every non-doc file in test or docs directories", () => {
  const { root, dist, stager } = installed([["a", "1.0.0", {}, {
    "lib/main.js": "x", "lib/main.js.map": "{}", "src/main.ts": "x", "README.md": "r", "CHANGELOG.md": "c", "CHANGELOG": "c", "LICENSE": "l", "LICENSE.md": "l", "LICENCE-MIT.md": "l",
    "test/a.js": "t", "tests/a.js": "t", "__tests__/a.js": "t", "docs/a.html": "d", "docs/README.md": "d", "docs/guide.md": "d", "templates/prompt.md": "p", "__snapshots__/data.json": "{}", "benchmark/a.js": "b", "benchmarks/a.js": "b", ".github/w.yml": "g", ".github/README.md": "g", "src/__image_snapshots__/a.png": "p", "lib/test/inner.js": "t", "node_modules/nested/package.json": "{}",
  }]]);
  stager.stage("a", root);
  const at = path => existsSync(join(dist, "node_modules/a", path));
  for (const kept of ["lib/main.js", "src/main.ts", "LICENSE", "LICENSE.md", "LICENCE-MIT.md", "package.json", "test/a.js", "tests/a.js", "__tests__/a.js", "docs/a.html", "benchmark/a.js", "benchmarks/a.js", ".github/w.yml", "lib/test/inner.js", "docs/guide.md", ".github/README.md", "templates/prompt.md", "__snapshots__/data.json", "src/__image_snapshots__/a.png", "CHANGELOG"]) expect(at(kept), kept).toBe(true);
  for (const dropped of ["lib/main.js.map", "README.md", "CHANGELOG.md", "docs/README.md", "node_modules"]) expect(at(dropped), dropped).toBe(false);
});

it("the tree check reports an unresolved dependency and an out-of-range hoisted version", () => {
  const { root, dist, stager } = installed([["a", "1.0.0", { zod: "^4.0.0" }], ["zod", "4.4.3", {}]]);
  stager.stage("a", root);
  writeFileSync(join(dist, "node_modules/zod/package.json"), JSON.stringify({ name: "zod", version: "3.25.0" }));
  expect(checkStagedTree(dist, { semver }).problems.join("\n")).toContain("does not satisfy");
  rmSync(join(dist, "node_modules/zod"), { recursive: true });
  expect(checkStagedTree(dist, { semver }).problems.join("\n")).toContain("does not resolve");
});

it("refuses to wipe a directory this stager did not write, and wipes what it did", () => {
  const { root, dist, stager } = installed([["a", "1.0.0", {}]]);
  stager.stage("a", root);
  wipeStagedTree(dist, root);
  expect(existsSync(join(dist, "node_modules/a"))).toBe(false);
  mkdirSync(join(dist, "node_modules/stranger"), { recursive: true });
  expect(() => wipeStagedTree(dist, root)).toThrow("refusing unowned");
});

it("holds a hoisted version to a pnpm override instead of the declared range", () => {
  const { root, dist, stager } = installed([["a", "1.0.0", { sharp: "^0.34.5" }], ["sharp", "0.35.5", {}]]);
  stager.stage("a", root);
  const exact = { satisfies: (version, range) => version === range };
  expect(checkStagedTree(dist, { semver: exact, overrides: {} }).problems.join("\n")).toContain("does not satisfy");
  expect(checkStagedTree(dist, { semver: exact, overrides: { sharp: "0.35.5" } }).problems).toEqual([]);
});

it("keeps a README that is a package's only licence text, and prunes it when a licence file exists", () => {
  const mit = "# tok\n\nThe MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";
  const { root, dist, stager } = installed([["@tokenizer/token", "0.3.0", {}, { "README.md": mit, "CHANGELOG.md": "c", "docs/CHANGES.md": "d", "docs/data.md": "k" }], ["licensed", "1.0.0", {}, { "README.md": "r", "LICENSE": "l" }]]);
  stager.stage("@tokenizer/token", root); stager.stage("licensed", root);
  expect(readFileSync(join(dist, "node_modules/@tokenizer/token/README.md"), "utf8")).toBe(mit);
  expect(existsSync(join(dist, "node_modules/@tokenizer/token/CHANGELOG.md"))).toBe(false);
  expect(existsSync(join(dist, "node_modules/@tokenizer/token/docs/CHANGES.md"))).toBe(false);
  expect(existsSync(join(dist, "node_modules/@tokenizer/token/docs/data.md"))).toBe(true);
  expect(existsSync(join(dist, "node_modules/licensed/README.md"))).toBe(false);
});

it("the inventory records the README licence text, and lists packages that publish none", () => {
  const mit = "The MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";
  const { root, dist, stager } = installed([["baileys", "7.0.0", { "@tokenizer/token": "^0.3.0", bare: "^1.0.0" }], ["jimp", "1.0.0", {}], ["@tokenizer/token", "0.3.0", {}, { "README.md": mit }], ["bare", "1.0.0", {}, { "README.md": "nothing about terms" }]]);
  stager.stage("baileys", root); stager.stage("jimp", root);
  const lockfile = join(root, "lock.yaml");
  writeFileSync(lockfile, JSON.stringify({ packages: Object.fromEntries(["baileys@7.0.0", "jimp@1.0.0", "@tokenizer/token@0.3.0", "bare@1.0.0"].map(id => [id, { resolution: { integrity: "sha512-YWJj" } }])) }));
  const inventory = generateInventory({ server: dist, lockfile });
  const token = inventory.find(p => p.name === "@tokenizer/token");
  expect(token.licenseFiles.map(f => f.source)).toEqual(["README.md"]);
  expect(readFileSync(join(dist, token.licenseFiles[0].path), "utf8")).toBe(mit);
  expect(declaredOnly(inventory, dist).sort()).toEqual(["baileys@7.0.0", "bare@1.0.0", "jimp@1.0.0"]);
});

it("does not let a later nested package change what an earlier staged descendant resolves", () => {
  // t needs X@1 (hoisted), so A@2 nests its own X@2; X@2 needs D@1, staged hoisted; then A@2's own D@2 must not shadow it.
  const { root, dist, stager } = installed([
    ["t", "1.0.0", { X: "^1.0.0" }], ["X", "1.0.0", {}],
    ["A", "2.0.0", { X: "^2.0.0", D: "^2.0.0" }], ["A/node_modules/X", "2.0.0", { D: "^1.0.0" }],
    ["A/node_modules/X/node_modules/D", "1.0.0", {}], ["A/node_modules/D", "2.0.0", {}],
  ]);
  stager.stage("t", root); stager.stage("A", root);
  const version = path => JSON.parse(readFileSync(join(dist, path, "package.json"), "utf8")).version;
  expect(version("node_modules/A/node_modules/D")).toBe("2.0.0");
  expect(version("node_modules/A/node_modules/X/node_modules/D")).toBe("1.0.0");
  expect(checkStagedTree(dist, { semver }).problems).toEqual([]);
});

// A pnpm-style installed tree: every name@version lives once under .store and links its dependencies as siblings,
// so a dependency cycle is a real cycle of links. `top` lists the root's own dependencies.
function pnpmTree(packages, top) {
  const root = mkdtempSync(join(tmpdir(), "stage-pnpm-")); roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  const dir = (id) => join(root, ".store", id, "node_modules", id.split("@")[0]);
  for (const [id, dependencies] of Object.entries(packages)) {
    const [name, version] = id.split("@");
    mkdirSync(dir(id), { recursive: true });
    writeFileSync(join(dir(id), "package.json"), JSON.stringify({ name, version, license: "MIT", dependencies: Object.fromEntries(Object.keys(dependencies).map(dep => [dep, `^${dependencies[dep].split("@")[1]}.0.0`])) }));
    writeFileSync(join(dir(id), "index.js"), "module.exports = 1;\n");
  }
  for (const [id, dependencies] of Object.entries(packages)) for (const [dep, target] of Object.entries(dependencies)) symlinkSync(dir(target), join(root, ".store", id, "node_modules", dep));
  mkdirSync(join(root, "node_modules"));
  for (const [dep, target] of Object.entries(top)) symlinkSync(dir(target), join(root, "node_modules", dep));
  const dist = join(root, "dist-server"); mkdirSync(dist);
  return { root, dist };
}

const cycle = () => pnpmTree({
  // Stage B2, then C1. C1 -> [D1, B2]; D1 -> C2; C2 -> B1; B1 -> [C1, D2]. B2 and D2 are leaves.
  "C@1": { D: "D@1", B: "B@2" }, "D@1": { C: "C@2" }, "C@2": { B: "B@1" }, "B@1": { C: "C@1", D: "D@2" }, "B@2": {}, "D@2": {},
}, { B: "B@2", C: "C@1" });

it("lays out a private-copy cycle at ancestor levels and the result passes the staged-tree check", () => {
  const { root, dist } = cycle();
  const stager = createHoistedStager({ distRoot: dist });
  stager.stage("B", root); stager.stage("C", root);
  const staged = stager.records().map(r => `${r.name}@${r.version}`);
  // Every version in the cycle is staged somewhere, the layout is finite, and Node resolves each dependency as declared.
  for (const id of ["B@2", "B@1", "C@1", "C@2", "D@1", "D@2"]) expect(staged).toContain(id);
  expect(staged.length).toBeLessThan(20);
  const checked = checkStagedTree(dist, { semver });
  expect(checked.problems).toEqual([]);
  expect(checked.packages).toBe(staged.length);
  expect(checkStagedTree(dist, { semver }).problems).toEqual([]);
});

it("still bounds the number of copies of one name@version, and the path length", () => {
  const copies = cycle();
  const stager = createHoistedStager({ distRoot: copies.dist, maxPath: 10_000, maxCopies: 1 });
  stager.stage("B", copies.root);
  expect(() => stager.stage("C", copies.root)).toThrow(/cannot terminate: \w@\d would be copied 2 times \(limit 1\)\. Placement chain: C@1 at C/);
  const long = cycle();
  const shortPaths = createHoistedStager({ distRoot: long.dist, maxPath: 20 });
  shortPaths.stage("B", long.root);
  expect(() => shortPaths.stage("C", long.root)).toThrow(/cannot terminate: \w@\d would be placed at a \d+ character path \(limit 20\)/);
});

it("lists only packages with no licence text anywhere, not ones that embed it in a retained file", () => {
  const mit = "/* The MIT License\n * Permission is hereby granted, free of charge, to any person obtaining a copy */\n";
  const { root, dist, stager } = installed([["baileys", "7.0.0", { omggif: "^1.0.0", bare: "^1.0.0" }], ["jimp", "1.0.0", {}], ["omggif", "1.0.0", {}, { "omggif.js": mit }], ["bare", "1.0.0", {}, { "lib/x.js": "// nothing" }]]);
  stager.stage("baileys", root); stager.stage("jimp", root);
  const lockfile = join(root, "lock.yaml");
  writeFileSync(lockfile, JSON.stringify({ packages: Object.fromEntries(["baileys@7.0.0", "jimp@1.0.0", "omggif@1.0.0", "bare@1.0.0"].map(id => [id, { resolution: { integrity: "sha512-YWJj" } }])) }));
  const inventory = generateInventory({ server: dist, lockfile });
  expect(declaredOnly(inventory, dist).sort()).toEqual(["baileys@7.0.0", "bare@1.0.0", "jimp@1.0.0"]);
  expect(declaredOnly(inventory).sort()).toContain("omggif@1.0.0");
});

it("never places a package under a scope directory's own node_modules", () => {
  // @s/a needs X@2 while X@1 is hoisted; the nested copy belongs under @s/a, not at @s/node_modules.
  const { root, dist, stager } = installed([["t", "1.0.0", { X: "^1.0.0" }], ["X", "1.0.0", {}], ["@s/a", "1.0.0", { X: "^2.0.0" }], ["@s/a/node_modules/X", "2.0.0", {}]]);
  stager.stage("t", root); stager.stage("@s/a", root);
  expect(existsSync(join(dist, "node_modules/@s/node_modules"))).toBe(false);
  expect(existsSync(join(dist, "node_modules/@s/a/node_modules/X/package.json"))).toBe(true);
  expect(checkStagedTree(dist, { semver }).problems).toEqual([]);
});

// Reviewer fixture: root H1/Q1/R1, then A needs Q2/R2. Q2 peers on H^1 (H1 at the root); R2 depends on a private H2.
function peerFixture() {
  const root = mkdtempSync(join(tmpdir(), "stage-peer-")); roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  const put = (where, version, fields = {}) => {
    const dir = join(root, "node_modules", where);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: where.split("node_modules/").pop(), version, license: "MIT", ...fields }));
    writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
  };
  put("H", "1.0.0"); put("Q", "1.0.0"); put("R", "1.0.0");
  put("top", "1.0.0", { dependencies: { H: "^1.0.0", Q: "^1.0.0", R: "^1.0.0" } });
  put("A", "1.0.0", { dependencies: { Q: "^2.0.0", R: "^2.0.0" } });
  put("A/node_modules/Q", "2.0.0", { peerDependencies: { H: "^1.0.0" } });
  put("A/node_modules/R", "2.0.0", { dependencies: { H: "^2.0.0" } });
  put("A/node_modules/R/node_modules/H", "2.0.0");
  const dist = join(root, "dist-server"); mkdirSync(dist);
  return { root, dist, stager: createHoistedStager({ distRoot: dist }) };
}
const versionAt = (dist, rel) => JSON.parse(readFileSync(join(dist, "node_modules", rel, "package.json"), "utf8")).version;

it("does not let an ancestor placement shadow a peer dependency another staged package resolves", () => {
  const { root, dist, stager } = peerFixture();
  stager.stage("top", root); stager.stage("A", root);
  expect(existsSync(join(dist, "node_modules/A/node_modules/H"))).toBe(false);
  expect(versionAt(dist, "H")).toBe("1.0.0");
  expect(versionAt(dist, "A/node_modules/R/node_modules/H")).toBe("2.0.0");
  expect(checkStagedTree(dist, { semver }).problems).toEqual([]);
});

it("the tree check flags a required peer that resolves out of range or not at all, and honours optional peers", () => {
  const { root, dist, stager } = peerFixture();
  stager.stage("top", root); stager.stage("A", root);
  // Force the bad layout: H2 at A/node_modules/H shadows the root H1 that Q2 peers on.
  const forced = join(dist, "node_modules/A/node_modules/H");
  mkdirSync(forced, { recursive: true });
  writeFileSync(join(forced, "package.json"), JSON.stringify({ name: "H", version: "2.0.0" }));
  expect(checkStagedTree(dist, { semver }).problems.join("\n")).toMatch(/Q .*peer dependency H@2\.0\.0 .*does not satisfy \^1\.0\.0/);
  rmSync(forced, { recursive: true, force: true });
  const q = join(dist, "node_modules/A/node_modules/Q/package.json"), pkg = JSON.parse(readFileSync(q, "utf8"));
  writeFileSync(q, JSON.stringify({ ...pkg, peerDependencies: { H: "^1.0.0", missing: "^1.0.0", extra: "^1.0.0" }, peerDependenciesMeta: { extra: { optional: true } } }));
  const problems = checkStagedTree(dist, { semver }).problems;
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/peer dependency missing@\^1\.0\.0 does not resolve/);
});

it("prunes the snapshot directories of the audited @jimp packages but keeps their licence files, and nobody else's", () => {
  const { root, dist, stager } = installed([
    ["@jimp/plugin-print", "1.6.1", {}, { "src/__image_snapshots__/a.png": "p", "src/__snapshots__/b.snap": "s", "src/__snapshots__/LICENSE": "l", "src/real.js": "x" }],
    ["other", "1.0.0", {}, { "src/__snapshots__/data.json": "{}" }],
  ]);
  stager.stage("@jimp/plugin-print", root); stager.stage("other", root);
  const at = path => existsSync(join(dist, "node_modules", path));
  expect(at("@jimp/plugin-print/src/__image_snapshots__")).toBe(false);
  expect(at("@jimp/plugin-print/src/__snapshots__/b.snap")).toBe(false);
  expect(at("@jimp/plugin-print/src/__snapshots__/LICENSE")).toBe(true);
  expect(at("@jimp/plugin-print/src/real.js")).toBe(true);
  expect(at("other/src/__snapshots__/data.json")).toBe(true);
});

it("prunes jimp snapshot directories at the audited 1.6.1 only; 1.6.2 keeps them", () => {
  const { root, dist, stager } = installed([["@jimp/plugin-print", "1.6.2", {}, { "src/__snapshots__/b.snap": "s", "src/real.js": "x" }]]);
  stager.stage("@jimp/plugin-print", root);
  expect(existsSync(join(dist, "node_modules/@jimp/plugin-print/src/__snapshots__/b.snap"))).toBe(true);
});
