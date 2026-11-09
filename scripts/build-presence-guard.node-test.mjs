// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPresenceGuard, shareWindowHeader } from "./build-presence-guard.mjs";
import { collectPresenceEvidence } from "./presence-guard-evidence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = text => createHash("sha256").update(text).digest("hex");
function fixture() {
  const headerDirectory = path.resolve("fixture headers"), outputRoot = path.resolve("fixture output");
  const files = new Map(), calls = [], events = [];
  for (const name of ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"]) files.set(path.join(headerDirectory, name), name);
  files.set(path.join(headerDirectory, "node_version.h"), "#define NODE_MAJOR_VERSION 24\n#define NODE_MINOR_VERSION 20\n#define NODE_PATCH_VERSION 0\n");
  const io = {
    existsSync: file => files.has(file),
    readFileSync: (file, encoding) => files.has(file) ? (encoding ? String(files.get(file)) : Buffer.from(files.get(file))) : readFileSync(file, encoding),
    writeFileSync: (file, text) => { events.push(["write", file]); files.set(file, text); },
    mkdirSync: () => {},
    rmSync: file => files.delete(file),
  };
  const exec = (command, args, options) => {
    calls.push({ command, args, options }); events.push(["exec", command]);
    if (command === "/usr/bin/xcrun") files.set(args.at(-1), "fixture Mach-O " + args[args.indexOf("-arch") + 1]);
    if (command === "cl.exe") files.set(args.find(arg => arg.startsWith("/Fe")).slice(3), "fixture PE");
  };
  return { files, calls, events, options: { io, exec, headerDirectory, outputRoot, nodeVersion: "24.20.0", arch: "x64", env: { VSCMD_ARG_TGT_ARCH: "x64" } } };
}

test("Mac builds and verifies both exact architectures before writing each receipt", () => {
  const f = fixture(), { headerDirectory, outputRoot } = f.options;
  const receipts = buildPresenceGuard({ ...f.options, platform: "darwin" });
  const expected = [];
  for (const [arch, target] of [["arm64", "arm64"], ["x64", "x86_64"]]) {
    const directory = path.join(outputRoot, "darwin-" + arch), output = path.join(directory, "presence-guard.node");
    expected.push({ command: "/usr/bin/xcrun", args: ["clang++", "-std=c++17", "-fobjc-arc", "-fblocks", "-DNAPI_VERSION=9",
      "-mmacosx-version-min=12.0", "-arch", target, "-bundle", "-undefined", "dynamic_lookup", "-I", headerDirectory,
      "-I", directory, "-framework", "Foundation", "-framework", "AppKit", "-framework", "CoreGraphics",
      path.join(root, "native/presence-guard/presence-mac.mm"), "-o", output], options: { timeout: 120000, stdio: "inherit" } });
    expected.push({ command: "/usr/bin/lipo", args: [output, "-verify_arch", target], options: { timeout: 5000, stdio: "inherit" } });
    const receiptFile = path.join(directory, "build.json");
    const writeIndex = f.events.findIndex(([op, file]) => op === "write" && file === receiptFile);
    assert.deepEqual(f.events[writeIndex - 1], ["exec", "/usr/bin/lipo"]);
    assert.equal(JSON.parse(f.files.get(receiptFile)).sha256, hash(f.files.get(output)));
    assert.match(f.files.get(path.join(directory, "share-windows.generated.h")), /"zoom\.us"/);
  }
  assert.deepEqual(f.calls, expected);
  assert.deepEqual(receipts.map(r => r.target), ["darwin-arm64", "darwin-x64"]);
  assert.equal(receipts[0].nodeHeadersVersion, "24.20.0");
  assert.equal(receipts[0].headerSha256["node_api.h"], hash("node_api.h"));
  assert.equal(receipts[0].sourceSha256, hash(["presence-mac.mm", "lifetime.h", "share-windows.def"].map(name => readFileSync(path.join(root, "native/presence-guard", name), "utf8")).join("")));
});

test("Windows makes the Node import library then compiles C++17 with the static runtime and system libraries", () => {
  const f = fixture(), { headerDirectory, outputRoot } = f.options;
  const directory = path.join(outputRoot, "win32-x64"), lib = path.join(directory, "node.lib"), def = path.join(directory, "node.def");
  const receipts = buildPresenceGuard({ ...f.options, platform: "win32" });
  assert.deepEqual(f.calls, [
    { command: "lib.exe", args: ["/nologo", "/def:" + def, "/machine:x64", "/out:" + lib], options: { timeout: 60000, stdio: "inherit" } },
    { command: "cl.exe", args: ["/nologo", "/std:c++17", "/EHsc", "/O2", "/W3", "/MT", "/LD", "/DNAPI_VERSION=9",
      "/I" + headerDirectory, path.join(root, "native/presence-guard/presence-win.cc"), "/Fo" + directory.replace(/\\/g, "/") + "/",
      "/Fe" + path.join(directory, "presence-guard.node"), "/link", "/DELAYLOAD:node.exe", "delayimp.lib", "Shell32.lib", "User32.lib", lib], options: { timeout: 120000, stdio: "inherit" } },
  ]);
  const imports = f.files.get(def).split("\n").slice(2).filter(Boolean).map(s => s.trim());
  assert.equal(new Set(imports).size, imports.length);
  assert.ok(imports.includes("napi_create_threadsafe_function"));
  assert.ok(imports.includes("napi_add_env_cleanup_hook"));
  assert.ok(imports.includes("napi_get_boolean"));
  assert.ok(imports.every(name => /^napi_/.test(name)));
  assert.equal(receipts[0].sha256, hash("fixture PE"));
  assert.equal(receipts[0].sourceSha256, hash(["presence-win.cc", "lifetime.h"].map(name => readFileSync(path.join(root, "native/presence-guard", name), "utf8")).join("")));
});

test("Windows invokes VsDevCmd when the developer environment is absent", () => {
  const f = fixture();
  f.files.set(path.join(f.options.outputRoot, "win32-x64/presence-guard.node"), "stale");
  const exec = (command, args, options) => {
    f.calls.push({ command, args, options });
    if (args[3].includes(" && cl.exe ")) f.files.set(path.join(f.options.outputRoot, "win32-x64/presence-guard.node"), "fixture PE");
  };
  buildPresenceGuard({ ...f.options, exec, platform: "win32", env: { ComSpec: "cmd.exe" }, environmentFile: "C:\\VS Tools\\VsDevCmd.bat" });
  assert.equal(f.calls.length, 2);
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.command, "cmd.exe");
    assert.deepEqual(call.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.ok(call.args[3].startsWith('call "C:\\VS Tools\\VsDevCmd.bat" -arch=x64 -host_arch=x64 && ' + ["lib.exe", "cl.exe"][index] + " "));
    assert.equal(call.options.windowsVerbatimArguments, true);
  }
});

