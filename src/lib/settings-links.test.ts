// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 L1: every ref and alias resolves by exact id; opening writes nothing; unknown parameters are dropped;
// a signpost with no fragment is a miss, not a control.
import { describe, expect, it } from "vitest";
import { SETTINGS_INDEX } from "./settings-index";
import { SETTINGS_CARD_ALIASES } from "./settings-card-registry";
import { parseSettingsAddress } from "./settings-address";
import { settingsAddressActions } from "./open-settings-address";
import { parseSettingLinkParams, resolveSettingId, settingArrival, settingPathText, settingRefAddress } from "./settings-links";

const appEntry = SETTINGS_INDEX.find((entry) => entry.scope === "app")!;
const botEntry = SETTINGS_INDEX.find((entry) => entry.scope === "bot")!;

describe("settings links (L1)", () => {
  it("every index id resolves by exact id and its address arrives on that control", () => {
    for (const entry of SETTINGS_INDEX) {
      expect(resolveSettingId(entry.id)?.id, entry.id).toBe(entry.id);
      const href = settingRefAddress({ id: entry.id });
      expect(href, entry.id).not.toBeNull();
      const arrival = settingArrival(href);
      expect(arrival.kind, entry.id).toBe("control");
      if (arrival.kind === "control") expect(arrival.entry.id).toBe(entry.id);
    }
  });
  it("every published alias resolves to its card", () => {
    for (const alias of Object.keys(SETTING_ALIAS())) expect(resolveSettingId(alias), alias).not.toBeNull();
  });
  it("is exact: a prefix, a truncated id and an unknown id are misses", () => {
    expect(resolveSettingId(appEntry.id.slice(0, -1))).toBeNull();
    expect(resolveSettingId(appEntry.id.split(".")[0])).toBeNull();
    expect(resolveSettingId(`${appEntry.id}.extra`)).toBeNull();
    expect(settingRefAddress({ id: "nope.nothing" })).toBeNull();
  });
  it("a page with no fragment counts as a miss, not a control", () => {
    expect(settingArrival("murage://settings/app/connections")).toEqual({ kind: "page", section: "connections", reason: "no-fragment" });
    expect(settingArrival(`murage://settings/app/${appEntry.section}/not-a-control`)).toMatchObject({ kind: "page", reason: "unknown-control" });
    expect(settingArrival(`murage://settings/app/bot/${botEntry.id.split(".").slice(1).join(".")}`).kind).not.toBe("control");
    expect(settingArrival("https://example.com")).toEqual({ kind: "miss" });
  });
  it("carries the account and bot, and drops unknown or malformed parameters", () => {
    const href = settingRefAddress({ id: appEntry.id, account: "work_1", item: "send" })!;
    expect(parseSettingLinkParams(href)).toEqual({ account: "work_1", item: "send" });
    expect(parseSettingLinkParams(`${href}&evil=1&bot=%00bad`)).toEqual({ account: "work_1", item: "send" });
    expect(parseSettingLinkParams("murage://settings/app/x?bot=a%ZZ")).toEqual({});
    const botHref = settingRefAddress({ id: botEntry.id, bot: "dax-1" })!;
    expect(parseSettingsAddress(botHref)).toMatchObject({ scope: "bot", botId: "dax-1" });
  });
  it("two refs that differ only by account give different links", () => {
    expect(settingRefAddress({ id: appEntry.id, account: "a1" })).not.toBe(settingRefAddress({ id: appEntry.id, account: "b2" }));
  });
  it("opening writes nothing: every action is navigation", () => {
    for (const entry of SETTINGS_INDEX) {
      const href = settingRefAddress({ id: entry.id, bot: "dax-1" })!;
      const address = parseSettingsAddress(href.replace(/\?.*$/, ""))!;
      const actions = settingsAddressActions(address, { botIds: ["dax-1"], selectedBotId: "dax-1" }) ?? [];
      for (const action of actions) expect(["toggleAppSettings", "toggleSettings", "select"], entry.id).toContain(action.type);
    }
  });
  it("one function writes the path text", () => {
    const text = settingPathText(appEntry.id)!;
    expect(text.startsWith("Settings → ")).toBe(true);
    expect(text.split(" → ")).toHaveLength(3);
    expect(settingPathText("nope.nothing")).toBeNull();
  });
});

function SETTING_ALIAS() { return SETTINGS_CARD_ALIASES; }
