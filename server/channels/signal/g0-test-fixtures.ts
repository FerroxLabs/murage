// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared live-test precondition. No synthetic fallback and no skipped live gate.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
export function requireCommittedG0(): void {
  const pin = JSON.parse(readFileSync(resolve("server/channels/signal/runtime-pin.json"), "utf8"));
  if (pin.g0 == null) throw new Error("G0_REQUIRED: committed pin.g0 is null; Sean's reviewed live session is required (ci/gate-post-g0.txt)");
}
export function g0Frame(name: string): any {
  requireCommittedG0();
  const root = resolve("server/channels/signal/fixtures/g0");
  if (!existsSync(join(root, "manifest.json"))) throw new Error("G0_REQUIRED: reviewed live fixtures are absent (live qualification pending B1/B2; not behavioral RED)");
  return JSON.parse(readFileSync(join(root, `${name}.json`), "utf8"));
}
