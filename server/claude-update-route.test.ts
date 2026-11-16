// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// POST /api/instances/:id/claude-update against the real harness (0.1.61
// triage row 2). The Claude engine under test is a small script standing in
// for the CLI: it records its arguments and prints a version.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
let log: string;

async function call(path: string, extra: Record<string, string> = headers) {
  const response = await fetch(fixture.info.url + path, { method: "POST", headers: { ...extra, "content-type": "application/json" }, body: "{}" });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 18_799, span: 10_000 } });
  log = join(fixture.info.dataDir, "claude-update-calls.log");
  const script = join(fixture.info.dataDir, "claude-stand-in.cjs");
  writeFileSync(script, `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},process.argv.slice(2).join(' ')+'\\n');if(process.argv[2]==='--version')console.log('2.1.280 (Claude Code)');`);
  const configPath = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.instances.updatable = { driver: "claudeAgent", displayName: "Updatable Claude", config: { cli: `"${process.execPath}" "${script}"` } };
  config.instances.hermes = { driver: "hermesAgent", config: { cli: `"${process.execPath}" "${script}"` } };
  writeFileSync(configPath, JSON.stringify(config));
  await fixture.restart();
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret?: unknown };
  if (typeof proof.secret !== "string") throw new Error("Missing fixture desktop proof");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  // Await the registry's completed startup scan before either test resets the
  // call log. A Node CLI can still be starting when health becomes ready.
  const described = await fetch(`${fixture.info.url}/api/instances`, { headers });
  expect(described.status).toBe(200);
  const view = await described.json() as { instances: Array<{ instanceId: string; snapshot: { version?: string } }> };
  expect(view.instances.find(instance => instance.instanceId === "updatable")?.snapshot.version).toBe("2.1.280 (Claude Code)");
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

describe("Update Claude for me", () => {
  it("is desktop only and only for a Claude engine", async () => {
    // Engine probes at start also run the stand-in; only what follows counts.
    writeFileSync(log, "");
    expect((await call("/api/instances/updatable/claude-update", {})).status).toBe(404);
    expect((await call("/api/instances/missing/claude-update")).status).toBe(404);
    expect((await call("/api/instances/hermes/claude-update")).status).toBe(400);
    expect(readFileSync(log, "utf8")).not.toMatch(/^update$/m);
  });

  it("runs the engine's own updater, then reports the installed version", async () => {
    writeFileSync(log, "");
    const { status, body } = await call("/api/instances/updatable/claude-update");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, version: "2.1.280 (Claude Code)" });
    // A sign-in probe can land in the log at any moment; only the updater's calls count.
    const calls = readFileSync(log, "utf8").trim().split("\n").filter((line) => !line.startsWith("auth "));
    expect(calls).toEqual(["update", "--version"]);
  });
});
