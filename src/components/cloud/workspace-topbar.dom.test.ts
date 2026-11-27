// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// 1.0.23 top bar (Sean, 1.0.22 on a Mac): the This computer | Cloud home strip sat under the window buttons, every customer
// saw it once Cloud went live, and a "Connect to your Cloud home" card (same words as its own button) sat above the whole
// app while This computer was chosen. Driven through the real WorkspaceSwitch with only the preload bridge faked.
import { act, createElement, useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../../testing/dom-harness";
import type { CloudHomeBridge } from "../../lib/cloud-workspace";
import { AppUnderCloud, WorkspaceSwitch } from "./WorkspaceSwitch";
import de from "../../locales/de.json";
import en from "../../locales/en.json";
import es from "../../locales/es.json";
import fr from "../../locales/fr.json";
import hi from "../../locales/hi.json";
import ja from "../../locales/ja.json";
import ptBr from "../../locales/pt-br.json";
import zh from "../../locales/zh.json";

type Status = { open: boolean; pending: boolean; paired: boolean; disconnected?: boolean; startedAt?: number; lastResult?: { code: string; message: string } | null };
type LinkEvent = { kind: string };

const IDLE: Status = { open: true, pending: false, paired: false };
const PENDING: Status = { open: true, pending: true, paired: false, startedAt: Date.now() };
// (a startedAt of 1 is a pending Connect long past its ten minutes: W-EXPIRED)
/** `statuses`: what main's connect-status answers, in order (the last one repeats). */
/** `owned`: the Cloud homes the control plane lists for this Murage account (cloud-home:list-homes). */
function bridgeFor({ paired = [] as { homeId: string; origin: string }[], status = IDLE, statuses = [status] as Status[], owned = [] as string[], signedIn = true } = {}) {
  let link: ((event: LinkEvent) => void) | null = null;
  let reads = 0;
  let cancelled = false;
  const homes = { paired };
  const raw = {
    state: vi.fn(async () => ({ enabled: true, cpSignedIn: signedIn, paired: homes.paired })),
    open: vi.fn(async () => ({ opened: true })),
    connectStatus: vi.fn(async () => (cancelled ? IDLE : statuses[Math.min(reads++, statuses.length - 1)]!)),
    disconnect: vi.fn(async () => { homes.paired = []; }),
    listHomes: vi.fn(async () => owned.map((id) => ({ id, name: "Home", status: "ready", reachable: true, paired: false }))),
    connectCancel: vi.fn(async () => { reads = Math.max(reads, statuses.length - 1); cancelled = true; }),
    connectStart: vi.fn(async () => ({ startedAt: Date.now() })),
    onLinkEvent: (callback: (event: LinkEvent) => void) => { link = callback; return () => { link = null; }; },
  };
  return { bridge: raw as unknown as CloudHomeBridge, raw, link: (event: LinkEvent) => act(() => link?.(event)) };
}

const group = () => document.querySelector('[role="group"][aria-label="Workspace"]');
const pressed = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label)?.getAttribute("aria-pressed") ?? null;
const press = (label: string) => {
  const target = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!target) throw new Error(`no button named ${label}`);
  act(() => { target.click(); });
};
const text = () => document.body.textContent ?? "";
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
async function flush() { for (let i = 0; i < 20; i += 1) { await settle(); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2)); }); } }

let restore: () => void;
beforeAll(async () => { restore = installDOMHarness(); await import("./ConnectHome"); });
afterAll(() => restore());
afterEach(() => cleanup());

const HOME = { homeId: "home-a", origin: "https://home-a.example" };

describe("W-INSET: on a Mac the strip leaves the window buttons their room and moves the window; elsewhere it is unchanged", () => {
  it("mac-inset: a 68px window-buttons space comes before the switch, and the strip is a drag region", async () => {
    const w = bridgeFor({ paired: [HOME] });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge, macInset: true }));
    await flush();
    const space = group()?.previousElementSibling;
    expect([space?.matches("[data-window-buttons-space]") === true && space.className.includes("w-[68px]"), Boolean(group()?.closest("[data-window-drag]"))]).toEqual([true, true]);
  });

  it("Windows/Linux (native chrome): no space and no drag region", async () => {
    const w = bridgeFor({ paired: [HOME] });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge, macInset: false }));
    await flush();
    expect([Boolean(group()), group()?.previousElementSibling ?? null, Boolean(group()?.closest("[data-window-drag]"))]).toEqual([true, null, false]);
  });
});

