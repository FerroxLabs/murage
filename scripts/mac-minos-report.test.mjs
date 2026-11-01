import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { fileSlices, reportApp } from "./mac-minos-report.mjs";

const encode = (major, minor = 0) => (major << 16) | (minor << 8);
function thin(minos, sdk = encode(15, 5)) {
  const out = Buffer.alloc(32 + 24);
  out.writeUInt32LE(0xfeedfacf, 0); out.writeUInt32LE(1, 16); out.writeUInt32LE(24, 20);
  out.writeUInt32LE(0x32, 32); out.writeUInt32LE(24, 36); out.writeUInt32LE(1, 40);
  out.writeUInt32LE(minos, 44); out.writeUInt32LE(sdk, 48);
  return out;
}
function fat(...slices) {
  const head = Buffer.alloc(8 + 20 * slices.length);
  head.writeUInt32BE(0xcafebabe, 0); head.writeUInt32BE(slices.length, 4);
  let offset = head.length; const parts = [head];
  slices.forEach((slice, i) => { head.writeUInt32BE(offset, 8 + i * 20 + 8); head.writeUInt32BE(slice.length, 8 + i * 20 + 12); parts.push(slice); offset += slice.length; });
  return Buffer.concat(parts);
}
const roots = [];
function app(files) {
  const root = mkdtempSync(join(tmpdir(), "minos-")); roots.push(root);
  const bundle = join(root, "Murage.app");
  mkdirSync(join(bundle, "Contents/Resources/gepa-worker"), { recursive: true });
  writeFileSync(join(bundle, "Contents/Info.plist"), "<plist><dict><key>LSMinimumSystemVersion</key>\n<string>12.0</string></dict></plist>");
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(bundle, name), bytes);
  return bundle;
}
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const script = fileURLToPath(new URL("./mac-minos-report.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

// Reads POSIX app bundles through bash; a Mac packaging gate has nothing to prove on Windows.
describe.skipIf(process.platform === "win32")("mac-minos-report", () => {
  it("reads the minimum macOS from thin and fat binaries, highest slice wins, and skips the rest", () => {
    const bundle = app({
      "Contents/thin": thin(encode(14, 8)),
      "Contents/fat": fat(thin(encode(12)), thin(encode(13))),
      "Contents/Class.class": Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]), Buffer.alloc(64)]),
      "Contents/text.txt": Buffer.alloc(64, 0x61),
    });
    const report = reportApp(bundle);
    expect(report.floor).toBe("12.0");
    expect(Object.fromEntries(report.binaries.map(b => [b.path, b.minos]))).toEqual({ "Contents/thin": "14.8.0", "Contents/fat": "13.0.0" });
    expect(fileSlices(join(bundle, "Contents/Class.class"))).toEqual([]);
  });

  it("fails when a binary rises above the floor, and an allow entry covers only its own path", () => {
    const bundle = app({ "Contents/Resources/gepa-worker/libpython": thin(encode(15, 8)) });
    expect(run(bundle).status).toBe(1);
    expect(run(bundle, "--allow", "^Contents/Resources/gepa-worker/").status).toBe(0);
    expect(run(bundle, "--allow", "^Contents/Resources/cloudflared/").status).toBe(1);
  });

  it("the gate refuses a GEPA worker that follows the runner to macOS 15, and passes the shipped 14.8", () => {
    const gate = fileURLToPath(new URL("./mac-minos-gate.sh", import.meta.url));
    const good = app({ "Contents/Resources/gepa-worker/libpython": thin(encode(14, 8)) });
    const bad = app({ "Contents/Resources/gepa-worker/libpython": thin(encode(15, 8)) });
    expect(() => execFileSync("bash", [gate, good, join(good, "..", "e.json")], { stdio: "pipe" })).not.toThrow();
    expect(spawnSync("bash", [gate, bad, join(bad, "..", "e.json")]).status).toBe(1);
  });
});

describe("Mac runner pins", () => {
  const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

  it("the Mac build jobs use the fixed macos-15 label, never a moving or retired one", () => {
    for (const path of [".github/workflows/release.yml", ".github/workflows/package-mac-qualification.yml", ".github/workflows/mac-notification-authorization-preflight.yml"]) {
      const labels = [...read(path).matchAll(/^\s*runs-on: (macos-\S+)/gm)].map(match => match[1]);
      expect(labels.length, path).toBeGreaterThan(0);
      expect(labels.filter(label => label !== "macos-15" && label !== "macos-15-intel"), path).toEqual([]);
    }
  });

  it("stapling goes over HTTPS in every job that staples", () => {
    for (const path of [".github/workflows/release.yml", ".github/workflows/package-mac-qualification.yml"]) {
      const text = read(path), block = text.indexOf("proto udp from any to any port 443"), staple = text.indexOf("xcrun stapler staple");
      expect(block, path).toBeGreaterThan(0);
      expect(staple, path).toBeGreaterThan(block);
    }
  });

  it("the GEPA build fixes its macOS target in the env configure actually sees", () => {
    expect(read("native/gepa/build-mac.py")).toMatch(/^env=\{[^\n]*"MACOSX_DEPLOYMENT_TARGET":"14\.8"/m);
  });
});