test("unsupported platforms, Windows architectures, missing headers and mismatched headers refuse before compiling", () => {
  for (const extra of [{ platform: "linux" }, { platform: "win32", arch: "arm64" }, { platform: "darwin", nodeVersion: "24.19.0" }]) {
    const f = fixture();
    assert.throws(() => buildPresenceGuard({ ...f.options, ...extra }), /PRESENCE_GUARD_/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.events.length, 0);
  }
  const f = fixture();
  f.files.delete(path.join(f.options.headerDirectory, "node_api.h"));
  assert.throws(() => buildPresenceGuard({ ...f.options, platform: "darwin" }), /HEADERS_REQUIRED/);
  assert.equal(f.calls.length, 0);
});

test("compile and architecture verification failures leave no success receipt, including on rebuild", () => {
  for (const failedCommand of ["/usr/bin/xcrun", "/usr/bin/lipo", "cl.exe"]) {
    const f = fixture(), platform = failedCommand === "cl.exe" ? "win32" : "darwin";
    const receiptFile = path.join(f.options.outputRoot, platform === "win32" ? "win32-x64" : "darwin-arm64", "build.json");
    f.files.set(receiptFile, "stale receipt");
    const exec = (command, ...args) => { if (command === failedCommand) throw Error("compiler fixture refusal"); return f.options.exec(command, ...args); };
    assert.throws(() => buildPresenceGuard({ ...f.options, platform, exec }), /fixture refusal/);
    assert.equal(f.files.has(receiptFile), false);
  }
});

test("the share table compiles owner and layer rules with a display coverage requirement for slideshows", () => {
  const table = readFileSync(new URL("../native/presence-guard/share-windows.def", import.meta.url), "utf8");
  const header = shareWindowHeader(table);
  for (const owner of ["zoom.us", "Microsoft Teams", "Webex", "Slack"]) assert.ok(header.includes(`{"${owner}", 25, false}`));
  for (const owner of ["Keynote", "Microsoft PowerPoint"]) assert.ok(header.includes(`{"${owner}", 0, true}`));
  assert.throws(() => shareWindowHeader("Zoom|25|unconfirmed"), /TABLE_INVALID/);
  assert.throws(() => shareWindowHeader("# no rows"), /TABLE_EMPTY/);
});

test("evidence requires boolean snapshots and exercises replacement and repeated unsubscribe in order", () => {
  const calls = [], stops = [];
  let time = 0;
  const addon = {
    read: () => { calls.push("read"); return { fullscreen: false, sharing: true, focus: false }; },
    onChange: callback => {
      assert.equal(typeof callback, "function");
      const id = stops.length;
      calls.push("subscribe " + id);
      const stop = () => calls.push("stop " + id);
      stops.push(stop);
      return stop;
    },
  };
  const evidence = collectPresenceEvidence({ addon, platform: "fixture", arch: "x64", now: () => time++ });
  assert.deepEqual(calls, ["read", "subscribe 0", "subscribe 1", "stop 0", "stop 0", "stop 1", "stop 1", "stop 0", "stop 1"]);
  assert.equal(evidence.read.sharing, true);
  assert.equal(evidence.readDurationMs, 1);
  assert.equal(evidence.onChange.subscribeUnsubscribeOk, true);
  assert.throws(() => collectPresenceEvidence({ addon: { ...addon, read: () => ({ fullscreen: 1, sharing: false, focus: false }) } }));
  assert.equal(calls.length, 9);
});

test("evidence refuses missing exports and cleans up the first subscription when replacement fails", () => {
  assert.throws(() => collectPresenceEvidence({ addon: { read: () => ({}) } }), /ONCHANGE_EXPORT_REQUIRED/);
  let subscriptions = 0, stops = 0;
  const addon = {
    read: () => ({ fullscreen: false, sharing: false, focus: false }),
    onChange: () => {
      if (++subscriptions === 2) throw Error("replacement unavailable");
      return () => { stops++; };
    },
  };
  assert.throws(() => collectPresenceEvidence({ addon }), /replacement unavailable/);
  assert.equal(stops, 1);
});