describe("W-GATE: the Cloud flag alone is not a Cloud plan; no Cloud in hand, no strip", () => {
  it("Cloud live, nothing paired, no Connect under way, no link: nothing at all", async () => {
    const w = bridgeFor();
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    expect([group(), text()]).toEqual([null, ""]);
  });

  it.each([
    ["a paired home", () => bridgeFor({ paired: [HOME] }), null],
    ["a Connect from this app under way, signed in or not, no home listed", () => bridgeFor({ status: PENDING, signedIn: false }), null],
    ["the result of a Connect still shown", () => bridgeFor({ status: { open: true, pending: false, paired: false, lastResult: { code: "lost", message: "Press Connect again." } }, signedIn: false }), null],
    ["a signed-in account with a Cloud plan (the control plane lists its home), nothing paired or pending", () => bridgeFor({ owned: ["home-a"] }), null],
    ["a disconnected computer", () => bridgeFor({ status: { open: true, pending: false, paired: false, disconnected: true } }), null],
    ["a My Cloud link that started a Connect in main", () => bridgeFor({ statuses: [IDLE, PENDING] }), { kind: "connect-cloud" }],
  ] as const)("shows the strip for %s", async (_name, make, event) => {
    const w = make();
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    if (event) { w.link(event); await flush(); }
    expect(Boolean(group())).toBe(true);
  });
});

describe("W-LINK: a murage:// link by itself is not Cloud (anyone can open one)", () => {
  it("a link after which main reports no Connect, no home and no disconnect: still nothing", async () => {
    const w = bridgeFor();
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    w.link({ kind: "open-cloud" });
    await flush();
    expect([group(), text()]).toEqual([null, ""]);
  });
});

describe("W-PLAN: with no pairing, no Connect and no result, only an account with a Cloud plan sees the strip", () => {
  it("signed in, the control plane lists no home: nothing", async () => {
    const w = bridgeFor({ owned: [] });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    expect([w.raw.listHomes.mock.calls.length > 0, group(), text()]).toEqual([true, null, ""]);
  });

  it("not signed in, even if a home were listed: nothing", async () => {
    const w = bridgeFor({ owned: ["home-a"], signedIn: false });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    expect([w.raw.listHomes.mock.calls.length, group(), text()]).toEqual([0, null, ""]);
  });
});

describe("W-PENDING: a Connect from this app, or its result, keeps the strip and Use copied link reachable", () => {
  it("pending Connect, signed out, no home listed: strip shown, Cloud home view offers Use copied link", async () => {
    const w = bridgeFor({ status: PENDING, signedIn: false });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    const cloud = [...document.querySelectorAll("button")].find((b) => b.textContent === "Cloud home");
    if (cloud) { act(() => { cloud.click(); }); await flush(); }
    const labels = [...document.querySelectorAll("button")].filter((b) => !b.closest('[role="group"]')).map((b) => b.textContent);
    expect([Boolean(group()), labels.includes("Use copied link")]).toEqual([true, true]);
  });
});

describe("W-CANCEL: the strip follows what main says now; a cancelled Connect takes it away again", () => {
  it("signed out, Connect pending, strip up; Cancel on the panel: no strip, no card", async () => {
    const w = bridgeFor({ status: PENDING, signedIn: false });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    expect(Boolean(group())).toBe(true);
    press("Cloud home");
    await flush();
    press("Cancel");
    await flush();
    expect([w.raw.connectCancel.mock.calls.length, group(), text()]).toEqual([1, null, ""]);
  });
});

describe("W-LASTHOME: disconnecting the last home from the panel leaves the strip and the Cloud home view where they are", () => {
  it("two homes, Disconnect: the panel turns to Connect instead of vanishing", async () => {
    const w = bridgeFor({ paired: [HOME, { homeId: "home-b", origin: "https://home-b.example" }] });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    press("Cloud home");
    await flush();
    act(() => { [...document.querySelectorAll("button")].find((b) => b.textContent === "Disconnect this computer")!.click(); });
    await flush();
    expect([w.raw.disconnect.mock.calls.length, Boolean(group()), pressed("Cloud home"), text().includes("Your Cloud home is not connected yet.")]).toEqual([1, true, "true", true]);
  });
});

describe("W-SLOT: in the app the Cloud home view goes in App's layer over the main area, not beside the strip", () => {
  it("the card is inside the slot it was given and nowhere else", async () => {
    const w = bridgeFor({ statuses: [PENDING, IDLE], owned: ["home-a"] });
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const view = mount(createElement(WorkspaceSwitch, { bridge: w.bridge, cloudSlot: slot }));
    await flush();
    press("Cloud home");
    await flush();
    const card = document.querySelector("[data-connect-home]");
    const where = [Boolean(card && slot.contains(card)), Boolean(card && view.container.contains(card))];
    slot.remove();
    expect(where).toEqual([true, false]);
  });
});

