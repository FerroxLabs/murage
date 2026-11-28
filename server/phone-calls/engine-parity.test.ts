// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// 1.0.23 slice F6 (design 1023-phone-fslices 3.5, pack P22): every driver that has Murage tools gets the same two Vapi tools, and a
// driver the matrix does not name fails this test. Capabilities come from each driver's own instance built from its default config
// (no engine process); the phone mount reads `agentsMcp` only, never `phoneMcp`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { PHONE_ENGINE_ABSENT, PHONE_TOOLS, phoneToolsFor } from "../drivers/phone-tool-schemas.ts";
import { phoneMount } from "./admission.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";

type Expect = "both" | "plain" | "config";
// The frozen matrix of the pack's section 8, by driverKind. A driver missing here fails "names every driver".
const MATRIX: Record<string, Expect> = {
  fuigoAgent: "both", grokAgent: "both", geminiAgent: "both", kimiAgent: "both", droidAgent: "both", cursorAgent: "both", opencodeGo: "both",
  qwenAgent: "both", hermesAgent: "both", clineAgent: "both", customAcp: "both", deepseekAgent: "both", copilotAgent: "both",
  commandCodeAgent: "both", kiroAgent: "both", ompAgent: "both", devinAgent: "both",
  claudeAgent: "both", codex: "both", piAgent: "both", museCode: "both",
  grok: "both", minimax: "both", "openai-compat": "both",
  openclawAgent: "plain", boxAgent: "plain",
  antigravityAgent: "config", // both tools with config.fullAuto, else the plain line; checked on its own below
};

let before: ReturnType<typeof setPhoneKeyFromShell>;
beforeAll(() => { before = setPhoneKeyFromShell({ key: "fixture-key", origin: PHONE_KEY_ORIGIN }); });
afterAll(() => _resetPhoneSecretsForTest());

async function capabilities(driver: (typeof BUILT_IN_DRIVERS)[number], patch: Record<string, unknown> = {}) {
  // a custom ACP engine is only made with a command; it is never run here
  if (driver.driverKind === "customAcp") patch = { cli: "fixture-agent acp", ...patch };
  const instance = await driver.create({ instanceId: `parity-${driver.driverKind}` as never, displayName: driver.driverKind, environment: {}, enabled: true, config: { ...(driver.defaultConfig() as object), ...patch } });
  try { return instance.adapter.capabilities as { agentsMcp?: boolean; phoneMcp?: boolean }; }
  finally { await (instance as { close?: () => Promise<void> | void }).close?.(); }
}
const verdict = (agentsMcp: boolean) => phoneMount({ agentsMcp, ownerAudience: true, botAllowed: true });

describe("P22 every driver with Murage tools gets the same two tools", () => {
  it("has a key set for the mount to read", () => { expect(before).toBe(true); });

  it("names every built-in driver in the matrix, and nothing else", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind as string).sort();
    expect(kinds.filter((kind) => !(kind in MATRIX)), "drivers the matrix does not name").toEqual([]);
    expect(Object.keys(MATRIX).filter((kind) => !kinds.includes(kind)), "matrix names without a driver").toEqual([]);
  });

  it("mounts both tools for each 'both tools' driver and the plain line for each 'plain line' driver", async () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const want = MATRIX[driver.driverKind as string];
      if (want === undefined || want === "config") continue;
      const caps = await capabilities(driver);
      const mount = verdict(caps.agentsMcp === true);
      if (want === "both") {
        expect(caps.agentsMcp, `${driver.driverKind} declares agentsMcp`).toBe(true);
        expect(mount, `${driver.driverKind} mounts`).toEqual({ mounted: true });
      } else {
        expect(caps.agentsMcp === true, `${driver.driverKind} declares no agentsMcp`).toBe(false);
        expect(mount, `${driver.driverKind} plain line`).toEqual({ mounted: false, line: PHONE_ENGINE_ABSENT });
      }
    }
    // the tools a mounted engine lists are the same two for every driver
    expect(phoneToolsFor("1").map((tool) => tool.name)).toEqual(["phone_call_place", "phone_call_result"]);
    expect(PHONE_TOOLS.map((tool) => tool.name)).toEqual(["phone_call_place", "phone_call_result"]);
  });

  it("gives Antigravity both tools in full-auto and the plain line otherwise", async () => {
    const agy = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "antigravityAgent")!;
    expect(verdict((await capabilities(agy, { fullAuto: true })).agentsMcp === true)).toEqual({ mounted: true });
    expect(verdict((await capabilities(agy, { fullAuto: false })).agentsMcp === true)).toEqual({ mounted: false, line: PHONE_ENGINE_ABSENT });
  });

  it("never consults phoneMcp: the paired-handset capability does not mount the Vapi tools", () => {
    expect(phoneMount({ agentsMcp: false, phoneMcp: true, ownerAudience: true, botAllowed: true } as never)).toEqual({ mounted: false, line: PHONE_ENGINE_ABSENT });
    expect(phoneMount({ agentsMcp: true, phoneMcp: false, ownerAudience: true, botAllowed: true } as never)).toEqual({ mounted: true });
  });
});
