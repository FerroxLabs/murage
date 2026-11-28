// Settings v10 L0 (owner: core): a refusal names the setting that fixes it. Every refusal code the handlers emit resolves to a
// manifest id, the ref survives the JSON proxy, and the client decoder returns nothing for an id it cannot find (it never invents a link).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNER_CODE_LABELS } from "../browser-owner-policy.ts";
import { REFUSAL_SETTING_REFS, refusalBody } from "./refusal-refs.ts";
import { decodeSettingRef, knownSettingIds } from "../../src/lib/setting-ref-decode.ts";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/lib/settings-controls.manifest.json", import.meta.url)), "utf8"));
const manifestIds = new Set<string>([
  ...Object.values<string>(manifest.appHomes), ...manifest.simpleCards, ...Object.keys(manifest.bot).map((key) => `bot.${key}`),
]);

describe("L0 settingRef on refusals", () => {
  it("every refusal code resolves to a manifest id: owner-code labels plus the lane's own 409s", () => {
    const codes = [...OWNER_CODE_LABELS, "MEMORY_CHANGED", "PLAN_CHANGED", "SETTING_CHANGED"];
    for (const code of codes) {
      const entry = REFUSAL_SETTING_REFS[code];
      expect(entry, `refusal code ${code} has no settingRef`).toBeDefined();
      expect(manifestIds.has(entry.id), `${code} -> ${entry?.id} is not a manifest id`).toBe(true);
    }
    expect(Object.keys(REFUSAL_SETTING_REFS).sort()).toEqual([...codes].sort());
  });

  it("the ref sits beside the message, survives JSON, and decodes to the same id", () => {
    const body = refusalBody("MEMORY_CHANGED", "This memory changed.", { bot: "b1" });
    const wire = JSON.parse(JSON.stringify(body));
    expect(wire.error).toBe("This memory changed.");
    expect(decodeSettingRef(wire)).toEqual({ id: REFUSAL_SETTING_REFS.MEMORY_CHANGED.id, bot: "b1", code: "MEMORY_CHANGED" });
  });

  it("the decoder refuses an id that is not in the manifest, a missing ref, and junk", () => {
    expect(decodeSettingRef({ settingRef: { id: "made.up", code: "X" } })).toBeNull();
    expect(decodeSettingRef({ error: "no ref" })).toBeNull();
    expect(decodeSettingRef({ settingRef: "bot.access.folder" })).toBeNull();
    expect(decodeSettingRef(null)).toBeNull();
    expect(knownSettingIds().has("bot.permissions.level")).toBe(true);
  });
});

describe("L0 the memory owner route attaches the ref", () => {
  it("the MEMORY_CHANGED 409 answer in the owner memory route carries settingRef", () => {
    const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(index).toContain('error.message==="MEMORY_CHANGED"?{code:"MEMORY_CHANGED",settingRef:settingRefFor("MEMORY_CHANGED")}');
  });
});
