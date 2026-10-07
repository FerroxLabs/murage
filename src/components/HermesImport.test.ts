// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { hermesSkipSentence } from "./HermesImport";
import { hermesDetected } from "./NewFromTemplateDialog";

describe("Import from Hermes", () => {
  it("is offered only when a Hermes engine is available", () => {
    expect(hermesDetected([])).toBe(false);
    expect(hermesDetected([{ driverKind: "hermesAgent", snapshot: { state: "unavailable" } }])).toBe(false);
    expect(hermesDetected([{ driverKind: "claudeAgent", snapshot: { state: "available" } }, { driverKind: "hermesAgent", snapshot: { state: "available" } }])).toBe(true);
  });

  it("says in one sentence why a profile was left out", () => {
    expect(hermesSkipSentence({ profile: "fred", reason: "already-imported", botName: "Fred" })).toBe("fred already runs as Fred.");
    expect(hermesSkipSentence({ profile: "fred", reason: "not-found" })).toBe("Hermes has no profile named fred any more.");
    expect(hermesSkipSentence({ profile: "fred", reason: "limit" })).toMatch(/as many bots as it can hold/);
    expect(hermesSkipSentence({ profile: "X", reason: "invalid" })).toBe("X is not a name Hermes accepts.");
  });
});
