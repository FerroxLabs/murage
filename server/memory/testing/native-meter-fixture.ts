// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: c3-memory. Native BG enforcement owner: scperf-p1.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ioMeterSqlDeadline, resetIoMeterForTest } from "../../io-meter.ts";
import { forgetExclusionAddon } from "../../engine-exclusion.ts";

/** Memory fixtures exercise real checked background writers, including their
 * forked helpers. The engine-lock stand-in has no SQLite VFS or BG grants. */
export function prepareMemoryMeterFixture(home: string): void {
  if (ioMeterSqlDeadline()) return;
  if (process.platform === "win32") throw new Error("Memory fixtures require the built native I/O meter");
  const directory = join(home, "native-meter");
  mkdirSync(directory, { recursive: true });
  const binary = join(directory, "engine-exclusion.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC",
    ...(process.platform === "darwin" ? ["-bundle", "-undefined", "dynamic_lookup"] : ["-shared"]),
    "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"),
    "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary],
  { windowsHide: true, stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary;
  forgetExclusionAddon();
  resetIoMeterForTest();
}
