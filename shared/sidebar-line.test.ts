// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isMurageVoice } from "../server/murage-voice.ts";
import { sidebarLineOf } from "./sidebar-line.ts";

describe("a connection card's sidebar line (item 140)", () => {
  const row = {
    id: "m1", at: 1, role: "bot" as const, kind: "connector" as const, text: "Connect GitHub to continue.",
    connector: { label: "GitHub", status: "required" as const },
  };
  it("carries the app and the state for the reader's language, and the plain text as a fallback", () => {
    expect(sidebarLineOf(row)).toMatchObject({ kind: "connector", text: "Connect GitHub to continue.", connector: { label: "GitHub", status: "required" } });
  });
  it("a row that is not a connection card gets no connector", () => {
    expect(sidebarLineOf({ ...row, kind: "text", connector: undefined }).connector).toBeUndefined();
  });
  it("giving the card a text line does not change its Murage-voice classification", () => {
    const stored = { ...row, murageLine: true };
    expect(isMurageVoice(stored)).toBe(true);
    expect(isMurageVoice({ ...stored, text: undefined })).toBe(true);
  });
});
