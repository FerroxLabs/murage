// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, createElement, type FC } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { api } from "@/state/store";
import { McpServersPanel } from "./McpServersPanel";

const Panel: FC<{ embedded?: boolean }> = McpServersPanel;

vi.mock("@/state/store", () => ({ api: vi.fn() }));

it.each([false, true])("finishes loading after page translation with embedded=%s", async (embedded) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await setLocale("en");
  let resolveList!: (value: object) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { resolveList = resolve; }));
  const host = document.createElement("section");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Panel, { embedded })));
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim()) textNodes.push(node as Text);
    }
    expect(textNodes.some(text => text.data.trim() === "Loading connected tools…")).toBe(true);
    for (const text of textNodes) {
      const wrapper = document.createElement("font");
      const translated = document.createElement("font");
      translated.textContent = "Translated " + text.data.trim();
      wrapper.append(translated);
      text.replaceWith(wrapper);
    }
    await act(async () => resolveList({ servers: [{
      name: "fixture-docs", command: "example", args: [], envKeys: [], enabled: true,
    }] }));
    expect(host.textContent).not.toContain("Loading connected tools…");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Edit fixture-docs"]')?.disabled).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
