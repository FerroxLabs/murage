// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { cleanup, installDOMHarness, mount } from "../testing/dom-harness";
import { redactSecretsInText } from "../../server/redact";
import { RawMarkdownToggle } from "./RawMarkdownToggle";

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => cleanup());
const click = (element: Element) => act(() => { (element as HTMLElement).click(); });
it("starts formatted, toggles exact source bytes, and returns to formatted text", () => {
  const text = "\ufeff**Café**\r\n\t| A | B |\n| 1 | 2 |\n\n<script>never()</script>\n";
  const { container } = mount(h(RawMarkdownToggle, { text }));
  const toggle = container.querySelector("button")!;
  expect(toggle.textContent).toBe("Markdown text");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector("strong")?.textContent).toBe("Café");
  click(toggle);
  expect(toggle.textContent).toBe("Formatted");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("pre")?.textContent).toBe(text);
  expect(container.querySelector("script")).toBeNull();
  click(toggle);
  expect(container.querySelector("strong")?.textContent).toBe("Café");
});
it("shows only masked text in both views, including after the text changes", () => {
  const hidden = ["neutral", "fixture", "credential", "value"].join("_");
  const text = redactSecretsInText(`**Safe** api_key=${hidden}`);
  expect(text).not.toContain(hidden);
  const { container, rerender } = mount(h(RawMarkdownToggle, { text }));
  expect(container.textContent).not.toContain(hidden);
  click(container.querySelector("button")!);
  expect(container.querySelector("pre")?.textContent).toBe(text);
  expect(container.textContent).not.toContain(hidden);
  const next = redactSecretsInText(`New api_key=${hidden}`);
  rerender(h(RawMarkdownToggle, { text: next }));
  expect(container.querySelector("pre")?.textContent).toBe(next);
  click(container.querySelector("button")!);
  expect(container.textContent).not.toContain(hidden);
  expect(container.textContent).toContain("New");
});
it("keeps a message's choice separate from another message", () => {
  const { container } = mount(h("div", null, h(RawMarkdownToggle, { text: "**First**" }), h(RawMarkdownToggle, { text: "**Second**" })));
  click(container.querySelector("button")!);
  expect(container.querySelectorAll("pre")).toHaveLength(1);
  expect(container.querySelector("strong")?.textContent).toBe("Second");
});
it("a plain reply carries no label; formatted source still does", () => {
  const plain = mount(h(RawMarkdownToggle, { text: "I'm a test bot. I run on the Claude engine." }));
  expect(plain.container.querySelector("button")).toBeNull();
  expect(plain.container.textContent).not.toContain("Markdown text");
  cleanup();
  const formatted = mount(h(RawMarkdownToggle, { text: "A **bold** claim" }));
  expect(formatted.container.querySelector("button")?.textContent).toBe("Markdown text");
});
