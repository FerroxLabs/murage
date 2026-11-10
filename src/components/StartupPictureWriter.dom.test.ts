// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// FIRSTRUN-1019 slice B: the writer in a real DOM (B5, B6b, B7), with the real Ember component drawing the faces.
import { createElement as h } from "react";
import { act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { isInertSvg } from "../../electron/startup-picture.mjs";
import { MASCOT_BODY_IDS } from "../../shared/mascot-bodies";

const fixture = vi.hoisted(() => ({ bots: [] as Array<Record<string, unknown>> }));
vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: { bots: fixture.bots }, dispatch: vi.fn() }),
}));

import { StartupPictureWriter, renderMascotFace } from "./StartupPictureWriter";

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  fixture.bots = [
    { id: "s", name: "Sable", color: "orange", chiefOfStaff: true, chiefScope: "workspace" },
    { id: "n", name: "Nova", color: "blue" },
    { id: "p", name: "Pepper", color: "green" },
  ];
});
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); vi.useRealTimers(); });

const PICTURE = { v: 1, tipNext: 4, faceA: "<svg/>", faceB: "<svg/>", tip: { id: "needs", head: "h", line: "l", try: "t" }, at: 1 };
function deps() {
  return {
    save: vi.fn(async (_payload: unknown) => true),
    sessionTip: vi.fn(async () => 3 as number | null),
    compose: vi.fn(async () => PICTURE),
  };
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("B5 a renamed, recoloured or re-bodied Chief rewrites the picture once", () => {
  it("writes once after the debounce, then once more after a change, and not again without one", async () => {
    vi.useFakeTimers();
    const d = deps();
    const app = mount(h(StartupPictureWriter, { chiefBotId: "s", suspended: false, deps: d }));
    await advance(1999);
    expect(d.save).not.toHaveBeenCalled();
    await advance(1);
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledWith(PICTURE);
    expect(d.sessionTip).toHaveBeenCalled();
    await advance(5 * 60_000);
    expect(d.save).toHaveBeenCalledTimes(1);
    fixture.bots = fixture.bots.map((bot) => (bot.id === "s" ? { ...bot, name: "Sable Two", color: "teal", mascotBody: "star" } : bot));
    app.rerender(h(StartupPictureWriter, { chiefBotId: "s", suspended: false, deps: d }));
    await advance(60_000);
    expect(d.save).toHaveBeenCalledTimes(2);
    await advance(5 * 60_000);
    expect(d.save).toHaveBeenCalledTimes(2);
  });

  it("composes from the real roster: the Chief, then the teammates in order, with the saved rotation point", async () => {
    vi.useFakeTimers();
    const d = deps();
    mount(h(StartupPictureWriter, { chiefBotId: "s", suspended: false, deps: d }));
    await advance(2000);
    const input = (d.compose.mock.calls[0] as unknown[])[0] as { roster: { chief: { name: string }; mates: { name: string }[] }; sessionTip: number | null };
    expect(input.roster.chief.name).toBe("Sable");
    expect(input.roster.mates.map((bot) => bot.name)).toEqual(["Nova", "Pepper"]);
    expect(input.sessionTip).toBe(3);
  });
});

describe("a failed rotation lookup never resets the saved rotation", () => {
  it("skips the write when main cannot say which tip this start showed, and writes once it can", async () => {
    vi.useFakeTimers();
    const d = deps();
    d.sessionTip.mockRejectedValueOnce(new Error("ipc"));
    const app = mount(h(StartupPictureWriter, { chiefBotId: "s", suspended: false, deps: d }));
    await advance(2000);
    expect(d.compose).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
    fixture.bots = fixture.bots.map((bot) => (bot.id === "s" ? { ...bot, name: "Sable Two" } : bot));
    app.rerender(h(StartupPictureWriter, { chiefBotId: "s", suspended: false, deps: d }));
    await advance(60_000);
    expect(d.save).toHaveBeenCalledTimes(1);
  });

  it("does not save a picture whose composition was still running when the welcome opened", async () => {
    vi.useFakeTimers();
    const d = deps();
    let release: (value: typeof PICTURE) => void = () => {};
    d.compose.mockImplementationOnce(() => new Promise<typeof PICTURE>((resolve) => { release = resolve; }));
    const app = mount(h(StartupPictureWriter, { chiefBotId: "s", suspended: false, deps: d }));
    await advance(2000);
    expect(d.compose).toHaveBeenCalledTimes(1);
    app.rerender(h(StartupPictureWriter, { chiefBotId: "s", suspended: true, deps: d }));
    release(PICTURE);
    await advance(0);
    expect(d.save).not.toHaveBeenCalled();
    app.unmount();
  });
});

describe("B7 the writer never runs while the welcome is up", () => {
  it("writes nothing while suspended and writes after the welcome is gone", async () => {
    vi.useFakeTimers();
    const d = deps();
    const app = mount(h(StartupPictureWriter, { chiefBotId: "s", suspended: true, deps: d }));
    await advance(10 * 60_000);
    expect(d.save).not.toHaveBeenCalled();
    expect(d.compose).not.toHaveBeenCalled();
    app.rerender(h(StartupPictureWriter, { chiefBotId: "s", suspended: false, deps: d }));
    await advance(2000);
    expect(d.save).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a surface with no desktop bridge, and nothing without a Chief", async () => {
    vi.useFakeTimers();
    const none = { ...deps(), save: undefined };
    mount(h(StartupPictureWriter, { chiefBotId: "s", suspended: false, deps: none as never }));
    fixture.bots = [{ id: "n", name: "Nova", color: "blue" }];
    const d = deps();
    mount(h(StartupPictureWriter, { chiefBotId: null, suspended: false, deps: d }));
    await advance(10 * 60_000);
    expect(d.save).not.toHaveBeenCalled();
    expect(none.compose).not.toHaveBeenCalled();
  });
});

describe("B6b the real Ember face, serialised, is a standalone image main accepts", () => {
  const parse = (svg: string) => {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror"), svg.slice(0, 200)).toBeNull();
    return doc;
  };

  it("draws every body in two states as well-formed, inert, self-contained SVG with unique ids", async () => {
    for (const body of MASCOT_BODY_IDS) {
      const faces = await Promise.all((["idle", "happy"] as const).map((state) => renderMascotFace({ id: "s", name: "Sable", color: "orange", mascotBody: body }, state, state === "idle" ? "fa" : "fb")));
      for (const face of faces) {
        expect(face, body).not.toBeNull();
        expect(isInertSvg(face), body).toBe(true);
        const doc = parse(face!);
        expect(doc.documentElement.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
        const ids = [...doc.querySelectorAll("[id]")].map((node) => node.id);
        expect(new Set(ids).size, body).toBe(ids.length);
        for (const ref of face!.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)) expect(ids, `${body} ${ref[0]}`).toContain(ref[1] ?? ref[2]);
        expect(face).not.toMatch(/var\(--|class="[^"]*animate/);
      }
      expect(faces[0], `${body}: image A and B are not the same picture`).not.toBe(faces[1]);
    }
  });

  it("gives ids no collision between two faces of one start, and survives the main-side prefixing", async () => {
    const a = await renderMascotFace({ id: "s", name: "Sable", color: "orange" }, "idle", "fa");
    const b = await renderMascotFace({ id: "s", name: "Sable", color: "orange" }, "happy", "fb");
    const ids = (svg: string) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids(a!).every((id) => id.startsWith("fa-"))).toBe(true);
    expect(ids(b!).every((id) => id.startsWith("fb-"))).toBe(true);
    expect(ids(a!).length).toBeGreaterThan(0);
    expect(ids(a!).filter((id) => ids(b!).includes(id))).toEqual([]);
  });
});
