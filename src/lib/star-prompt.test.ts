// The "Like Murage so far?" card: when it may show, what each button does, and where it never shows.
// Every count lives in this window's own storage; nothing here sends anything anywhere.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STAR_DAYS_NEEDED,
  STAR_SNOOZE_DAYS,
  STAR_URL,
  clickNotNow,
  clickStar,
  dayKey,
  freshStarState,
  noteTurnFinished,
  openStarPage,
  parseStarState,
  readStarState,
  setStarPromptOn,
  starPromptSetting,
  starPromptShows,
  writeStarState,
  type StarContext,
  type StarState,
} from "./star-prompt";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 10, 1, 12, 0, 0).getTime();
const at = (day: number) => T0 + day * DAY;
const ctx = (extra: Partial<StarContext> = {}): StarContext => ({
  now: at(30),
  desktop: true,
  storeBuild: false,
  allowInStores: false,
  turnRunning: false,
  approvalOpen: false,
  ...extra,
});

/** A state with the owner having finished turns on `n` different days. */
function used(n: number, ok = true): StarState {
  let state = freshStarState();
  for (let day = 0; day < n; day++) state = noteTurnFinished(state, ok, at(day));
  return state;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("star prompt: trigger counting", () => {
  it("does not show before five different days of use", () => {
    expect(STAR_DAYS_NEEDED).toBe(5);
    expect(starPromptShows(used(4), ctx())).toBe(false);
    expect(starPromptShows(used(5), ctx())).toBe(true);
  });

  it("counts a day once however many turns finish on it", () => {
    let state = freshStarState();
    for (let turn = 0; turn < 12; turn++) state = noteTurnFinished(state, true, at(0) + turn * 60_000);
    expect(state.days).toHaveLength(1);
    expect(starPromptShows(state, ctx())).toBe(false);
  });

  it("counts calendar days in the owner's own time zone", () => {
    expect(dayKey(new Date(2026, 10, 3, 0, 5).getTime())).toBe("2026-11-03");
    expect(dayKey(new Date(2026, 10, 3, 23, 55).getTime())).toBe("2026-11-03");
    expect(dayKey(new Date(2026, 10, 4, 0, 5).getTime())).toBe("2026-11-04");
  });

  it("needs the last turn to have finished well", () => {
    const state = noteTurnFinished(used(5), false, at(5));
    expect(state.lastTurnOk).toBe(false);
    expect(starPromptShows(state, ctx())).toBe(false);
    // the next good turn brings it back
    expect(starPromptShows(noteTurnFinished(state, true, at(5)), ctx())).toBe(true);
  });

  it("keeps the day list short however long Murage is used", () => {
    expect(used(400).days.length).toBeLessThanOrEqual(60);
    expect(starPromptShows(used(400), ctx())).toBe(true);
  });
});

describe("star prompt: Not now, the star click, the toggle", () => {
  it("snoozes for 14 days after the first Not now", () => {
    expect(STAR_SNOOZE_DAYS).toBe(14);
    const state = clickNotNow(used(5), at(10));
    expect(starPromptShows(state, ctx({ now: at(10) + 1 }))).toBe(false);
    expect(starPromptShows(state, ctx({ now: at(10) + 13 * DAY }))).toBe(false);
    expect(starPromptShows(state, ctx({ now: at(10) + 14 * DAY }))).toBe(true);
  });

  it("never shows again after a second Not now", () => {
    const state = clickNotNow(clickNotNow(used(5), at(10)), at(25));
    expect(state.notNow).toBe(2);
    expect(starPromptShows(state, ctx({ now: at(400) }))).toBe(false);
  });

  it("never shows again after a star click", () => {
    const state = clickStar(used(5));
    expect(state.starred).toBe(true);
    expect(starPromptShows(state, ctx({ now: at(400) }))).toBe(false);
    // use after the click does not bring it back
    expect(starPromptShows(noteTurnFinished(state, true, at(401)), ctx({ now: at(401) }))).toBe(false);
  });

  it("the Settings toggle turns it off and on without losing the count", () => {
    const off = setStarPromptOn(used(5), false);
    expect(starPromptSetting(off)).toBe(false);
    expect(starPromptShows(off, ctx())).toBe(false);
    const on = setStarPromptOn(off, true);
    expect(starPromptSetting(on)).toBe(true);
    expect(starPromptShows(on, ctx())).toBe(true);
  });

  it("does not bring back a finished choice when the toggle is switched on again", () => {
    expect(starPromptShows(setStarPromptOn(clickStar(used(5)), true), ctx())).toBe(false);
  });
});

describe("star prompt: where it never shows", () => {
  it("not during a running turn", () => {
    expect(starPromptShows(used(5), ctx({ turnRunning: true }))).toBe(false);
  });
  it("not over an approval card", () => {
    expect(starPromptShows(used(5), ctx({ approvalOpen: true }))).toBe(false);
  });
  it("not in a guest, room or remote audience view, nor before the surface is known", () => {
    expect(starPromptShows(used(5), ctx({ desktop: false }))).toBe(false);
    expect(starPromptShows(used(5), ctx({ desktop: undefined }))).toBe(false);
  });
  it("hidden in a store build unless the build flag allows it", () => {
    expect(starPromptShows(used(5), ctx({ storeBuild: true }))).toBe(false);
    expect(starPromptShows(used(5), ctx({ storeBuild: true, allowInStores: true }))).toBe(true);
  });
});

describe("star prompt: storage", () => {
  it("round-trips through the window's own storage under one key", () => {
    const storage = memoryStorage();
    writeStarState(clickNotNow(used(6), at(7)), storage);
    expect([...storage.map.keys()]).toEqual(["murage.starPrompt.v1"]);
    const back = readStarState(storage);
    expect(back.days).toHaveLength(6);
    expect(back.notNow).toBe(1);
  });

  it("reads damaged or hostile storage as a fresh state", () => {
    for (const raw of ["", "not json", "[]", "null", '{"days":"x","notNow":-4,"snoozeUntil":"soon","starred":"yes"}']) {
      const state = parseStarState(raw);
      expect(state.days).toEqual([]);
      expect(state.notNow).toBe(0);
      expect(state.starred).toBe(false);
      expect(Number.isFinite(state.snoozeUntil)).toBe(true);
    }
  });

  it("works with no storage at all", () => {
    const refusing = { getItem() { throw new Error("no storage"); }, setItem() { throw new Error("no storage"); }, removeItem() {} };
    expect(readStarState(refusing).days).toEqual([]);
    expect(() => writeStarState(used(5), refusing)).not.toThrow();
  });
});

describe("star prompt: the link", () => {
  it("is the project page, and the click opens it in the system browser", async () => {
    expect(STAR_URL).toBe("https://github.com/FerroxLabs/murage");
    const openExternal = vi.fn(async () => true);
    const open = vi.fn();
    vi.stubGlobal("window", { muragebox: { openExternal }, open });
    await expect(openStarPage()).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/FerroxLabs/murage");
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a link that did not open, so the card can stay", async () => {
    vi.stubGlobal("window", { muragebox: { openExternal: async () => { throw new Error("no browser"); } } });
    await expect(openStarPage()).resolves.toBe(false);
  });
});

describe("star prompt: wiring", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the card is mounted once, beside the update pop-up", () => {
    expect(read("../App.tsx")).toMatch(/<StarPrompt \/>/);
  });

  // The store stream and the store-build preload flag are witnessed on their real paths: src/state/star-turn-stream.dom.test.ts and electron/star-store-bridge.node-test.mjs.

  it("Settings has the toggle", () => {
    expect(read("../components/settings/pages/GeneralPage.tsx")).toMatch(/<StarPromptRow \/>/);
  });

  it("sends nothing: no fetch, beacon or analytics call in the module", () => {
    expect(read("./star-prompt.ts")).not.toMatch(/\bfetch\(|sendBeacon|XMLHttpRequest|analytics|posthog/i);
  });
});

