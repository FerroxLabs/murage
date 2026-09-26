// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfirmTaskDelete } from "./TaskPicker";
import { DeletionNoteBanner } from "./DeletionNoteBanner";

const noop = () => {};

describe("conversation Delete confirmation", () => {
  it("says how many saved files go with it and that earlier backups keep it", () => {
    const html = renderToStaticMarkup(createElement(ConfirmTaskDelete, { name: "Taxes", preview: { botId: "b", threadId: "t" }, savedFiles: 3, onCancel: noop, onConfirm: noop }));
    expect(html).toContain("Delete this conversation?");
    expect(html).toContain("This also deletes 3 saved files.");
    expect(html).toContain("Earlier backups still contain it until they expire.");
    expect(html).not.toMatch(/—|\bsafe(ly)?\b/i);
  });

  it("leaves out the saved-file line when there are none", () => {
    const html = renderToStaticMarkup(createElement(ConfirmTaskDelete, { name: "Taxes", preview: { botId: "b", threadId: "t" }, savedFiles: 0, onCancel: noop, onConfirm: noop }));
    expect(html).not.toContain("saved file");
    expect(html).toContain("Earlier backups still contain it until they expire.");
  });

  it("shows what could not be removed after a Delete", () => {
    const html = renderToStaticMarkup(createElement(DeletionNoteBanner, { note: { title: "Deleted. A few things could not be removed:", items: ["Gemini CLI's own copy of this conversation, in Gemini CLI's history on this computer."] }, onDismiss: noop }));
    expect(html).toContain("A few things could not be removed");
    expect(html).toContain("Gemini CLI&#x27;s own copy of this conversation");
  });
});
