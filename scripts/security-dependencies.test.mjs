// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createHoistedStager, packageRoot } from "./stage-hoisted.mjs";
import { checkStagedTree } from "./staged-tree-check.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "security-deps-")); roots.push(root); return root; }

it("stages the patched Jimp and ONNX dependency graphs without relaxing range checks", async () => {
  const root = fixture(), dist = join(root, "server");
  const stager = createHoistedStager({ distRoot: dist });
  stager.stage("jimp", resolve("."));
  stager.stage("onnxruntime-node", packageRoot("@huggingface/transformers", resolve(".")));
  const records = stager.records();
  expect(records.filter(p => p.name === "zod").map(p => p.version)).toEqual(["4.6.7"]);
  expect(records.filter(p => p.name === "adm-zip").map(p => p.version)).toEqual(["0.6.1"]);
  expect(checkStagedTree(dist).problems).toEqual([]);
  // Exercise both published module entrypoints after hoisting. These are the
  // decode/crop/resize/encode operations used by WhatsApp, plus collection and
  // enum schemas that changed major versions underneath Jimp.
  const require = createRequire(join(dist, "package.json"));
  const esm = await import(pathToFileURL(join(dist, "node_modules/jimp/dist/esm/index.js")).href);
  for (const { Jimp, ResizeStrategy } of [esm, require("jimp")]) {
    const input = new Jimp({ width: 8, height: 6, color: 0xff0000ff });
    const decoded = await Jimp.read(await input.getBuffer("image/png"));
    decoded.crop({ x: 0, y: 0, w: 6, h: 6 }).resize({ w: 4, h: 4, mode: ResizeStrategy.BILINEAR });
    decoded.convolute([[0, 0, 0], [0, 1, 0], [0, 0, 0]]);
    const jpeg = await decoded.getBuffer("image/jpeg", { quality: 50 });
    const output = await Jimp.read(jpeg);
    expect([output.width, output.height]).toEqual([4, 4]);
    expect(() => decoded.resize({ w: -1 })).toThrow();
    expect(() => decoded.convolute([["invalid"]])).toThrow();
  }
  // ONNX's installer uses this synchronous extraction API. No download or
  // provider call is needed to verify compatibility with the new minor.
  const ortRequire = createRequire(join(dist, "node_modules/onnxruntime-node/package.json"));
  const AdmZip = ortRequire("adm-zip");
  const zip = new AdmZip(); zip.addFile("lib/runtime.txt", Buffer.from("fixture runtime"));
  const archive = new AdmZip(zip.toBuffer());
  archive.extractAllTo(join(root, "extracted"), true);
  expect(readFileSync(join(root, "extracted/lib/runtime.txt"), "utf8")).toBe("fixture runtime");
}, 60_000);

it("keeps Electron file matching compatible with the patched minimatch and brace expansion", () => {
  const builder = packageRoot("app-builder-lib", packageRoot("electron-builder", resolve(".")));
  const require = createRequire(join(builder, "package.json"));
  expect(require("minimatch/package.json").version).toBe("11.0.1");
  const matcherRequire = createRequire(join(packageRoot("minimatch", builder), "package.json"));
  expect(matcherRequire("brace-expansion/package.json").version).toBe("5.0.12");
  const { FileMatcher } = require("./out/fileMatcher.js");
  const patterns = [];
  new FileMatcher("/fixture", "/output", value => value, ["**/*.{js,json}", "!**/test/**"]).computeParsedPatterns(patterns);
  expect(patterns[0].match("server/index.js")).toBe(true);
  expect(patterns[0].match("server/data.json")).toBe(true);
  expect(patterns[0].match("server/image.png")).toBe(false);
  expect(patterns[1].match("server/test/index.js")).toBe(false);
  const universal = createRequire(join(packageRoot("@electron/universal", builder), "package.json"));
  expect(universal("minimatch/package.json").version).toBe("11.0.1");
  expect(universal("minimatch").minimatch("native/addon.node", "*.node", { matchBase: true })).toBe(true);
});

function onnxZip() {
  const ort = packageRoot("onnxruntime-node", packageRoot("@huggingface/transformers", resolve(".")));
  return createRequire(join(ort, "package.json"))("adm-zip");
}

it.each(["../escape.txt", "../../escape.txt", "/escape.txt", "..\\escape.txt", "C:\\escape.txt"])(
  "contains hostile ZIP entry %s inside the extraction root", name => {
    const root = fixture(), target = join(root, "extracted");
    const AdmZip = onnxZip(), zip = new AdmZip();
    zip.addFile("safe.txt", Buffer.from("hostile"));
    // Bypass addFile's filename normalization: emulate an attacker-controlled
    // central directory, then serialize and parse the actual archive bytes.
    const entryName = name.startsWith("/") ? join(root, "escape.txt") : name;
    zip.getEntry("safe.txt").entryName = entryName;
    const bytes = zip.toBuffer(), archive = new AdmZip(bytes);
    expect(archive.getEntries()[0].entryName).toBe(zip.getEntries()[0].entryName);
    // A foreign drive prefix may be rejected on POSIX. Either rejection or
    // contained extraction is safe; all portable names must extract normally.
    let rejected = false;
    try { archive.extractAllTo(target, true); } catch (error) {
      if (!/^[A-Za-z]:/.test(entryName)) throw error;
      rejected = true;
    }
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
    // Canonicalized output must exist under target (not silently discard input).
    if (!rejected) {
      const files = readdirSync(target, { recursive: true }).filter(path => path.endsWith("escape.txt"));
      expect(files).toHaveLength(1);
      expect(readFileSync(join(target, files[0]), "utf8")).toBe("hostile");
    }
  },
);

it.each(["all", "entry", "async"])("rejects extraction through an existing symlink (%s)", async mode => {
  const root = fixture(), target = join(root, "extracted"), outside = join(root, "outside");
  mkdirSync(target); mkdirSync(outside);
  writeFileSync(join(outside, "sentinel.txt"), "unchanged");
  symlinkSync(outside, join(target, "link"), "junction");
  const AdmZip = onnxZip(), zip = new AdmZip();
  zip.addFile("link/sentinel.txt", Buffer.from("overwritten"));
  const archive = new AdmZip(zip.toBuffer());
  if (mode === "async") {
    await expect(new Promise((resolve, reject) => archive.extractAllToAsync(target, true, false,
      err => err ? reject(err) : resolve()))).rejects.toThrow();
  } else {
    expect(() => mode === "all" ? archive.extractAllTo(target, true)
      : archive.extractEntryTo("link/sentinel.txt", target, true, true)).toThrow();
  }
  expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
});

it("renders Mermaid math with the patched KaTeX copy", () => {
  const require = createRequire(join(packageRoot("mermaid", resolve(".")), "package.json"));
  const katex = require("katex");
  expect(katex.version).toBe("0.18.7");
  expect(katex.renderToString("c^2 = a^2 + b^2", { throwOnError: true })).toContain("katex-mathml");
});
