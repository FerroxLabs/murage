// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { crc32, inflateRawSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listSite } from "./site-files.ts";
import { zipStore } from "./zip.ts";

let base = "";
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "publish-zip-"))); mkdirSync(join(base, "site")); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A small independent reader: walks the central directory, checks each CRC. */
function readZip(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10); let at = zip.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16), size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32), local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size); const data = method === 8 ? inflateRawSync(raw) : raw;
    expect(crc32(data)).toBe(crc);
    out[name] = data.toString("utf8"); at += 46 + nameLength + extra + comment;
  }
  return out;
}

it("zips exactly the listed files with their bytes and relative names", () => {
  mkdirSync(join(base, "site", "css")); writeFileSync(join(base, "site", "index.html"), "<h1>ünï</h1>"); writeFileSync(join(base, "site", "css", "a.css"), "body{}");
  writeFileSync(join(base, "site", ".env"), "TOKEN=1");
  const zip = zipStore(listSite(join(base, "site")).files);
  expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(readZip(zip)).toEqual({ "css/a.css": "body{}", "index.html": "<h1>ünï</h1>" });
});

it("zips an empty-content file", () => {
  writeFileSync(join(base, "site", "index.html"), "");
  expect(readZip(zipStore(listSite(join(base, "site")).files))).toEqual({ "index.html": "" });
});

it("zips the snapshot, not what is on disk afterwards", () => {
  writeFileSync(join(base, "site", "index.html"), "approved");
  const { files } = listSite(join(base, "site"));
  rmSync(join(base, "site", "index.html")); writeFileSync(join(base, "outside.txt"), "private"); symlinkSync(join(base, "outside.txt"), join(base, "site", "index.html"));
  expect(readZip(zipStore(files))).toEqual({ "index.html": "approved" });
});
