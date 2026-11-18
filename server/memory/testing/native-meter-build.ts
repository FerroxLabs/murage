// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: c3-memory. Consumers: native-meter-fixture.ts (vitest) and the human specs whose own harness runs memory turns.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Compile the real engine-exclusion addon with its I/O meter (POSIX cc) into `directory` and return its path. It loads no
 * module and patches nothing in the calling process, so a Playwright worker can build one for a harness it spawns. */
export function buildNativeMeter(directory: string): string {
  if (process.platform === "win32") throw new Error("Memory fixtures require the built native I/O meter");
  mkdirSync(directory, { recursive: true });
  const binary = join(directory, "engine-exclusion.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC",
    ...(process.platform === "darwin" ? ["-bundle", "-undefined", "dynamic_lookup"] : ["-shared"]),
    "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"),
    join(ROOT, "native/engine-exclusion/exclusion.c"), join(ROOT, "native/engine-exclusion/meter.c"), "-o", binary],
  { windowsHide: true, stdio: "pipe" });
  return binary;
}