describe("W-VIEW: the Connect card lives only inside the Cloud home view, never above This computer", () => {
  it("This computer chosen: no card; Cloud home chosen: the card in the Cloud home view; This computer again: gone", async () => {
    // Cloud in hand: a Connect was under way when the window opened; it has stopped since, so the panel is idle.
    const w = bridgeFor({ statuses: [PENDING, IDLE], owned: ["home-a"] });
    const views: boolean[] = [];
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge, onViewChange: (cloud: boolean) => views.push(cloud) }));
    await flush();
    const computer = [pressed("This computer"), document.querySelector("[data-connect-home]")];
    press("Cloud home");
    await flush();
    const card = document.querySelector("[data-connect-home]");
    const cloud = [pressed("This computer"), pressed("Cloud home"), Boolean(card?.closest('[data-cloud-home-view][aria-label="Cloud home"]')), views.at(-1)];
    press("This computer");
    await flush();
    const back = [pressed("This computer"), document.querySelector("[data-connect-home]"), views.at(-1)];
    expect({ computer, cloud, back }).toEqual({
      computer: ["true", null],
      cloud: ["false", "true", true, true],
      back: ["true", null, false],
    });
  });
});

describe("W-COPY: one plain line and one Connect button, no repeated words", () => {
  it("the Cloud home view says it once: Your Cloud home is not connected yet. + Connect", async () => {
    const w = bridgeFor({ statuses: [PENDING, IDLE], owned: ["home-a"] });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    press("Cloud home");
    await flush();
    // The whole window, not one container: the words a person reads, and every button but the switch's own two.
    const view = text();
    const labels = [...document.querySelectorAll("button")].filter((b) => !b.closest('[role="group"]')).map((b) => b.textContent);
    expect([count(view, "Your Cloud home is not connected yet."), labels, count(view, "Connect to your Cloud home")]).toEqual([1, ["Connect"], 0]);
  });

  it("all 8 locales carry both strings, and no locale repeats the line as its button", () => {
    const packs: Record<string, Record<string, string>> = { en, de, es, fr, hi, ja, "pt-br": ptBr, zh };
    const rows = Object.entries(packs).map(([locale, pack]) => [locale, Boolean(pack["cloudConnect.notConnected"]?.trim()), Boolean(pack["cloudConnect.connect"]?.trim()), pack["cloudConnect.notConnected"] !== pack["cloudConnect.connect"]]);
    expect(rows).toEqual(Object.keys(packs).map((locale) => [locale, true, true, true]));
  });
});

describe("W-INERT: the app under the Cloud home view cannot be reached, the Cloud home view can", () => {
  // Wired as App wires it: the switch reports its view, the app's rail and main view sit in AppUnderCloud, the view goes in the slot.
  function Host({ bridge }: { bridge: CloudHomeBridge }) {
    const [cloud, setCloud] = useState(false);
    const [slot, setSlot] = useState<HTMLDivElement | null>(null);
    return createElement("div", null,
      createElement(WorkspaceSwitch, { bridge, onViewChange: setCloud, cloudSlot: slot }),
      createElement("div", { ref: setSlot }),
      createElement(AppUnderCloud, { covered: cloud, children: createElement("button", { type: "button", id: "rail-bot" }, "Ada") }));
  }
  it("This computer: the rail is live; Cloud home: the rail is inert and Connect is not; back: live again", async () => {
    const w = bridgeFor({ paired: [HOME, { homeId: "home-b", origin: "https://home-b.example" }] });
    mount(createElement(Host, { bridge: w.bridge }));
    await flush();
    const inertRail = () => document.getElementById("rail-bot")?.closest("[inert]") !== null;
    const before = inertRail();
    press("Cloud home");
    await flush();
    const during = [inertRail(), document.querySelector("[data-connect-home]")?.closest("[inert]") ?? null];
    press("This computer");
    await flush();
    expect({ before, during, after: inertRail() }).toEqual({ before: false, during: [true, null], after: false });
  });
});

