// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// DESIGN 1022-cua-windows R10d / W-C6 (D17 c): the real Local control card. Disable is called first and always; the
// stop sweep never gates it, whether the sweep answers 500, fails on the network, or never answers.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LinuxLocalControl } from "./LinuxLocalControl";

const capabilities = {
  host: { platform: "linux", label: "Linux", homeDir: "/home/owner", session: "x11" },
  localComputer: { available: true, enabled: true, status: "ready", driverSource: "bundled" },
};
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities, ready: true }) }));

let root: Root | null = null;
let host: HTMLElement | null = null;
const events: string[] = [];
const localControl = { enable: vi.fn(async () => {}), disable: vi.fn(async () => { events.push("disable"); }), retry: vi.fn(async () => {}) };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  events.length = 0;
  localControl.disable.mockClear();
  (window as unknown as { muragebox: unknown }).muragebox = { localControl };
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

async function clickDisable(fetchImpl: (input: RequestInfo | URL) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes("/api/local-computer/interrupt")) events.push("sweep");
    return fetchImpl(input);
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<LinuxLocalControl />));
  const button = [...host.querySelectorAll("button")].find((entry) => /disable/i.test(entry.textContent ?? ""));
  expect(button, "the card shows a Disable button").toBeTruthy();
  await act(async () => { button!.click(); });
  // let the card's own microtasks (desktop proof, fetch) run without waiting on the sweep's answer
  await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
}

const rows: Array<[string, (input: RequestInfo | URL) => Promise<Response>]> = [
  ["sweep answers 500", async () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })],
  ["sweep network error", async () => { throw new TypeError("network down"); }],
  ["sweep never answers", () => new Promise<Response>(() => {})],
];

for (const [name, fetchImpl] of rows) {
  it(`W-C6 ${name}: localControl.disable is called exactly once`, async () => {
    await clickDisable(fetchImpl);
    expect(localControl.disable, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
}

it("W-C6 order: disable is called before the sweep request is issued", async () => {
  await clickDisable(rows[0][1]);
  expect(events[0]).toBe("disable");
});
