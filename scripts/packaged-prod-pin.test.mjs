// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATE: the packaged-build check refuses an app.asar whose control-plane module is not byte-identical to the source.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { packagedPinBytes, validatePackagedProdPin } from "./packaged-prod-pin.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const PIN = "electron/cloud-control-plane.mjs";
const CLIENT = "electron/control-plane-client.mjs";
const real = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const directories = [];
afterEach(() => { while (directories.length) removeTempDirSync(directories.pop()); });

/** Writes resources/app.asar in the asar format (Chromium pickle header + concatenated file data). */
function packAsar(files, { unpacked = [], mutate } = {}) {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "murage-prod-pin-test-"));
  directories.push(resources);
  const root = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [file, text] of Object.entries(files)) {
    const parts = file.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} });
    const data = Buffer.from(text, "utf8");
    if (unpacked.includes(file)) {
      node.files[parts.at(-1)] = { size: data.length, unpacked: true };
      const target = path.join(resources, "app.asar.unpacked", ...parts);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      continue;
    }
    node.files[parts.at(-1)] = { size: data.length, offset: String(offset) };
    chunks.push(data);
    offset += data.length;
  }
  mutate?.(root);
  const json = Buffer.from(JSON.stringify(root), "utf8");
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const pickle = Buffer.alloc(8);
  pickle.writeUInt32LE(padded.length + 4, 0);
  pickle.writeUInt32LE(json.length, 4);
  const headerPickle = Buffer.concat([pickle, padded]);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(headerPickle.length, 4);
  fs.writeFileSync(path.join(resources, "app.asar"), Buffer.concat([size, headerPickle, ...chunks]));
  return resources;
}

const pack = (pinSource, extra = {}, options) => packAsar({ "package.json": "{}", [CLIENT]: real(CLIENT), [PIN]: pinSource, ...extra }, options);
const REFUSED = /PACKAGED_PROD_PIN_(MISSING|MISMATCH)/;
const refuses = (resources, pattern = REFUSED) => expect(() => validatePackagedProdPin(resources)).toThrow(pattern);
const sourceSha = () => createHash("sha256").update(fs.readFileSync(path.join(ROOT, PIN))).digest("hex");
/** The real source with one byte changed (the last one flipped). */
const oneByteOff = () => { const bytes = fs.readFileSync(path.join(ROOT, PIN)); bytes[bytes.length - 1] ^= 1; return bytes.toString("latin1"); };

