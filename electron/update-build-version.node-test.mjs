// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import { createUpdateDownloadVerifier, readMacZipBundleVersion, readWindowsPeVersion } from "./update-build-version.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const dirs = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "murage-build-version-")); dirs.push(dir); return dir; };
test.after(() => { for (const dir of dirs) safeWipeSync(dir); });

const plist = (version) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.murage.app</string>
<key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>
`);

/** A Squirrel.Mac style update ZIP (deflated, data descriptors, an __MACOSX folder like electron-builder's). */
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = deflateRawSync(content), nameBytes = Buffer.from(name), crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(nameBytes.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(data.length, 8); descriptor.writeUInt32LE(content.length, 12);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(nameBytes.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data, descriptor);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const macBuild = (version, extra = []) => zip([
  ["Murage.app/Contents/Info.plist", plist(version)],
  ["Murage.app/Contents/MacOS/Murage", Buffer.from("binary")],
  ["__MACOSX/Murage.app/Contents/._Info.plist", Buffer.from("appledouble")],
  ...extra,
]);

/** A PE32 with one .rsrc section holding one RT_VERSION resource, laid out the way NSIS writes it. */
function pe(productVersion, fixed = productVersion.split(/[.-]/).slice(0, 3).map(Number)) {
  const utf16 = (text) => Buffer.from(`${text}\0`, "utf16le");
  const pad = (buffer) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4)]);
  const block = (key, type, value, children = [], valueLength = value.length) => {
    const head = pad(Buffer.concat([Buffer.alloc(6), utf16(key)]));
    const body = Buffer.concat([head, pad(value), ...children.map(pad)]);
    body.writeUInt16LE(body.length, 0); body.writeUInt16LE(valueLength, 2); body.writeUInt16LE(type, 4);
    return body;
  };
  const string = (key, text) => block(key, 1, utf16(text), [], text.length + 1);
  const fixedInfo = Buffer.alloc(52);
  fixedInfo.writeUInt32LE(0xfeef04bd, 0); fixedInfo.writeUInt32LE(0x10000, 4);
  for (const at of [8, 16]) { fixedInfo.writeUInt32LE((fixed[0] << 16) | fixed[1], at); fixedInfo.writeUInt32LE(fixed[2] << 16, at + 4); }
  const info = block("VS_VERSION_INFO", 0, fixedInfo, [
    block("StringFileInfo", 1, Buffer.alloc(0), [block("040904b0", 1, Buffer.alloc(0), [string("FileVersion", productVersion), string("ProductVersion", productVersion)])]),
  ]);
  const rsrcRva = 0x2000, fileAlign = 0x200;
  const directory = (entries) => {
    const out = Buffer.alloc(16 + entries.length * 8);
    out.writeUInt16LE(entries.length, 14);
    entries.forEach(([id, target], i) => { out.writeUInt32LE(id, 16 + i * 8); out.writeUInt32LE(target >>> 0, 20 + i * 8); });
    return out;
  };
  // types dir (0): 16 -> names dir (24): 1 -> languages dir (48): 1033 -> data entry (72) -> VS_VERSIONINFO (88)
  const resources = Buffer.concat([
    directory([[16, 0x80000000 | 24]]), directory([[1, 0x80000000 | 48]]), directory([[1033, 72]]),
    (() => { const entry = Buffer.alloc(16); entry.writeUInt32LE(rsrcRva + 88, 0); entry.writeUInt32LE(info.length, 4); return entry; })(),
    info,
  ]);
  const headers = Buffer.alloc(fileAlign);
  headers.write("MZ", 0, "latin1"); headers.writeUInt32LE(0x80, 60);
  headers.writeUInt32LE(0x00004550, 0x80); headers.writeUInt16LE(0x14c, 0x84); headers.writeUInt16LE(1, 0x86); headers.writeUInt16LE(224, 0x94);
  const optional = 0x98;
  headers.writeUInt16LE(0x10b, optional); headers.writeUInt32LE(16, optional + 92);
  headers.writeUInt32LE(rsrcRva, optional + 96 + 16); headers.writeUInt32LE(resources.length, optional + 96 + 20);
  const section = optional + 224;
  headers.write(".rsrc", section, "latin1");
  headers.writeUInt32LE(resources.length, section + 8); headers.writeUInt32LE(rsrcRva, section + 12);
  const rawSize = Math.ceil(resources.length / fileAlign) * fileAlign;
  headers.writeUInt32LE(rawSize, section + 16); headers.writeUInt32LE(fileAlign, section + 20);
  return Buffer.concat([headers, resources, Buffer.alloc(rawSize - resources.length), Buffer.from("nsis payload")]);
}

const write = (name, bytes) => { const file = join(scratch(), name); writeFileSync(file, bytes); return file; };

test("reads the version a Mac update ZIP's app bundle carries", async () => {
  assert.equal(await readMacZipBundleVersion(write("Murage-1.0.4-arm64.zip", macBuild("1.0.4"))), "1.0.4");
});

test("a Mac ZIP with a second app bundle or a second Info.plist is refused", async () => {
  await assert.rejects(readMacZipBundleVersion(write("a.zip", macBuild("1.0.4", [["Other.app/Contents/Info.plist", plist("1.0.4")]]))), /exactly one app bundle/);
  await assert.rejects(readMacZipBundleVersion(write("b.zip", macBuild("1.0.4", [["murage.app/Contents/info.plist", plist("9.9.9")]]))), /exactly one app bundle/);
  await assert.rejects(readMacZipBundleVersion(write("c.zip", Buffer.from("not a zip"))), /end record/);
});

test("reads the ProductVersion and fixed version of a Windows installer", async () => {
  assert.deepEqual(await readWindowsPeVersion(write("Murage-1.0.4-setup.exe", pe("1.0.4"))), { productVersion: "1.0.4", fixedProductVersion: [1, 0, 4, 0] });
  await assert.rejects(readWindowsPeVersion(write("x.exe", Buffer.from("MZ not a program"))), /truncated|header/);
});

// A coordinator wired the way updater.mjs wires it, over an updater whose feed offers `offered` and whose download is `build`.
function coordinatorFor({ platform, offered, build, fallback = false }) {
  const updater = new EventEmitter();
  updater.on("error", () => {});
  updater.logger = { warn() {}, info() {}, error() {} };
  let state = { status: "idle" };
  let feed = "github";
  updater.checkForUpdates = async () => {
    if (fallback && feed === "github") {
      const error = Object.assign(new Error("No published versions on GitHub"), { code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS" });
      updater.emit("error", error);
      throw error;
    }
    updater.emit("update-available", { version: offered });
    return { isUpdateAvailable: true, updateInfo: { version: offered } };
  };
  updater.downloadUpdate = async () => { updater.emit("update-downloaded", { version: offered }); return [build]; };
  const coordinator = createUpdaterCoordinator(updater, (patch) => { state = { ...state, ...patch }; }, {
    verifyDownload: createUpdateDownloadVerifier({ platform, currentVersion: "1.0.3" }),
    ...(fallback ? { fallbackFeed: { activate: async () => { feed = "generic"; return true; }, reset: () => { feed = "github"; } } } : {}),
  });
  return { coordinator, state: () => state };
}

for (const [platform, name, older, current] of [
  ["darwin", "Murage-9.9.9-arm64.zip", () => macBuild("1.0.2"), () => macBuild("1.0.4")],
  ["win32", "Murage-9.9.9-setup.exe", () => pe("1.0.2"), () => pe("1.0.4")],
]) {
  test(`${platform}: a feed naming 9.9.9 that points at an older signed build is refused and the download removed`, async () => {
    const build = write(name, older());
    const h = coordinatorFor({ platform, offered: "9.9.9", build });
    await h.coordinator.check(true);
    assert.equal(h.state().status, "available");
    await h.coordinator.download();
    assert.equal(h.state().status, "error");
    assert.equal(existsSync(build), false);
  });

  test(`${platform}: the same refusal holds when the latest-release fallback found the feed`, async () => {
    const build = write(name, older());
    const h = coordinatorFor({ platform, offered: "9.9.9", build, fallback: true });
    await h.coordinator.check(true);
    assert.equal(h.state().status, "available", "the fallback lookup supplied the offer");
    await h.coordinator.download();
    assert.equal(h.state().status, "error");
  });

  test(`${platform}: a feed offering an older version than the running one is refused`, async () => {
    const build = write(name.replace("9.9.9", "1.0.2"), older());
    const h = coordinatorFor({ platform, offered: "1.0.2", build });
    await h.coordinator.download();
    assert.equal(h.state().status, "error");
  });

  test(`${platform}: a newer build that carries the offered version downloads, and is read again at install`, async () => {
    const build = write(name.replace("9.9.9", "1.0.4"), current());
    const h = coordinatorFor({ platform, offered: "1.0.4", build });
    await h.coordinator.download();
    assert.equal(h.state().status, "downloaded");
    assert.equal(h.state().version, "1.0.4");
    const verifier = createUpdateDownloadVerifier({ platform, currentVersion: "1.0.3" });
    const receipt = await verifier({ files: [build], version: "1.0.4" });
    writeFileSync(build, older());
    await assert.rejects(receipt.recheck(), { code: "ERR_MURAGE_UPDATE_VERIFICATION" });
  });
}

test("win32: an installer whose ProductVersion and fixed version disagree is refused", async () => {
  const verifier = createUpdateDownloadVerifier({ platform: "win32", currentVersion: "1.0.3" });
  await assert.rejects(verifier({ files: [write("Murage-1.0.4-setup.exe", pe("1.0.4", [1, 0, 2]))], version: "1.0.4" }), { code: "ERR_MURAGE_UPDATE_VERIFICATION" });
});
