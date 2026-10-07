// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { withNewBotEffort } from "./new-bot-defaults.ts";

describe("withNewBotEffort", () => {
  const selection = { instanceId: "claude", model: "opus" };

  it("fills the workspace effort when the engine offers it", () => {
    expect(withNewBotEffort(selection, "high", ["low", "medium", "high"])).toEqual({ ...selection, effort: "high" });
  });

  it("keeps an explicit effort, and sends none where the engine has no such level", () => {
    expect(withNewBotEffort({ ...selection, effort: "low" }, "high", ["low", "high"])).toEqual({ ...selection, effort: "low" });
    expect(withNewBotEffort(selection, "max", ["low", "high"])).toEqual(selection);
    expect(withNewBotEffort(selection, "high", undefined)).toEqual(selection);
    expect(withNewBotEffort(selection, null, ["high"])).toEqual(selection);
  });
});
