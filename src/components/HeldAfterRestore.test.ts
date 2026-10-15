// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeldAfterRestoreView, heldRows, type HeldRestoreList } from "./HeldAfterRestore";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const list: HeldRestoreList = {
  restoreGen: "gen-1",
  outputs: [{ id: "o1", generation: "gen-1", bot: "Researcher", conversation: "Quarterly plan", preview: "report.md", at: 2000 }],
  sharedResults: [{ id: "r1", generation: "gen-1", bot: "Writer", conversation: "Launch notes", preview: "The summary is ready.", at: 1000 }],
};
const render = (value: HeldRestoreList | null, extra: object = {}) => renderToStaticMarkup(createElement(HeldAfterRestoreView, { list: value, onRelease: () => {}, ...extra }));

describe("Held after restore", () => {
  it("shows each held item with its bot, conversation, preview and a Release button", () => {
    const markup = render(list);
    expect(markup).toContain("Held after restore");
    for (const text of ["Researcher / Quarterly plan", "report.md", "Writer / Launch notes", "The summary is ready."]) expect(markup).toContain(text);
    expect(markup.match(/>Release</g)).toHaveLength(2);
    expect(markup).toContain('data-held-item="output_receipt"');
    expect(markup).toContain('data-held-item="shared_result"');
  });
  it("is hidden when nothing is held", () => {
    expect(render(null)).toBe("");
    expect(render({ restoreGen: "gen-1", outputs: [], sharedResults: [] })).toBe("");
  });
  it("orders the two lists together, oldest first, and shows a busy item as releasing", () => {
    expect(heldRows(list).map(row => row.id)).toEqual(["r1", "o1"]);
    expect(render(list, { busyId: "o1" })).toContain("Releasing");
  });
  it("lives in Settings > Backups and releases through the existing route with the restore generation", () => {
    expect(read("./BackupSettings.tsx")).toContain("<HeldAfterRestore/>");
    const source = read("./HeldAfterRestore.tsx");
    expect(source).toContain("/api/restore-holds/${row.kind}/${encodeURIComponent(row.id)}/release");
    expect(source).toContain("restoreGen: list?.restoreGen");
    expect(source).toContain("await load()");
  });
});
