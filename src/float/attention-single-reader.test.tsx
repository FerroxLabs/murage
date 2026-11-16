// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AttentionItems, AttentionWindowBridge } from "../attention-ui/bridge";
import { AttentionPanel } from "../attention-ui/AttentionPanel";
import { Pill } from "../pill/Pill";
import { Bubble } from "./Bubble";
import { Dock } from "./Dock";

// G1: the refresh path assumes one live reader per window (host seq, reader
// rev). Every packaged entry must mount exactly one useAttentionItems.
let rev = 0;
beforeEach(async () => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); await setLocale("en"); rev = 0; });
afterEach(() => { delete window.attentionWindow; });

const entries = [["tray-panel", () => <AttentionPanel />], ["pill", () => <Pill />], ["bubble", () => <Bubble />], ["dock", () => <Dock />]] as const;
for (const [name, render] of entries) {
  it(`${name} mounts exactly one attention reader`, async () => {
    const data = { ok: true, items: [], openToken: "app", running: [], receipts: [], chief: null, pill: { state: "collapsed", count: 0, toggleToken: "t" }, bots: [] };
    const items = vi.fn(async () => ({ ...data, rev: ++rev }) as unknown as AttentionItems);
    const onChange = vi.fn(() => vi.fn());
    window.attentionWindow = { items, onChange, act: vi.fn(), open: vi.fn(), sendToChief: vi.fn(), sendToPinned: vi.fn(), pauseAutomations: vi.fn() } as unknown as AttentionWindowBridge;
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    await act(async () => { root.render(render()); });
    expect(onChange).toHaveBeenCalledTimes(1); expect(items).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount()); container.remove();
  });
}
