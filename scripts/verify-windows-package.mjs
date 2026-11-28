#!/usr/bin/env node
// DESIGN 1022-cua-windows R4b / W-P4 (release-only): after electron-builder, the packaged Windows driver files are
// byte-for-byte the pinned ones (a folder copy re-signed under forceCodeSigning would change them), and nothing else
// is staged beside them. Owner: the Windows builder lane (build-1022-cua-windows).
// usage: node scripts/verify-windows-package.mjs release/win-unpacked/resources
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WINDOWS_CURSOR_SHA256, WINDOWS_DRIVER_SHA256 } from "../shared/cua-driver-windows-pins.mjs";

const resources = process.argv[2];
if (!resources) { console.error("usage: verify-windows-package.mjs <win-unpacked/resources>"); process.exit(2); }
const dir = path.join(resources, "cua-win32-x64");
const expected = { "cua-cursor-theme.exe": WINDOWS_CURSOR_SHA256, "cua-driver.exe": WINDOWS_DRIVER_SHA256 };
const present = fs.readdirSync(dir).sort();
const problems = [];
if (JSON.stringify(present) !== JSON.stringify(Object.keys(expected).sort())) problems.push(`staged files are ${present.join(", ")}`);
for (const [name, sha] of Object.entries(expected)) {
  const file = path.join(dir, name);
  const actual = fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "missing";
  if (actual !== sha) problems.push(`${name} sha256 ${actual} is not the pinned ${sha}`);
}
if (problems.length) { console.error(`packaged Windows driver check failed:\n  ${problems.join("\n  ")}`); process.exit(1); }
console.log("packaged Windows driver files match the pins");
