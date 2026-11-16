// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";

// Owners: p1-owner-stall diagnoses product; gnl-harness owns the runner contract.
it("single gate cd row reaches native action and a terminal event", async () => {
  const out = mkdtempSync(join(tmpdir(), "p1-owner-probe-"));
  let fixture: any, passed = false;
  try {
    const runner = await import(pathToFileURL(resolve("scripts/no-limits-live/run.mjs")).href);
    const { scenarios } = await import(pathToFileURL(resolve("scripts/no-limits-live/scenarios.mjs")).href);
    const engine = { id: "codex", driver: "codex", model: "gpt-5.4", path: resolve("scripts/no-limits-live/launchers/codex.mjs"),
      environment: { NOLIM_RELEASE_FAKE: "1" } };
    fixture = await runner.launchLive(out, [engine]);
    await fixture.client.connect();
    const result = await runner.runScenarioCapped(fixture, engine, scenarios.find((spec: any) => spec.id === "cd"), undefined, 12000);
    console.log("OWNER_PROBE gate result", JSON.stringify(result));
    expect(result.complete).toBe(true);
    expect(result.actionProven).toBe(true);
    expect(result.ended).toBe(true);
    const native = readFileSync(join(fixture.data, "nolim-native-events.ndjson"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(native.some(event => event.type === "item.started" && event.provider === "codex"
      && event.input?.command.startsWith("cd "))).toBe(true);
    expect(native.some(event => event.type === "item.completed" && event.provider === "codex" && event.ok === true)).toBe(true);
    passed = true;
  } finally {
    await fixture?.client.disconnect();
    await fixture?.close();
    if (!passed && existsSync(join(out, "server.log"))) console.log(readFileSync(join(out, "server.log"), "utf8"));
    await removeTempDir(out);
  }
}, 120000);
