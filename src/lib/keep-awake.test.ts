// The keep-awake offer.
//
// A phone reaches Murage through this computer, so a computer that has gone
// to sleep looks, from the phone, exactly like a broken app. The offer is how
// the owner finds out that is a choice. It must not overpromise: a laptop
// with its lid shut sleeps whatever an app asks, and the copy has to say so.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CompanionBridge, CompanionState } from "@/components/PhoneSetupFlow";
import { KEEP_AWAKE_DETAIL, KEEP_AWAKE_LABEL, keepAwakeCall, keepAwakeOffer } from "./keep-awake";

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null, ...over,
});

describe("when the offer is made", () => {
  it("offers nothing while the sidecar is off or failed", () => {
    expect(keepAwakeOffer(null, false)).toBeNull();
    expect(keepAwakeOffer(state({ enabled: false }), false)).toBeNull();
    expect(keepAwakeOffer(state({ error: "sidecar stopped responding" }), false)).toBeNull();
  });

  it("mirrors the saved setting, and waits while something else is in flight", () => {
    expect(keepAwakeOffer(state(), false)).toEqual({ checked: false, disabled: false });
    expect(keepAwakeOffer(state({ keepAwake: true }), true)).toEqual({ checked: true, disabled: true });
  });

  it("flips the setting through the bridge, never anything else", async () => {
    const asked: boolean[] = [];
    const bridge = { keepAwake: async (enabled: boolean) => { asked.push(enabled); return state({ keepAwake: enabled }); } } as unknown as CompanionBridge;
    await keepAwakeCall({ checked: false, disabled: false })(bridge);
    await keepAwakeCall({ checked: true, disabled: false })(bridge);
    expect(asked).toEqual([true, false]);
  });
});

describe("what the offer says", () => {
  it("says what it does in the owner's words", () => {
    expect(KEEP_AWAKE_LABEL).toBe("Keep this computer awake while a phone is paired");
  });

  it("says a closed lid still sleeps the computer", () => {
    expect(KEEP_AWAKE_DETAIL).toMatch(/closing the lid still puts/i);
    expect(KEEP_AWAKE_DETAIL).toMatch(/phone/);
  });
});

describe("where the offer is made", () => {
  const source = (file: string) => readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");

  it("is on the screen that says the device is ready", () => {
    const flow = source("PhoneSetupFlow.tsx");
    const start = flow.indexOf('c.phase === "success"');
    expect(flow.slice(start, flow.indexOf("return (\n    <div className=\"flex flex-col items-center text-center\">", start))).toContain("<KeepAwakeOffer");
  });

  it("stays reachable afterwards, next to the paired devices", () => {
    const panel = source("CompanionSection.tsx");
    const start = panel.indexOf('title="Paired devices"');
    expect(panel.slice(start, panel.indexOf('<Card title="Recent activity">', start))).toContain("<KeepAwakeOffer");
  });
});
