// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance W10 (MAIN 2026-11-17 Q1): the real server's listen path closes the boot recoveries. A normal start of server/index.ts (a fresh
// process) with testing/boot-latch-preload.mjs reports each call to the boot-only goal reconcile and to `closeBootRecoveries`; the start must run
// the reconcile once, then close the latch once, before it says it is serving. R5 (bootdesign2-probes) makes the same call in its own store.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { healthOk, startServer, waitExited } from "./testing/strict-fs.ts";

const PRELOAD = pathToFileURL(join(import.meta.dirname, "testing", "boot-latch-preload.mjs")).href;

it("W10 a normal start of the real server reconciles the last run's goals, then closes the boot recoveries at listen, once", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "boot-latch-")), home = join(root, "home"), data = join(home, ".murage");
  mkdirSync(data, { recursive: true }); writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
  try {
    const port = await freePortBlock([0, 1], 19_771, 200);
    const run = startServer(home, port, { NODE_OPTIONS: `--import=${PRELOAD}` });
    try {
      expect(await healthOk(port, run), run.out().slice(-4000)).toBe(true);
    } finally { run.child.kill("SIGTERM"); }
    expect(await waitExited(run), run.out().slice(-4000)).toBe(true);
    const order = run.out().split("\n").filter(line => line.startsWith("BOOT-LATCH ") || line.startsWith("murage server on "))
      .map(line => line.startsWith("murage server on ") ? "serving" : line.replace(/changed=\d+/, "changed"));
    expect(order).toEqual(["BOOT-LATCH reconcile changed", "BOOT-LATCH closed", "serving"]);
  } finally { removeTempDirSync(root); }
});