describe("star prompt: runtime frames", () => {
  let runtime: typeof import("./star-prompt");

  beforeEach(async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.resetModules();
    runtime = await import("./star-prompt");
  });

  it("counts a finished turn that went well, and only a finished turn", () => {
    runtime.noteStarTurn({ type: "content.delta" }, true, false);
    expect(runtime.getStarState().days).toEqual([]);
    runtime.noteStarTurn({ type: "turn.completed", ok: true }, true, false);
    expect(runtime.getStarState().days).toHaveLength(1);
    expect(runtime.getStarState().lastTurnOk).toBe(true);
  });

  it("remembers that the last turn failed, so a sad owner is not asked", () => {
    runtime.noteStarTurn({ type: "turn.completed", ok: true }, true, false);
    runtime.noteStarTurn({ type: "turn.completed", ok: false }, true, false);
    expect(runtime.getStarState().lastTurnOk).toBe(false);
  });

  it("a turn that does not say it failed counts as well", () => {
    runtime.noteStarTurn({ type: "turn.completed" }, true, false);
    expect(runtime.getStarState().lastTurnOk).toBe(true);
  });

  it("only counts live frames from the confirmed owner's computer", () => {
    runtime.noteStarTurn({ type: "turn.completed" }, undefined, false);
    runtime.noteStarTurn({ type: "turn.completed" }, false, false);
    runtime.noteStarTurn({ type: "turn.completed" }, true, true);
    expect(runtime.getStarState()).toEqual(freshStarState());
    expect(localStorage.getItem(runtime.STAR_STORE_NAME)).toBeNull();
  });
});
