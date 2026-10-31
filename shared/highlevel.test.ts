// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  HIGHLEVEL_HELPER_NAMES,
  HIGHLEVEL_TOOL_NAMES,
  HIGHLEVEL_WRITE_TOOLS,
  highlevelBotAccessSchema,
  isHighLevelWrite,
  isNativeHighLevelName,
  nativeGrantSchema,
} from "./highlevel.ts";

const grant = { toolkit: "highlevel", accountId: "hl_abc123", tools: ["HIGHLEVEL_GET_CONTACT"], botId: "bot_1", revision: 3, ceiling: "read" };

describe("native HighLevel names and grants (GAP-HIGHLEVEL-109 sections 5 and 7)", () => {
  it("has exactly the twenty CRM tools and two local helpers, all distinct", () => {
    expect(HIGHLEVEL_TOOL_NAMES).toHaveLength(20);
    expect(HIGHLEVEL_HELPER_NAMES).toEqual(["HIGHLEVEL_LIST_CONNECTIONS", "HIGHLEVEL_ACTION_STATUS"]);
    expect(new Set([...HIGHLEVEL_TOOL_NAMES, ...HIGHLEVEL_HELPER_NAMES]).size).toBe(22);
    for (const name of [...HIGHLEVEL_TOOL_NAMES, ...HIGHLEVEL_HELPER_NAMES]) expect(name).toMatch(/^HIGHLEVEL_[A-Z_]+$/);
  });

  it("names its eight reviewed changes explicitly; every other CRM tool reads", () => {
    expect([...HIGHLEVEL_WRITE_TOOLS].sort()).toEqual([
      "HIGHLEVEL_ADD_NOTE", "HIGHLEVEL_ADD_TAGS", "HIGHLEVEL_ADD_TASK", "HIGHLEVEL_CREATE_CONTACT",
      "HIGHLEVEL_CREATE_OPPORTUNITY", "HIGHLEVEL_REMOVE_TAGS", "HIGHLEVEL_UPDATE_CONTACT", "HIGHLEVEL_UPDATE_OPPORTUNITY",
    ]);
    for (const name of HIGHLEVEL_TOOL_NAMES) expect(isHighLevelWrite(name)).toBe(HIGHLEVEL_WRITE_TOOLS.has(name));
    expect(isHighLevelWrite("HIGHLEVEL_LIST_CONNECTIONS")).toBe(false);
    expect(isNativeHighLevelName("HIGHLEVEL_ACTION_STATUS")).toBe(true);
    expect(isNativeHighLevelName("GMAIL_SEND_EMAIL")).toBe(false);
  });

  it("accepts the exact grant shape and nothing looser", () => {
    expect(nativeGrantSchema.parse(grant)).toEqual(grant);
    expect(nativeGrantSchema.safeParse({ ...grant, ceiling: "propose" }).success).toBe(true);
    for (const bad of [
      { ...grant, extra: true },
      { ...grant, toolkit: "gohighlevel" },
      { ...grant, accountId: "abc123" },
      { ...grant, accountId: "hl_../x" },
      { ...grant, tools: [] },
      { ...grant, tools: ["HIGHLEVEL_SEND_SMS"] },
      { ...grant, tools: ["HIGHLEVEL_LIST_CONNECTIONS"] },
      { ...grant, revision: -1 },
      { ...grant, revision: 1.5 },
      (({ botId: _b, ...rest }) => rest)(grant),
    ]) expect(nativeGrantSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("allows only the read and propose ceilings", () => {
    for (const ceiling of ["read", "propose"]) expect(nativeGrantSchema.safeParse({ ...grant, ceiling }).success).toBe(true);
    for (const ceiling of ["write", "full", "auto", "", "READ", undefined]) expect(nativeGrantSchema.safeParse({ ...grant, ceiling }).success, String(ceiling)).toBe(false);
  });

  it("binds the grant record to a role and refuses unknown fields", () => {
    expect(highlevelBotAccessSchema.safeParse({ revision: 1, roleBinding: "r", grants: [grant] }).success).toBe(true);
    expect(highlevelBotAccessSchema.safeParse({ revision: 1, grants: [grant] }).success).toBe(false);
    expect(highlevelBotAccessSchema.safeParse({ revision: 1, roleBinding: "r", grants: [grant], mode: "unrestricted" }).success).toBe(false);
  });
});
