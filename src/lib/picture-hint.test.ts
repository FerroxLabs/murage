// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { picturesElsewhereHint } from "./picture-hint";
import { pickerModels } from "./provider-model-picker";

const engine = (instanceId: string, displayName: string, ids: string[], over: Record<string, unknown> = {}) => ({
  instanceId, driverKind: instanceId === "grok" ? "grokAgent" : "fuigoAgent", displayName, enabled: true,
  snapshot: { state: "available" as const, authenticated: true },
  models: { default: ids[0]!, options: ids.map((id) => ({ id, label: id })) },
  capabilities: { images: instanceId !== "grok" }, ...over,
});

describe("picturesElsewhereHint", () => {
  const grok = engine("grok", "Grok", ["grok-4.7"]);
  it("the fixture model has vision on the Grok engine (the eye the hint explains)", () => {
    expect(pickerModels(grok, []).some((row) => row.capabilities?.vision)).toBe(true);
  });
  it("names another ready engine whose live catalog has the same model and passes pictures", () => {
    const fuigo = engine("fuigo", "Fuigo", ["flux-auto", "grok-4.7"]);
    const line = picturesElsewhereHint(grok, [grok, fuigo], [], "grok-4.7");
    expect(line).toBe("Fuigo runs Grok 4.7 with pictures.");
    expect(line).not.toMatch(/—|safe|safety|unsafe/i);
  });
  it("says nothing without a match", () => {
    expect(picturesElsewhereHint(grok, [grok, engine("fuigo", "Fuigo", ["flux-auto"])], [])).toBeNull();
  });
  it("says nothing when the other engine is not ready or does not pass pictures", () => {
    const ids = ["x-ai/grok-4.7"];
    expect(picturesElsewhereHint(grok, [grok, engine("fuigo", "Fuigo", ids, { snapshot: { state: "unavailable" } })], [])).toBeNull();
    expect(picturesElsewhereHint(grok, [grok, engine("fuigo", "Fuigo", ids, { capabilities: { images: false } })], [])).toBeNull();
  });
  it("says nothing when the shown engine already passes pictures", () => {
    const fuigo = engine("fuigo", "Fuigo", ["grok-4.7"]);
    expect(picturesElsewhereHint(fuigo, [grok, fuigo], [])).toBeNull();
  });
});
