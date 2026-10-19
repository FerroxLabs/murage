// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PreviousVersionRow } from "./PreviousVersionRow";

const setBridge = (muragebox: unknown) => {
  Object.assign(globalThis, { window: Object.assign((globalThis as { window?: object }).window ?? {}, { muragebox }) });
};

describe("PreviousVersionRow", () => {
  it("shows the row and a Prepare button when the bridge offers it", () => {
    setBridge({ updater: { preparePreviousVersion: async () => ({ started: true }) } });
    const html = renderToStaticMarkup(createElement(PreviousVersionRow));
    expect(html).toContain("Go back to the previous version, chats and memories kept");
    expect(html).toContain("Prepare");
    expect(html).not.toContain("—");
  });

  it("hides the row without the bridge or on an older preload", () => {
    setBridge(undefined);
    expect(renderToStaticMarkup(createElement(PreviousVersionRow))).toBe("");
    setBridge({ updater: { check: () => {} } });
    expect(renderToStaticMarkup(createElement(PreviousVersionRow))).toBe("");
  });
});
