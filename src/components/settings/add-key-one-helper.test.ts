// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G9 Fable H2: "Add a key" in Simple carries one helper line, not three (the card subtitle, the "Review keys" label and
// PasteKeys' own line said the same thing). Rendered with the real card frame and the real paste body; Advanced keeps
// the full detail.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: vi.fn(async () => ({})), useStore: () => ({ state: { config: null, bots: [], instances: [] }, dispatch: vi.fn() }) }));

const { AddKeyFrame } = await import("./pages/ModelsPage");
const { PasteKeysBody, HELP, HELP_SIMPLE } = await import("../PasteKeys");

const REVIEW = "Review keys to add or replace";
const card = (simple: boolean) => renderToStaticMarkup(createElement(AddKeyFrame, { simple, children: createElement(PasteKeysBody, {
  rows: [], scanned: false, onScan: vi.fn(), onChoose: vi.fn(), onAccept: vi.fn(), onDismiss: vi.fn(), configured: null, simple,
}) }));

describe("H2: Add a key carries one helper line in Simple", () => {
  const helpers = () => [t("settings.l4.addKey.note"), REVIEW, HELP, HELP_SIMPLE];
  it("Simple: exactly one, the short line that says nothing is saved", () => {
    const html = card(true);
    expect(helpers().filter((line) => html.includes(line))).toEqual([HELP_SIMPLE]);
  });
  it("Advanced: the card note, the label and the full helper", () => {
    const html = card(false);
    expect(helpers().filter((line) => html.includes(line))).toEqual([t("settings.l4.addKey.note"), REVIEW, HELP]);
  });
});
