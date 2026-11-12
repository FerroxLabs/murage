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

/** Effects are injected so the command and receipt contract can run without a compiler. */
export function buildAnchoredRead({
  platform = process.platform, arch = process.arch, exec = execFileSync, env = process.env,
  environmentFile, io = fs, nodeVersion = process.versions.node,
  headerDirectory = env.NODE_HEADERS_DIR || path.resolve(path.dirname(fs.realpathSync(process.execPath)), "../include/node"),
  outputRoot = path.join(root, "dist-native/anchored-read"),
} = {}) {
  if (platform !== "darwin" && platform !== "win32") throw Error("ANCHORED_READ_PLATFORM_UNSUPPORTED: build on macOS or Windows");
  // msvcCommand selects the x64 developer environment. Do not label x64 code as another architecture.
  if (platform === "win32" && arch !== "x64") throw Error("ANCHORED_READ_WINDOWS_ARCH_UNSUPPORTED: x64 required");
  const headerSha256 = {};
  for (const name of HEADERS) {
    const file = path.join(headerDirectory, name);
    if (!io.existsSync(file)) throw Error("ANCHORED_READ_HEADERS_REQUIRED: " + name + " (set NODE_HEADERS_DIR)");
    headerSha256[name] = digest(io.readFileSync(file));
  }
  const version = io.readFileSync(path.join(headerDirectory, "node_version.h"), "utf8");
  const nodeHeadersVersion = ["MAJOR", "MINOR", "PATCH"].map(part =>
    new RegExp("^#define\\s+NODE_" + part + "_VERSION\\s+(\\d+)", "m").exec(version)?.[1] ?? "missing").join(".");
  if (nodeHeadersVersion !== nodeVersion) throw Error("ANCHORED_READ_HEADER_VERSION_MISMATCH");

  const source = path.join(root, "native/anchored-read", platform === "darwin" ? "anchored-posix.c" : "anchored-win.c");
  const lifetime = path.join(root, "native/anchored-read/common.h");
  const hostHook = path.join(root, "native/anchored-read/host-hook.c");
  const sourceText = io.readFileSync(source, "utf8"), lifetimeText = io.readFileSync(lifetime, "utf8");
  const sourceSha256 = digest(sourceText + lifetimeText + (platform === "win32" ? io.readFileSync(hostHook, "utf8") : ""));
  const targets = platform === "darwin" ? [["arm64", "arm64"], ["x64", "x86_64"]] : [["x64", "x64"]];
  const outputs = [];
  for (const [targetArch, compilerArch] of targets) {
    const directory = path.join(outputRoot, platform + "-" + targetArch);
    io.mkdirSync(directory, { recursive: true });
    // A failed rebuild must not leave a receipt or image from a previous invocation.
    const output = path.join(directory, "anchored-read.node"), receiptFile = path.join(directory, "build.json");
    io.rmSync(receiptFile, { force: true });
    io.rmSync(output, { force: true });
    if (platform === "darwin") {
      exec("/usr/bin/xcrun", ["clang", "-std=gnu11", "-O2", "-Wall", "-Wextra", "-Werror", "-DNAPI_VERSION=9",
        "-mmacosx-version-min=12.0", "-arch", compilerArch, "-bundle", "-undefined", "dynamic_lookup",
        "-I", headerDirectory, source, "-o", output], { timeout: 120000, stdio: "inherit" });
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
      run("cl.exe", ["/nologo", "/std:c11", "/O2", "/W3", "/MT", "/LD", "/DNAPI_VERSION=9",
        "/I" + headerDirectory, source, hostHook, "/Fo" + directory.replace(/\\/g, "/") + "/", "/Fe" + output,
        "/link", "/DELAYLOAD:node.exe", "delayimp.lib", lib], 120000);
    }
    const receipt = { version: 1, target: platform + "-" + targetArch, napiVersion: 9, nodeHeadersVersion,
      headerSha256, sourceSha256, sha256: digest(io.readFileSync(output)) };
    io.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
    outputs.push(receipt);
  }
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildAnchoredRead();
