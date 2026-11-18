// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, press, settle } from "../testing/dom-harness";
import { DelegationPackChip, DelegationPackLine, DelegationPackSheet, type PreparedPackRow } from "./DelegationPack";

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); });
const names = { packId: "pack", sourceBotName: "Sable", targetBotName: "Ember" };

describe("delegation pack click test", () => {

  it.each(["mixed", "recent-only", "older-only", "forgotten"] as const)("T-OLDER-SHEET: %s keeps recent unheaded and older under its own heading", async mode => {
    const older = mode === "forgotten"
      ? [{ id: "old-forgotten", page: "older", state: "forgotten" }, { id: "old-unavailable", page: "older", state: "unavailable" }] as const
      : [{ id: "old", page: "older", state: "text", author: "Sable", text: "Earlier request" }] as const;
    const recent = mode === "forgotten"
      ? [{ id: "new-forgotten", page: "recent", state: "forgotten" }, { id: "new-unavailable", page: "recent", state: "unavailable" }] as const
      : [{ id: "new", page: "recent", state: "text", author: "Ember", text: "Recent request" }] as const;
    const rows = [...(mode === "recent-only" ? [] : older), ...(mode === "older-only" ? [] : recent)];
    mount(h(DelegationPackSheet, { ...names, load: async () => ({ rows }), onClose: vi.fn() }));
    await settle();
    const sheet = document.querySelector("[data-delegation-pack-sheet]")!;
    const lists = [...sheet.querySelectorAll("ol")];
    expect(lists).toHaveLength(mode === "mixed" || mode === "forgotten" ? 2 : 1);
    const heading = [...sheet.querySelectorAll("h3")].find(el => el.textContent === "Older lines Ember asked for");
    if (mode === "recent-only") {
      expect(heading).toBeUndefined();
      expect(lists[0].textContent).toBe("EmberRecent request");
    } else {
      expect(heading).toBeDefined();
      expect(heading!.nextElementSibling).toBe(lists.at(-1));
      expect(lists.at(-1)!.textContent).toBe(mode === "forgotten" ? "1 line you forgot1 line without a preview" : "SableEarlier request");
    }
    if (mode === "mixed" || mode === "forgotten") {
      expect(lists[0].nextElementSibling).toBe(heading);
      expect(lists[0].previousElementSibling).toBeNull();
      expect(lists[0].textContent).toBe(mode === "forgotten" ? "1 line you forgot1 line without a preview" : "EmberRecent request");
    }
  });

  for (const Component of [DelegationPackLine, DelegationPackChip]) {
    it(`T-OLDER-SHEET Krug click: ${Component.name} opens both sections and refreshes older forget`, async () => {
      let forgotten = false;
      const load = vi.fn(async () => ({ rows: [
        forgotten ? { id: "old", page: "older", state: "forgotten" } as const
          : { id: "old", page: "older", state: "text", author: "Sable", text: "Older private request" } as const,
        { id: "new", page: "recent", state: "text", author: "Ember", text: "Recent request" } as const,
      ] }));
      mount(h(Component, { ...names, state: "prepared", load }));
      const opener = document.querySelector<HTMLButtonElement>("button")!;
      act(() => { opener.focus(); opener.click(); }); await settle();
      expect(load).toHaveBeenCalledExactlyOnceWith("pack");
      const sheet = document.querySelector("[data-delegation-pack-sheet]")!;
      expect([...sheet.querySelectorAll("ol")].map(el => el.textContent)).toEqual(["EmberRecent request", "SableOlder private request"]);
      expect(sheet.querySelector("h3")!.textContent).toBe("Older lines Ember asked for");
      press("Escape"); await settle();
      expect(document.activeElement).toBe(opener);
      forgotten = true;
      act(() => opener.click()); await settle();
      expect(load).toHaveBeenCalledTimes(2);
      expect([...document.querySelectorAll("ol")].map(el => el.textContent)).toEqual(["EmberRecent request", "1 line you forgot"]);
      expect(document.body.textContent).not.toContain("Older private request");
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click()); await settle();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
  }

  it.each([
    ["unavailable", "1 line without a preview"],
    ["forgotten", "1 line you forgot"],
  ] as const)("sheet renders %s rows without preview fields; kills missing placeholder", async (state, placeholder) => {
    const textRow: PreparedPackRow = { id: "line", page: "recent", state: "text", author: "Sable", text: "Book The Garden" };
    const loadText = async () => ({ rows: [textRow] });
    const view = mount(h(DelegationPackSheet, { ...names, load: loadText, onClose: vi.fn() }));
    await settle();
    expect(document.querySelector("ol li")!.textContent).toBe("SableBook The Garden");

    const placeholderRow: PreparedPackRow = { id: textRow.id, page: "recent", state };
    const loadPlaceholder = async () => ({ rows: [placeholderRow] });
    view.rerender(h(DelegationPackSheet, { ...names, load: loadPlaceholder, onClose: vi.fn() }));
    await settle();
    const row = document.querySelector("ol li")!;
    expect(row.textContent).toBe(placeholder);
    expect(row.querySelector("span, p")).toBeNull();
    expect(document.body.textContent).not.toContain(textRow.text);
  });

  for (const Component of [DelegationPackLine, DelegationPackChip]) {
    it(`${Component.name}: one click opens prepared lines, Escape returns focus, reopen reads current forget; kills cached sheet`, async () => {
      let rows: PreparedPackRow[] = [{ id: "line", page: "recent", state: "text", author: "Sable", text: "Book The Garden" }];
      const load = vi.fn(async () => ({ rows }));
      mount(h(Component, { ...names, state: "prepared", load }));
      const opener = document.querySelector<HTMLButtonElement>("button")!;
      act(() => { opener.focus(); opener.click(); }); await settle();
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Prepared for Ember from your chat with Sable");
      expect(dialog.textContent).toContain("Book The Garden");
      press("Escape"); await settle();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
      rows = [{ id: "line", page: "recent", state: "forgotten" }];
      act(() => opener.click()); await settle();
      expect(load).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="dialog"]')!.textContent).toContain("1 line you forgot");
      expect(document.body.textContent).not.toContain("Book The Garden");
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click()); await settle();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  }

  it("T-PREPARED: a pending line has no details click; kills premature opener", async () => {
    const load = vi.fn(async () => ({ rows: [] }));
    const view = mount(h(DelegationPackLine, { ...names, state: "prepared", load }));
    expect(document.querySelector("button")).not.toBeNull();
    view.rerender(h(DelegationPackLine, { ...names, state: "queued", load }));
    expect(document.querySelector("button")).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("sheet has an empty state and a retry after an unreadable response; kills empty/error conflation", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("fixture private error")).mockResolvedValue({ rows: [] });
    mount(h(DelegationPackSheet, { ...names, load, onClose: vi.fn() })); await settle();
    expect(document.body.textContent).not.toContain("Nothing from this chat");
    expect(document.body.textContent).not.toContain("fixture private error");
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Try again")!;
    expect(retry).toBeDefined();
    act(() => retry.click()); await settle();
    expect(document.body.textContent).toContain("Nothing from this chat has been prepared for Ember yet.");
  });

  it("closing before the read completes keeps the sheet closed; kills late response reopening", async () => {
    let complete!: (value: { rows: PreparedPackRow[] }) => void;
    const load = () => new Promise<{ rows: PreparedPackRow[] }>(resolve => { complete = resolve; });
    mount(h(DelegationPackLine, { ...names, state: "prepared", load }));
    act(() => document.querySelector<HTMLButtonElement>("button")!.click()); await settle();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    press("Escape"); await settle();
    await act(async () => complete({ rows: [{ id: "line", page: "recent", state: "text", author: "Sable", text: "Book The Garden" }] }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Book The Garden");
  });
});
