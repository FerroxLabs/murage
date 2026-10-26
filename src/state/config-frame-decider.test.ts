// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U35: a live config frame carries the decision-model switches and the new-bot
// defaults through to the store, so the channel auto-routing switch keeps
// showing what was saved after any other setting changes.
import { describe, expect, it } from "vitest";

import { configStatusFromFrame, type ConfigStatusFrame } from "./store";
import { roomRoutingSwitch } from "../components/RoomRoutingSettings";

const frame: ConfigStatusFrame = {
  composio: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 20 },
  localVm: { mode: "shared", maxInstances: 1 },
  flux: { configured: true, keyState: "ok" },
  decider: { enabled: true, available: true, jobs: { roomRouting: true } },
  newBots: { effort: "high" },
};

describe("config status frame", () => {
  it("keeps decider and newBots", () => {
    const config = configStatusFromFrame(frame);
    expect(config.decider).toEqual({ enabled: true, available: true, jobs: { roomRouting: true } });
    expect(config.newBots).toEqual({ effort: "high" });
  });

  it("shows the paid auto-routing switch as on after a live config frame", () => {
    expect(roomRoutingSwitch(configStatusFromFrame(frame))).toEqual({ checked: true, disabled: false, note: "" });
  });
});
