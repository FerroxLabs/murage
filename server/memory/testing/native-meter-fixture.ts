// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: c3-memory. Native BG enforcement owner: scperf-p1.
import { join } from "node:path";
import { ioMeterSqlDeadline, resetIoMeterForTest } from "../../io-meter.ts";
import { forgetExclusionAddon } from "../../engine-exclusion.ts";
import { buildNativeMeter } from "./native-meter-build.ts";

/** Memory fixtures exercise real checked background writers, including their
 * forked helpers. The engine-lock stand-in has no SQLite VFS or BG grants. */
export function prepareMemoryMeterFixture(home: string): void {
  if (ioMeterSqlDeadline()) return;
  const binary = buildNativeMeter(join(home, "native-meter"));
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary;
  forgetExclusionAddon();
  resetIoMeterForTest();
}