describe("W-SELECTED: the chosen segment reads as chosen in light and dark", () => {
  const cls = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label)?.className ?? "";
  it("selected: brighter fill and full-white text, with a light-skin fill; unselected: transparent and muted; flips with the choice", async () => {
    const w = bridgeFor({ paired: [HOME, { homeId: "home-b", origin: "https://home-b.example" }] });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    const selected = (c: string) => c.includes("bg-hairline") && c.includes("text-white") && c.includes("[[data-skin=light]_&]:bg-ink") && !c.includes("bg-inset");
    const muted = (c: string) => c.includes("bg-transparent") && c.includes("text-ink-secondary") && !c.includes("text-white");
    const first = [selected(cls("This computer")), muted(cls("Cloud home"))];
    press("Cloud home");
    await flush();
    expect({ first, second: [muted(cls("This computer")), selected(cls("Cloud home"))] }).toEqual({ first: [true, true], second: [true, true] });
  });
});

describe("W-HIDDEN-INSET: with the strip hidden a Mac keeps its top band (window buttons room + drag); elsewhere nothing is added", () => {
  it("mac-inset, no Cloud in hand: no switch, but a drag band holding the 68px buttons space, as tall as the strip", async () => {
    const w = bridgeFor();
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge, macInset: true }));
    await flush();
    const band = document.querySelector("[data-window-inset]");
    expect([Boolean(group()), band?.hasAttribute("data-window-drag"), Boolean(band?.querySelector("[data-window-buttons-space].w-\\[68px\\]")), band?.className.includes("min-h-11")]).toEqual([false, true, true, true]);
  });

  it("the shown strip and the hidden band are the same height, so Connect appearing does not move the app", async () => {
    const hidden = bridgeFor();
    mount(createElement(WorkspaceSwitch, { bridge: hidden.bridge, macInset: true }));
    await flush();
    const hiddenH = document.querySelector("[data-window-inset]")?.className.match(/min-h-\S+/)?.[0];
    cleanup();
    const shown = bridgeFor({ paired: [HOME] });
    mount(createElement(WorkspaceSwitch, { bridge: shown.bridge, macInset: true }));
    await flush();
    expect([hiddenH, document.querySelector("[data-workspace-strip]")?.className.match(/min-h-\S+/)?.[0]]).toEqual(["min-h-11", "min-h-11"]);
  });

  it("Windows/Linux, hidden: nothing is drawn (the window's own title bar is the top)", async () => {
    const w = bridgeFor();
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge, macInset: false }));
    await flush();
    expect([document.querySelector("[data-window-inset]"), document.querySelector("[data-workspace-strip]")]).toEqual([null, null]);
  });
});

describe("W-RING: the two segments do not clip each other's focus ring (the stray line between them)", () => {
  it("no clipping group; each segment carries its own outer corner", async () => {
    const w = bridgeFor({ paired: [HOME] });
    mount(createElement(WorkspaceSwitch, { bridge: w.bridge }));
    await flush();
    const [a, b] = [...(group()?.querySelectorAll("button") ?? [])];
    const clipped = [group(), group()?.parentElement].some((el) => /overflow-(hidden|clip)/.test(el?.className ?? ""));
    expect([clipped, a?.className.includes("rounded-l-md"), b?.className.includes("rounded-r-md")]).toEqual([false, true, true]);
  });

  it("the ring rule is inset (so it cannot run into the neighbour) and the strip adds no ring to plain :focus", async () => {
    const css = (await import("node:fs")).readFileSync(`${process.cwd()}/src/styles.css`, "utf8");
    const rule = css.match(/\[data-workspace-strip\] button:focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(/outline-offset:\s*-2px/.test(rule) && !/\[data-workspace-strip\] button:focus\s*[,{]/.test(css)).toBe(true);
  });
});

describe("W-EXPIRED: a Connect whose ten minutes are up never shows a live 0:00", () => {
  const STALE = { open: true, pending: true, paired: false, startedAt: Date.now() - 10 * 60_000 - 5_000 };
  it("pending past the window (main has not discarded it yet): expired alert + Connect again, no Time left, no Use copied link", async () => {
    const { ConnectHome } = await import("./ConnectHome");
    const w = bridgeFor({ status: STALE });
    mount(createElement(ConnectHome, { bridge: w.bridge, paired: [] }));
    await flush();
    expect([text().includes("Time left"), Boolean(document.querySelector("[data-connect-expired]")), text().includes("Connect again"), text().includes("Use copied link")]).toEqual([false, true, true, false]);
  });

  it("a Connect with time left still shows its countdown and the live buttons", async () => {
    const { ConnectHome } = await import("./ConnectHome");
    const w = bridgeFor({ status: { ...PENDING, startedAt: Date.now() - 60_000 } });
    mount(createElement(ConnectHome, { bridge: w.bridge, paired: [] }));
    await flush();
    expect([text().includes("Time left"), Boolean(document.querySelector("[data-connect-expired]")), text().includes("Use copied link")]).toEqual([true, false, true]);
  });
});
