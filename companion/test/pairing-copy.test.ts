// 0.1.60 audit M1, M2: pairing refusals are rendered verbatim on the browser
// door's /enter page (browser.ts `say("Could not sign in", body.error)` and
// the typed-code `note.textContent = body.error`). The copy rules say no em
// dash and no raw error codes or computer paths reach a person.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../src/state.ts";
import { DeviceRegistry, MAX_PAIRING_ATTEMPTS, PAIRING_SAVE_FAILED } from "../src/devices.ts";

describe("pairing refusal copy shown on /enter", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("an expired / used / burned / wrong code sentence carries no em dash", () => {
    const registry = new DeviceRegistry();
    const { code } = registry.openPairing();
    registry.closePairing(); // spent as "expired"
    const expired = registry.redeem(code, "Phone");
    expect("error" in expired && expired.error).not.toMatch(/—/);
  });

  it("a locked-out window sentence carries no em dash", () => {
    const registry = new DeviceRegistry();
    registry.openPairing();
    let last: ReturnType<DeviceRegistry["redeem"]> | undefined;
    for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i++) last = registry.redeem("000000x", "Phone");
    expect(last && "error" in last && last.error).not.toMatch(/—/);
  });

  it("a failed save does not show the raw filesystem error to the person", () => {
    const registry = new DeviceRegistry();
    const { code } = registry.openPairing();
    // devices.json becomes a non-empty directory: the atomic rename fails.
    mkdirSync(join(DATA_DIR, "devices.json", "x"), { recursive: true });
    writeFileSync(join(DATA_DIR, "devices.json", "x", "y"), "y");
    const result = registry.redeem(code, "Phone");
    expect(result).toMatchObject({ reason: "save-failed" });
    const error = "error" in result ? result.error : "";
    expect(error).not.toMatch(/\bE[A-Z]{3,}\b|\/|rename|mkdir/);
    expect(error).toBe(PAIRING_SAVE_FAILED);
  });

  it("the failed save's details go to this computer's log instead", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new DeviceRegistry();
      const { code } = registry.openPairing();
      mkdirSync(join(DATA_DIR, "devices.json", "x"), { recursive: true });
      writeFileSync(join(DATA_DIR, "devices.json", "x", "y"), "y");
      registry.redeem(code, "Phone");
      expect(warn.mock.calls.flat().join(" ")).toMatch(/could not save the pairing: .*devices\.json/);
      // Nothing was paired: the rollback holds.
      expect(registry.list()).toEqual([]);
    } finally { warn.mockRestore(); }
  });
});
