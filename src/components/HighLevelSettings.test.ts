// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultHighLevelFamilies, type HighLevelBotAccess } from "../../shared/highlevel";
import { highlevelGrantsFor, highlevelLevel, highlevelStatus, type HighLevelView } from "./HighLevelSettings";

const connectionId = "hl_loc123";
const access = (ceiling: "read" | "propose", accountId = connectionId): HighLevelBotAccess => ({
  revision: 1, roleBinding: "r", grants: [{ toolkit: "highlevel", accountId, botId: "b1", revision: 1, ceiling, tools: ["HIGHLEVEL_GET_CONTACT"] }],
} as unknown as HighLevelBotAccess);
const view = (patch: Partial<HighLevelView>): HighLevelView => ({ tokenSaved: true, connection: null, bots: [], ...patch });

describe("HighLevel owner card", () => {
  it("Can look uses default family levels; off revokes the grant", () => {
    expect(highlevelGrantsFor("off", connectionId)).toEqual({ grants: [] });
    expect(highlevelGrantsFor("read", connectionId)).toEqual({ grants: [{ connectionId, families: defaultHighLevelFamilies() }] });
  });

  it("an older saved propose grant shows as Can read; another location shows as off", () => {
    expect(highlevelLevel(undefined, connectionId)).toBe("off");
    expect(highlevelLevel(access("read"), connectionId)).toBe("read");
    expect(highlevelLevel(access("propose"), connectionId)).toBe("read");
    expect(highlevelLevel(access("propose", "hl_other"), connectionId)).toBe("off");
  });

  it("the card offers one change switch and keeps Full control in Advanced", () => {
    const source = readFileSync(new URL("./HighLevelSettings.tsx", import.meta.url), "utf8");
    expect(source.match(/<Switch\b/g)).toHaveLength(1);
    expect(source).toContain('t("highlevel.canChange")');
    expect(source).toContain('t("highlevel.fullHelp")');
    expect(source).toContain('advanced &&');
  });

  it("shows one plain status line for each state", () => {
    expect(highlevelStatus(view({ tokenSaved: false }))).toBe("No token saved yet.");
    expect(highlevelStatus(view({}))).toBe("Token saved. Check a location to connect it.");
    const connection = { connectionId, locationId: "loc123", locationName: "Main Street", state: "connected", confirmedAt: "2026-11-03T00:00:00Z" };
    expect(highlevelStatus(view({ connection }))).toBe("Connected to Main Street.");
    expect(highlevelStatus(view({ connection: { ...connection, state: "pending_browser_confirmation" } }))).toBe("The token changed. Check the location again and confirm it.");
  });

  it("copy: plain words, no em dashes, never safe or free", () => {
    const en = JSON.parse(readFileSync(new URL("../locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
    const strings = Object.entries(en).filter(([key]) => key.startsWith("highlevel."));
    expect(strings.length).toBeGreaterThan(30);
    for (const [, value] of strings) {
      expect(value).not.toMatch(/—/);
      expect(value).not.toMatch(/\b(safe|safely|free)\b/i);
    }
  });

  it("the card never reads the token back and saves it only through the credential path", () => {
    const source = readFileSync(new URL("./HighLevelSettings.tsx", import.meta.url), "utf8");
    expect(source).toContain('setCredential("highlevelPrivateToken"');
    expect(source).not.toMatch(/privateToken\s*[:=]\s*view|view\??\.token\b/);
  });
});
