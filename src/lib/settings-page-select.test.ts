// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import "@/lib/settings-copy";
import { selectorPageLabel, truncateAtWord } from "./settings-page-select";

describe("phone page selector names", () => {
  it("keeps short names whole", () => {
    expect(truncateAtWord("Web search")).toBe("Web search");
  });
  it("cuts a long name at a word boundary with an ellipsis, never mid-word", () => {
    const out = truncateAtWord("Phone and other devices");
    expect(out).toBe("Phone and other…");
    expect(out.length).toBeLessThanOrEqual(22);
    expect(truncateAtWord("Bot defaults and behaviour")).toBe("Bot defaults and…");
  });
  it("cuts one very long word at the limit", () => {
    const out = truncateAtWord("Supercalifragilisticexpialidocious");
    expect(out.length).toBeLessThanOrEqual(22);
    expect(out.endsWith("…")).toBe(true);
  });
  it("names the messaging page the way the breadcrumb does when it was asked for as channels", () => {
    expect(selectorPageLabel("connections", "channels")).toBe("Messaging apps");
    expect(selectorPageLabel("connections", "connections")).toBe("Connected apps");
    expect(selectorPageLabel("general", "channels")).not.toBe("Messaging apps");
  });
  it("the phone selector uses both, and keeps the full name as the accessible label of each option", () => {
    const source = readFileSync(new URL("../components/SettingsModal.tsx", import.meta.url), "utf8");
    const start = source.indexOf("data-settings-page-select");
    const select = source.slice(start, source.indexOf("</select>", start));
    expect(select).toContain("selectorPageLabel(id, requested)");
    expect(select).toContain("truncateAtWord(each.name)");
    expect(select).toContain("aria-label={each.name}");
  });
});
