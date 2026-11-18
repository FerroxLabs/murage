// SPDX-License-Identifier: AGPL-3.0-or-later
// ITEM 9 fail-closed guard (src/held-until-item9-highs.ts): until branch cloud-v2/item9-dormant-highs lands, CLOUD_AUTOTOPUP_ENABLED and
// DOOR_JOIN_REQUIRED read as OFF whatever the env says, at every reader. The no-claim, no-charge sweep case is in test/topup-charge.test.ts.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doorReadySql } from "../src/b3-control";
import { joinRequired } from "../src/device-join";
import { pairingRoute } from "../src/pairing";
import { HELD_UNTIL_ITEM9_HIGHS, releaseItem9HoldForTests } from "../src/held-until-item9-highs";
import { topupChargingEnabled } from "../src/topup-charge";
import wranglerText from "../wrangler.jsonc?raw";
import { stripJsonc } from "../scripts/check-deploy.mjs";

const ON = { CLOUD_AUTOTOPUP_ENABLED: "1", DOOR_JOIN_REQUIRED: "1", DOOR_V2_REQUIRED: "1" } as unknown as Env;

describe("ITEM 9 fail-closed guard", () => {
  afterEach(() => { releaseItem9HoldForTests(false); vi.restoreAllMocks(); });
  it("both switches set to 1 stay off: no top-up charging, no join requirement, no door_proof condition, one warn line each", () => {
    expect(HELD_UNTIL_ITEM9_HIGHS).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 3; i++) {
      expect(topupChargingEnabled(ON)).toBe(false);
      expect(joinRequired(ON)).toBe(false);
      expect(doorReadySql(ON)).toBe(" AND h.door_version='v2'");
    }
    expect(doorReadySql(ON)).not.toContain("door_proof");
    // At most one line per name for the isolate (an earlier suite in this isolate may already have written it).
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("autotopup_held_until_fix")).length).toBeLessThanOrEqual(1);
    expect(lines.filter((l) => l.includes("door_join_held_until_fix")).length).toBeLessThanOrEqual(1);
    expect(lines.every((l) => /autotopup_held_until_fix|door_join_held_until_fix/.test(l))).toBe(true);
  });
  it("pairing.ts: with DOOR_JOIN_REQUIRED=1 the pairing routes are NOT turned into 410 use_connect", async () => {
    const on = { ...env, ...ON } as Env;
    const res = await pairingRoute(new Request("https://cp.test/v1/pairing/desktop", { method: "POST", body: "{}" }), on, undefined as never).catch((e) => e);
    expect(res).not.toMatchObject({ status: 410, code: "use_connect" });
    releaseItem9HoldForTests(true);
    const held = await pairingRoute(new Request("https://cp.test/v1/pairing/desktop", { method: "POST", body: "{}" }), on, undefined as never).catch((e) => e);
    expect(held).toMatchObject({ status: 410, code: "use_connect" });
  });
  it("every reader goes through the guard: no src file but held-until-item9-highs.ts reads either switch", () => {
    // @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const readers = Object.entries(sources).filter(([, text]) => /\.(CLOUD_AUTOTOPUP_ENABLED|DOOR_JOIN_REQUIRED)\b|\[["'](CLOUD_AUTOTOPUP_ENABLED|DOOR_JOIN_REQUIRED)["']\]/.test(text))
      .map(([path]) => path.split("/").at(-1));
    expect(readers).toEqual(["held-until-item9-highs.ts"]);
    // The guarded call sites (pairing.ts route gate, b3-control.ts doorReadySql and the canary's proofNeeded, flux-live-hooks.ts setAutoRecharge).
    expect(sources["../src/pairing.ts"]).toContain("if (joinRequired(env) && (path");
    expect(sources["../src/b3-control.ts"]).toContain("doorV2Required(env) && joinRequired(env) ? \" AND h.door_proof=1\"");
    expect(sources["../src/b3-control.ts"]).toContain("const proofNeeded = doorV2Required(env) && joinRequired(env);");
    expect(sources["../src/flux-live-hooks.ts"]).toContain("if (!topupChargingEnabled(env)) throw new Error(\"flux_not_wired\")");
  });
  it("the guard is the only thing holding them: released (tests only) the switches read as set", () => {
    releaseItem9HoldForTests(true);
    expect(topupChargingEnabled(ON)).toBe(true);
    expect(joinRequired(ON)).toBe(true);
    expect(doorReadySql(ON)).toBe(" AND h.door_version='v2' AND h.door_proof=1");
    expect(topupChargingEnabled({ CLOUD_AUTOTOPUP_ENABLED: "0" })).toBe(false);
    expect(joinRequired({})).toBe(false);
  });
  it("config lock: wrangler.jsonc sets both switches to exactly \"0\" in env.staging and env.production", () => {
    const config = JSON.parse(stripJsonc(wranglerText)) as { env: Record<string, { vars: Record<string, unknown> }> };
    for (const name of ["staging", "production"]) {
      const vars = config.env[name]!.vars;
      expect(vars.CLOUD_AUTOTOPUP_ENABLED, `${name} CLOUD_AUTOTOPUP_ENABLED`).toBe("0");
      expect(vars.DOOR_JOIN_REQUIRED, `${name} DOOR_JOIN_REQUIRED`).toBe("0");
      // And the config alone reads as off, hold or no hold.
      releaseItem9HoldForTests(true);
      expect(topupChargingEnabled(vars as { CLOUD_AUTOTOPUP_ENABLED?: string })).toBe(false);
      expect(joinRequired(vars as { DOOR_JOIN_REQUIRED?: string })).toBe(false);
      releaseItem9HoldForTests(false);
    }
  });
});
