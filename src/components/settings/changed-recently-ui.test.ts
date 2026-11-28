// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings v10 J1/A1: the Changed recently section draws who and Set back from the view model, and nothing when empty;
// the Overview page keeps the slot and stores nothing.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ChangedRecentlyList } from "./ChangedRecently";
import { changedRecentlyView, type ChangedRecentlyRow } from "@/lib/changed-recently";

const ROW: ChangedRecentlyRow = { changeId: "c1", at: 5, actor: { kind: "bot", botId: "b1" }, writer: "w", settingId: "bot.notify", before: false, after: true, shape: "field" };
const view = (current: unknown) => changedRecentlyView([ROW], { botName: () => "Nova", current: () => current });
const html = (rows: ReturnType<typeof view>) => renderToStaticMarkup(createElement(ChangedRecentlyList, { rows, onSetBack: () => undefined }));

describe("Changed recently section", () => {
  it("draws who changed it, was and now, and Set back while the value stands", () => {
    const out = html(view(true));
    expect(out).toContain("Nova");
    expect(out).toContain("Was Off");
    expect(out).toContain("Now On");
    expect(out).toContain("Set back");
  });
  it("draws no Set back when nothing can send it", () => {
    expect(renderToStaticMarkup(createElement(ChangedRecentlyList, { rows: view(true) }))).not.toContain("Set back");
  });
  it("draws no Set back once the value moved on, and nothing at all when empty", () => {
    expect(html(view(false))).not.toContain("Set back");
    expect(html([])).toBe("");
  });
});

describe("Overview page", () => {
  const src = readFileSync(fileURLToPath(new URL("./pages/OverviewPage.tsx", import.meta.url)), "utf8");
  it("keeps the overview.changed slot as its root and writes nothing", () => {
    expect(src).toContain('<OverviewSection id="overview.changed"');
    expect(src).not.toMatch(/fetch\(|localStorage|setItem|\.put\(|\.post\(/);
  });
});