describe("packaged prod pin check", () => {
  it("passes an identical copy, read back byte for byte", () => {
    const resources = pack(real(PIN));
    expect(Buffer.compare(packagedPinBytes(resources), fs.readFileSync(path.join(ROOT, PIN)))).toBe(0);
    expect(validatePackagedProdPin(resources)).toEqual({ sha256: sourceSha() });
  });

  it("fails on a one-byte change", () => {
    const bytes = fs.readFileSync(path.join(ROOT, PIN));
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-prod-pin-src-"));
    directories.push(dir);
    const changed = path.join(dir, "cloud-control-plane.mjs");
    fs.writeFileSync(changed, bytes);
    refuses(pack(bytes.toString("latin1")), /PACKAGED_PROD_PIN_MISMATCH/);
    expect(() => validatePackagedProdPin(pack(real(PIN)), changed)).toThrow(/PACKAGED_PROD_PIN_MISMATCH/);
    refuses(pack(real(PIN) + " "), /PACKAGED_PROD_PIN_MISMATCH/);
    refuses(pack(real(PIN).slice(0, -1)), /PACKAGED_PROD_PIN_MISMATCH/);
  });

  it("fails when the archive or the source file is missing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "murage-prod-pin-test-"));
    directories.push(empty);
    refuses(empty, /PACKAGED_PROD_PIN_MISSING/);
    expect(() => validatePackagedProdPin(pack(real(PIN)), path.join(empty, "absent.mjs"))).toThrow(/ENOENT/);
    fs.writeFileSync(path.join(empty, "app.asar"), "not an archive at all");
    refuses(empty, /PACKAGED_PROD_PIN_MISSING/);
  });

  it("fails when the asar entry is absent, or is only a decoy path", () => {
    refuses(packAsar({ "package.json": "{}", [CLIENT]: real(CLIENT) }), /PACKAGED_PROD_PIN_MISSING/);
    refuses(packAsar({ "package.json": "{}", "electron/Cloud-control-plane.mjs": real(PIN) }), /PACKAGED_PROD_PIN_MISSING/);
    refuses(packAsar({ "package.json": "{}", "cloud-control-plane.mjs": real(PIN) }), /PACKAGED_PROD_PIN_MISSING/);
  });

  it("reads an archive written by electron-builder's own @electron/asar (identical passes, changed fails)", async () => {
    const fromBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
    const asar = createRequire(fromBuilder.resolve("app-builder-lib/package.json"))("@electron/asar");
    for (const [source, outcome] of [[real(PIN), "pass"], [oneByteOff(), "refuse"]]) {
      const app = fs.mkdtempSync(path.join(os.tmpdir(), "murage-prod-pin-app-"));
      const resources = fs.mkdtempSync(path.join(os.tmpdir(), "murage-prod-pin-res-"));
      directories.push(app, resources);
      fs.mkdirSync(path.join(app, "electron"));
      fs.writeFileSync(path.join(app, "package.json"), "{}");
      fs.writeFileSync(path.join(app, "electron", "big.bin"), Buffer.alloc(70000, 7));
      fs.writeFileSync(path.join(app, CLIENT), real(CLIENT));
      fs.writeFileSync(path.join(app, PIN), source, outcome === "pass" ? "utf8" : "latin1");
      await asar.createPackage(app, path.join(resources, "app.asar"));
      if (outcome === "pass") expect(validatePackagedProdPin(resources)).toEqual({ sha256: sourceSha() });
      else refuses(resources, /PACKAGED_PROD_PIN_MISMATCH/);
    }
  });

  it("accepts only a canonical decimal offset and an in-range, non-negative integer size", () => {
    const entryOf = (root) => root.files.electron.files["cloud-control-plane.mjs"];
    const withEntry = (change) => pack(real(PIN), {}, { mutate: (root) => change(entryOf(root)) });
    expect(validatePackagedProdPin(withEntry(() => {}))).toEqual({ sha256: sourceSha() });
    // Same position spelled another way: Number() would read each to the right offset, so only the canonical check refuses them.
    for (const spell of [(n) => `0x${n.toString(16)}`, (n) => `0${n}`, (n) => ` ${n}`, (n) => `+${n}`, (n) => `${n}.0`, (n) => n]) {
      refuses(withEntry((entry) => { entry.offset = spell(Number(entry.offset)); }), /PACKAGED_PROD_PIN_MISSING/);
    }
    for (const offset of ["-1", "-0", "", "1e2", "Infinity", null]) refuses(withEntry((entry) => { entry.offset = offset; }), /PACKAGED_PROD_PIN_MISSING/);
    // A negative offset reaching back into the header is refused even when the bytes there would be in the buffer.
    refuses(withEntry((entry) => { entry.offset = String(-1 - Number(entry.offset)); }), /PACKAGED_PROD_PIN_MISSING/);
    for (const size of [-1, 1.5, "10", null]) refuses(withEntry((entry) => { entry.size = size; }), /PACKAGED_PROD_PIN_MISSING/);
    refuses(withEntry((entry) => { entry.size += 1; }), /PACKAGED_PROD_PIN_MISSING/);
    refuses(withEntry((entry) => { entry.offset = String(Number(entry.offset) + 1); }), /PACKAGED_PROD_PIN_MISSING/);
  });

  it("hashes the archive bytes Electron loads when the unpacked flag is anything but boolean true", () => {
    for (const flag of ["yes", 1, "true", {}]) {
      const resources = pack(oneByteOff(), {}, { mutate: (root) => { root.files.electron.files["cloud-control-plane.mjs"].unpacked = flag; } });
      const onDisk = path.join(resources, "app.asar.unpacked", PIN);
      fs.mkdirSync(path.dirname(onDisk), { recursive: true });
      fs.writeFileSync(onDisk, fs.readFileSync(path.join(ROOT, PIN)));
      refuses(resources, /PACKAGED_PROD_PIN_MISMATCH/);
    }
  });

  it("passes an identical regular file in app.asar.unpacked, refuses a symlink there", () => {
    expect(validatePackagedProdPin(pack(real(PIN), {}, { unpacked: [PIN] }))).toEqual({ sha256: sourceSha() });
    const resources = pack(real(PIN), {}, { unpacked: [PIN] });
    const unpacked = path.join(resources, "app.asar.unpacked", PIN);
    fs.rmSync(unpacked);
    fs.symlinkSync(path.join(ROOT, PIN), unpacked);
    refuses(resources, /PACKAGED_PROD_PIN_MISSING/);
  });

  it("afterPack runs the check for every real (packager) build", () => {
    const afterPack = real("scripts/after-pack.mjs");
    expect(afterPack).toContain('import { validatePackagedProdPin } from "./packaged-prod-pin.mjs";');
    expect(afterPack).toMatch(/if \(context\.packager\) console\.log\("control-plane pin:", JSON\.stringify\(await validatePackagedProdPin\(resources\)\)\);/);
  });
});
