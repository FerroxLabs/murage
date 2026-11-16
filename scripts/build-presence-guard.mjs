// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { msvcCommand } from "./build-engine-exclusion.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const HEADERS = ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h", "node_version.h"];
const digest = value => createHash("sha256").update(value).digest("hex");

export function shareWindowHeader(table) {
  const rows = table.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (!rows.length) throw Error("PRESENCE_SHARE_TABLE_EMPTY");
  const entries = rows.map(row => {
    const [owner, layer, note, extra] = row.split("|").map(part => part.trim());
    if (extra !== undefined || !/^[a-zA-Z0-9. -]+$/.test(owner) || !/^\d{1,3}$/.test(layer ?? "") ||
        !note?.includes("unproven: S0 must confirm the exact owner and layer")) throw Error("PRESENCE_SHARE_TABLE_INVALID");
    return `  {${JSON.stringify(owner)}, ${Number(layer)}, ${note.startsWith("cover-display:")}},`;
  });
  return "// Copyright 2026 Ferrox Labs\n// SPDX-License-Identifier: AGPL-3.0-or-later\n" +
    "// Generated from share-windows.def. All rows await S0 observation.\n#pragma once\n" +
    "static const ShareWindowRule kShareWindowRules[] = {\n" + entries.join("\n") + "\n};\n";
}

/** Effects are injected so the command and receipt contract can run without a compiler. */
export function buildPresenceGuard({
  platform = process.platform, arch = process.arch, exec = execFileSync, env = process.env,
  environmentFile, io = fs, nodeVersion = process.versions.node,
  headerDirectory = env.NODE_HEADERS_DIR || path.resolve(path.dirname(fs.realpathSync(process.execPath)), "../include/node"),
  outputRoot = path.join(root, "dist-native/presence-guard"),
} = {}) {
  if (platform !== "darwin" && platform !== "win32") throw Error("PRESENCE_GUARD_PLATFORM_UNSUPPORTED: build on macOS or Windows");
  // msvcCommand selects the x64 developer environment. Do not label x64 code as another architecture.
  if (platform === "win32" && arch !== "x64") throw Error("PRESENCE_GUARD_WINDOWS_ARCH_UNSUPPORTED: x64 required");
  const headerSha256 = {};
  for (const name of HEADERS) {
    const file = path.join(headerDirectory, name);
    if (!io.existsSync(file)) throw Error("PRESENCE_GUARD_HEADERS_REQUIRED: " + name + " (set NODE_HEADERS_DIR)");
    headerSha256[name] = digest(io.readFileSync(file));
  }
  const version = io.readFileSync(path.join(headerDirectory, "node_version.h"), "utf8");
  const nodeHeadersVersion = ["MAJOR", "MINOR", "PATCH"].map(part =>
    new RegExp("^#define\\s+NODE_" + part + "_VERSION\\s+(\\d+)", "m").exec(version)?.[1] ?? "missing").join(".");
  if (nodeHeadersVersion !== nodeVersion) throw Error("PRESENCE_GUARD_HEADER_VERSION_MISMATCH");

  const source = path.join(root, "native/presence-guard", platform === "darwin" ? "presence-mac.mm" : "presence-win.cc");
  const lifetime = path.join(root, "native/presence-guard/lifetime.h");
  const sourceText = io.readFileSync(source, "utf8"), lifetimeText = io.readFileSync(lifetime, "utf8");
  const table = platform === "darwin" ? io.readFileSync(path.join(root, "native/presence-guard/share-windows.def"), "utf8") : "";
  const generated = platform === "darwin" ? shareWindowHeader(table) : null;
  const sourceSha256 = digest(sourceText + lifetimeText + table);
  const targets = platform === "darwin" ? [["arm64", "arm64"], ["x64", "x86_64"]] : [["x64", "x64"]];
  const outputs = [];
  for (const [targetArch, compilerArch] of targets) {
    const directory = path.join(outputRoot, platform + "-" + targetArch);
    io.mkdirSync(directory, { recursive: true });
    // A failed rebuild must not leave a receipt or image from a previous invocation.
    const output = path.join(directory, "presence-guard.node"), receiptFile = path.join(directory, "build.json");
    io.rmSync(receiptFile, { force: true });
    io.rmSync(output, { force: true });
    if (platform === "darwin") {
      io.writeFileSync(path.join(directory, "share-windows.generated.h"), generated);
      exec("/usr/bin/xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-fblocks", "-DNAPI_VERSION=9",
        "-mmacosx-version-min=12.0", "-arch", compilerArch, "-bundle", "-undefined", "dynamic_lookup",
        "-I", headerDirectory, "-I", directory, "-framework", "Foundation", "-framework", "AppKit",
        "-framework", "CoreGraphics", source, "-o", output], { timeout: 120000, stdio: "inherit" });
      exec("/usr/bin/lipo", [output, "-verify_arch", compilerArch], { timeout: 5000, stdio: "inherit" });
    } else {
      // Include shared inline helpers as well as the platform translation unit.
      const names = [...new Set((sourceText + "\n" + lifetimeText).match(/\bnapi_[a-z0-9_]+(?=\s*\()/g) || [])].sort();
      const def = path.join(directory, "node.def"), lib = path.join(directory, "node.lib");
      io.writeFileSync(def, "LIBRARY node.exe\nEXPORTS\n" + names.map(name => "  " + name).join("\n") + "\n");
      const run = (tool, args, timeout) => {
        const command = msvcCommand(tool, args, { env, environmentFile });
        exec(command.command, command.args, { timeout, stdio: "inherit", ...(command.verbatim ? { windowsVerbatimArguments: true } : {}) });
      };
      run("lib.exe", ["/nologo", "/def:" + def, "/machine:x64", "/out:" + lib], 60000);
      run("cl.exe", ["/nologo", "/std:c++17", "/EHsc", "/O2", "/W3", "/MT", "/LD", "/DNAPI_VERSION=9",
        "/I" + headerDirectory, source, "/Fo" + directory.replace(/\\/g, "/") + "/", "/Fe" + output,
        "/link", "/DELAYLOAD:node.exe", "delayimp.lib", "Shell32.lib", "User32.lib", lib], 120000);
    }
    const receipt = { version: 1, target: platform + "-" + targetArch, napiVersion: 9, nodeHeadersVersion,
      headerSha256, sourceSha256, sha256: digest(io.readFileSync(output)) };
    io.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
    outputs.push(receipt);
  }
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildPresenceGuard();
