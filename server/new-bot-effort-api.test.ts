// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The workspace effort for new bots, end to end (0.1.61 triage row 23): set
// through the config route, applied by POST /api/bots only where the engine
// offers the level, never over an explicit choice.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 18_799, span: 10_000 } });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret?: unknown };
  if (typeof proof.secret !== "string") throw new Error("Missing fixture desktop proof");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

describe("effort for new bots", () => {
  it("fills an offered level, keeps an explicit one, and clears with null", async () => {
    const { instances } = await call("GET", "/api/instances");
    const engine = instances.find((instance: { instanceId: string }) => instance.instanceId === "verification");
    const levels: string[] = engine.capabilities?.effortLevels ?? [];
    expect(levels.length).toBeGreaterThan(1);
    const level = levels.at(-1)!;
    const config = await call("PATCH", "/api/config", { newBots: { effort: level } });
    expect(config.newBots).toEqual({ effort: level });

    const selection = { instanceId: "verification", model: engine.models.default };
    const filled = await call("POST", "/api/bots", { name: "Filled", modelSelection: selection });
    expect(filled.bot.modelSelection.effort).toBe(level);
    const explicit = await call("POST", "/api/bots", { name: "Explicit", modelSelection: { ...selection, effort: levels[0] } });
    expect(explicit.bot.modelSelection.effort).toBe(levels[0]);

    expect((await call("PATCH", "/api/config", { newBots: { effort: null } })).newBots).toEqual({});
    const plain = await call("POST", "/api/bots", { name: "Plain", modelSelection: selection });
    expect(plain.bot.modelSelection.effort).toBeUndefined();
  });
});
