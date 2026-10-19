// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN r3 T4 (adapter half): the admission fence runs inside each text-only adapter after its last await and immediately before
// the request leaves (HTTP: after checkLocalServerUrl, before fetch) or the process starts (headless: after the intent write, before
// spawnCli, inside the pre-spawn try so the temp root is removed). A moved read surfaces as ReadMoved, never as a transient refusal.
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdmissionFenceAnswer, TextOnlyTurnInput, TransportIntent } from "../memory/pip-transport.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const gate = vi.hoisted(() => ({ wait: null as null | (() => Promise<void>) }));
vi.mock("../local-address-guard.ts", async original => {
  const real = await original<typeof import("../local-address-guard.ts")>();
  return { ...real, checkLocalServerUrl: async (url: string) => { await gate.wait?.(); return real.checkLocalServerUrl(url); } };
});
const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock("../procs.ts", async original => {
  const real = await original<typeof import("../procs.ts")>();
  return { ...real, spawnCli: (...args: Parameters<typeof real.spawnCli>) => { spawned.count++; return real.spawnCli(...args); } };
});
const { httpTextOnlyTurn } = await import("./http-text-only.ts");
const { headlessTextOnlyTurn } = await import("./headless-text-only.ts");

const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false };
const turn = (fence: () => AdmissionFenceAnswer, over: Partial<TextOnlyTurnInput> = {}): TextOnlyTurnInput => ({
  system: "SYS", text: "USER", model: "model-x", outputSchema: SCHEMA, signal: new AbortController().signal,
  maxOutputTokens: 1500, maxOutputBytes: 12 * 1024, context: { botId: "b", runId: "r", family: "lived", attempt: 1 },
  ...over, transport: { ...over.transport, fence },
});
/** A fence that reads "none" until the adapter's await has let the read move. */
function movingFence(answer: "moved" | "off") {
  let moved = false, calls = 0;
  gate.wait = async () => { await new Promise(resolve => setImmediate(resolve)); moved = true; };
  return { fence: () => { calls++; return moved ? answer : "none" as const; }, calls: () => calls };
}
afterEach(() => { gate.wait = null; spawned.count = 0; });

describe("HTTP: fenced after checkLocalServerUrl, before fetch", () => {
  const options = (fetchImpl: typeof fetch) => ({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model: string, messages: unknown[]) => ({ model, messages }), fetchImpl });
  it.each(["moved", "off"] as const)("a read %s while the address check awaited: ReadMoved, never request-failed, and fetch is never called", async answer => {
    const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const f = movingFence(answer);
    await expect(httpTextOnlyTurn(turn(f.fence), options(fetchImpl))).rejects.toMatchObject({ name: "read-moved", kind: answer });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.calls()).toBe(1);
  });
  it("a read that did not move is sent", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const r = await httpTextOnlyTurn(turn(() => "none"), options(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.verdict.state).toBe("validated");
  });
});

describe.skipIf(process.platform === "win32")("headless: fenced after the intent write, before spawnCli, inside the pre-spawn try", () => {
  const STUB = fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url));
  let base: string, etc: string, home: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "pip-fence-")); etc = join(base, "etc"); home = join(base, "home"); mkdirSync(etc); mkdirSync(home); });
  afterEach(() => removeTempDirSync(base));
  const cfg = () => ({
    engine: "fuigo" as const, cli: process.execPath, cliPrefixArgs: [STUB, "--stub=ok", `--stub-out=${join(base, "rec.jsonl")}`], tmpBase: join(base, "tmp"),
    pathValue: "/usr/bin:/bin", fluxKey: "flux-test-key", postResultGraceMs: 3000,
    preflight: { etcRoot: etc, home, grokHome: join(home, ".grok"), platform: "linux" as const, mdmDir: null, claudeManagedPath: join(base, "no-managed.json") },
  });
  const roots = () => existsSync(join(base, "tmp")) ? readdirSync(join(base, "tmp")) : [];
  it.each(["moved", "off"] as const)("a read %s while onIntent awaited: no process exists and the temp root is gone", async answer => {
    let moved = false, seenRoot = "";
    const onIntent = async (intent: TransportIntent) => { seenRoot = intent.tempRoot; expect(existsSync(intent.tempRoot)).toBe(true); await new Promise(resolve => setImmediate(resolve)); moved = true; };
    const input = turn(() => moved ? answer : "none", { transport: { hooks: { onIntent } } });
    await expect(headlessTextOnlyTurn(input, cfg())).rejects.toMatchObject({ name: "read-moved", kind: answer });
    expect(spawned.count).toBe(0);
    expect(seenRoot).not.toBe("");
    expect(existsSync(seenRoot)).toBe(false);
    expect(roots()).toEqual([]);
  });
  it("a read that did not move spawns the engine", async () => {
    const r = await headlessTextOnlyTurn(turn(() => "none"), cfg());
    expect(spawned.count).toBe(1);
    expect(r.verdict.state).toBe("validated");
  });
});
