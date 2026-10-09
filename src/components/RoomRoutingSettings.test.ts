// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { deciderRoutesRooms } from "@/lib/group-routing";
import { ROOM_ROUTING_COPY, roomRoutingSwitch } from "./RoomRoutingSettings";

const on = { enabled: true, available: true, jobs: { roomRouting: true } };

describe("the Auto switch in Settings", () => {
  it("is on with a Flux key and the defaults", () => {
    expect(roomRoutingSwitch({ flux: { configured: true }, decider: on })).toEqual({ checked: true, disabled: false, note: "" });
  });
  it("is off and changeable when the owner turned it off", () => {
    expect(roomRoutingSwitch({ flux: { configured: true }, decider: { ...on, enabled: false } })).toMatchObject({ checked: false, disabled: false });
    expect(roomRoutingSwitch({ flux: { configured: true }, decider: { ...on, jobs: { roomRouting: false } } })).toMatchObject({ checked: false, disabled: false });
  });
  it("says so in plain words with no Flux connection", () => {
    expect(roomRoutingSwitch({ flux: { configured: false }, decider: { enabled: false } })).toEqual({ checked: false, disabled: true, note: ROOM_ROUTING_COPY.noKey });
    expect(roomRoutingSwitch(null).disabled).toBe(true);
  });
  it("shows an unavailable state when the account cannot use it, with no price talk", () => {
    const view = roomRoutingSwitch({ flux: { configured: true }, decider: { ...on, available: false } });
    expect(view).toMatchObject({ checked: false, disabled: true, note: ROOM_ROUTING_COPY.unavailable });
    const copy = Object.values(ROOM_ROUTING_COPY).join(" ");
    expect(copy).not.toMatch(/\$|price|pay|paid|upgrade|plan|free|safe|—|Composio/i);
  });
  it("hides Auto in a channel's Who answers while unavailable", () => {
    expect(deciderRoutesRooms({ decider: on })).toBe(true);
    expect(deciderRoutesRooms({ decider: { ...on, available: false } })).toBe(false);
    expect(deciderRoutesRooms({ decider: { enabled: true, jobs: { roomRouting: true } } })).toBe(true);
  });
  it("is mounted in Settings, under channel defaults", () => {
    const settings = readFileSync(new URL("./SettingsModal.tsx", import.meta.url), "utf8");
    expect(settings).toMatch(/section === "botDefaults"[\s\S]*?<RoomRoutingSettings \/>/);
  });
});
