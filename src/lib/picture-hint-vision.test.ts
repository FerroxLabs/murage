// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

const rows: Record<string, Array<Record<string, unknown>>> = {};
vi.mock("./provider-model-picker", () => ({ pickerModels: (e: { instanceId: string }) => rows[e.instanceId] ?? [] }));
const { picturesElsewhereHint } = await import("./picture-hint");

const eng = (instanceId: string, displayName: string, images: boolean) => ({
  instanceId, driverKind: "x", displayName, enabled: true, snapshot: { state: "available" as const, authenticated: true },
  models: { default: "m", options: [] }, capabilities: { images },
});
const row = (vision: boolean | undefined) => ({ selection: { model: "grok-4.7" }, label: "Grok 4.7", ...(vision === undefined ? {} : { capabilities: { vision } }) });
const grok = eng("grok", "Grok", false), fuigo = eng("fuigo", "Fuigo", true);

describe("picturesElsewhereHint needs vision known to be true", () => {
  it("shows the line when the other catalog says vision is true", () => {
    rows.grok = [row(true)]; rows.fuigo = [row(true)];
    expect(picturesElsewhereHint(grok, [grok, fuigo], [])).toBe("Fuigo runs Grok 4.7 with pictures.");
  });
  it("shows nothing when the other catalog says vision is false", () => {
    rows.grok = [row(true)]; rows.fuigo = [row(false)];
    expect(picturesElsewhereHint(grok, [grok, fuigo], [])).toBeNull();
  });
  it("shows nothing when the other catalog does not say", () => {
    rows.grok = [row(true)]; rows.fuigo = [row(undefined)];
    expect(picturesElsewhereHint(grok, [grok, fuigo], [])).toBeNull();
  });
});
