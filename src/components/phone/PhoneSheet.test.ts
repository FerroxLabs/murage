// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phone sheets (UX L7): a labelled modal dialog with its own Close, holding
// the keyboard; a Needs you row opens as one on a phone and in place on a
// computer; Today's tags and the Needs you chips scroll sideways on a phone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneSheet } from "./PhoneSheet";
import { NeedsRow } from "../needs/NeedsRow";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const verbs = createElement("div", null, createElement("button", null, "Allow once"), createElement("button", null, "Deny"));
const row = () => renderToStaticMarkup(createElement(NeedsRow, { id: "r1", line: "Send the Dana email?", meta: "Max · waiting since 07:12", open: true, onToggle: () => undefined }, verbs));
const setPhone = (matches: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: matches && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));

afterEach(() => { vi.unstubAllGlobals(); });

describe("PhoneSheet", () => {
  it("is a modal dialog named by its title, with a Close button and the body's own markers", () => {
    const html = renderToStaticMarkup(createElement(PhoneSheet, { title: "Send the Dana email?", onClose: vi.fn(), bodyData: { "data-needs-row": "r1" }, children: verbs }));
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="([^"]+)"/);
    const id = /aria-labelledby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`<h2 id="${id}"`);
    expect(html).toContain(">Send the Dana email?</h2>");
    expect(html).toContain('aria-label="Close"');
    expect(html).toMatch(/data-needs-row="r1" role="dialog"/);
    expect(html).toContain("line-clamp-3");
    expect(html).toContain("Allow once");
  });

  it("is named by the card's own heading when the card has one, and then draws no second heading", () => {
    const source = read("./PhoneSheet.tsx");
    expect(source).toContain('body.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading]")');
    expect(source).toContain("aria-labelledby={namedBy ?? titleId}");
    expect(source).toContain("{namedBy ? <span");
    expect(source).toContain("new MutationObserver(find)");
    // Only a sheet that asks for it: any other sheet keeps its own title.
    expect(source).toContain('namedByBodyHeading ? ref.current?.querySelector("[data-box-body]") : null');
    expect(read("../needs/NeedsRow.tsx")).toContain("bodyId={bodyId} namedByBodyHeading>");
    // b35-approvals.human.spec.ts proves it in a browser: one "Which format..." heading at 390 px, and the sheet is named by it.
    expect(read("../../e2e/b35-approvals.human.spec.ts")).toContain('getByRole("dialog", { name: "Which format should the report use?" })');
  });

  it("holds the keyboard, closes on Escape and on the dimmed page, and is drawn over every page box", () => {
    const source = read("./PhoneSheet.tsx");
    expect(source).toContain("useFocusTrap(ref, true, { onEscape: onClose });");
    expect(source).toContain("event.target === event.currentTarget && onClose()");
    expect(source).toContain("createPortal(sheet, document.body)");
  });
});

describe("Needs you row on a phone", () => {
  it("on a computer the open card shows in place", () => {
    setPhone(false);
    const html = row();
    expect(html).not.toContain('role="dialog"');
    expect(html).toMatch(/<div id="needs-row-body-r1" class="border-t/);
    expect(html).toContain("Allow once");
  });

  it("on a phone the open card rises as a sheet titled with the question, and the key model still finds its row", () => {
    setPhone(true);
    const html = row();
    expect(html).toContain('role="dialog"');
    // Inbox moves focus into needs-row-body-<id> (the question group): the sheet's body carries the same id.
    expect(html).toMatch(/role="dialog"[\s\S]*id="needs-row-body-r1"/);
    expect(html.match(/id="needs-row-body-r1"/g)).toHaveLength(1);
    expect(html).toContain(">Send the Dana email?</h2>");
    // the open sheet alone names the entry: the row under it drops the marker, so a lookup by id finds one element
    expect(html.match(/data-needs-row="r1"/g)).toHaveLength(1);
    expect(html).toMatch(/data-needs-row="r1" role="dialog"/);
    expect(html).toMatch(/<li data-open="true"/);
    expect(html).toContain("Allow once");
  });

  it("Today's tags and the Needs you chips stay on one line and scroll sideways on a phone", () => {
    expect(read("../today/StatusLine.tsx")).toContain("max-md:flex-nowrap max-md:overflow-x-auto");
    expect(read("../Inbox.tsx")).toMatch(/data-needs-chips className="[^"]*max-md:flex-nowrap max-md:overflow-x-auto/);
  });
});
