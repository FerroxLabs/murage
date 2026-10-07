// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-P section 14: the turn-engine flags (lane E1). Each defaults to on
// (the shipped behaviour) and survives a config load only because it is in
// the feature schema; a key missing there is stripped on load.
import { describe, expect, it } from "vitest";
import { parseConfigPatch } from "./config.ts";
import { TURN_ENGINE_FLAGS, turnEngineFlag, turnEngineFlagProjection } from "./turn-engine-flags.ts";

describe("turn-engine flags", () => {
  it("default on, and off only when explicitly false", () => {
    for (const flag of TURN_ENGINE_FLAGS) {
      expect(turnEngineFlag({}, flag)).toBe(true);
      expect(turnEngineFlag({ features: {} }, flag)).toBe(true);
      expect(turnEngineFlag({ features: { [flag]: true } }, flag)).toBe(true);
      expect(turnEngineFlag({ features: { [flag]: false } }, flag)).toBe(false);
    }
  });

  it("survive a config patch parse (the schema knows every key)", () => {
    for (const flag of TURN_ENGINE_FLAGS) {
      expect(parseConfigPatch({ features: { [flag]: false } })).toEqual({ features: { [flag]: false } });
    }
  });

  it("are served with their defaults applied", () => {
    expect(turnEngineFlagProjection({ features: { roomsQueue: false } })).toEqual({
      roomsThreadAdmission: true,
      roomsQueue: false,
      roomsMentionChain: true,
      projectsAutonomy: true,
      projectsAutoWake: true,
      projectsParallelCards: true,
    });
  });
});

it("keeps the parallel cards kill switch through parsing", () => {
  expect(parseConfigPatch({ features: { projectsParallelCards: false } })).toEqual({ features: { projectsParallelCards: false } });
});
