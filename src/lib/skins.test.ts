// The registry and the stylesheet are two halves of one contract: a palette
// listed here without a matching CSS block renders as whatever was active
// before, with no error anywhere. That failure is silent, so it gets a test.
//
// The other half of this file is the migration off the four-skin era. Deleting
// two ids without it means every user on Foundry or Lagoon silently falls
// through to the default — and a Lagoon user, who chose a *light* app, would
// wake up in dark mode.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCE,
  DEFAULT_SKIN,
  LEGACY_SKINS,
  SKINS,
  SKIN_IDS,
  THEME_PREFERENCES,
  readPreference,
  resolveSkin,
  watchSystemSkin,
} from "./skins";

const here = dirname(fileURLToPath(import.meta.url));
// Comments are stripped: the file explains in prose that there is no
// [data-skin="auto"] block, and a parser that reads comments would find one.
const css = readFileSync(join(here, "../styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const blocks = new Set(
  [...css.matchAll(/\[data-skin="([a-z-]+)"\]/g)].map(([, id]) => id),
);

/** The custom properties declared inside one `[data-skin]` block. */
function tokensOf(id: string): Set<string> {
  const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
}

/** The tokens a palette is responsible for: everything the `@theme` and `:root`
 *  base blocks declare, minus the animation tokens, which do not vary by theme.
 *
 *  The reference is the BASE, deliberately — not `tokensOf(DEFAULT_SKIN)`, which
 *  is what this test used to do. That made the reference set carry the same hole
 *  as the default palette, and it is why Midnight could omit `--color-focus` and
 *  silently inherit the upstream Grok blue while the suite stayed green. */
function baseTokens(): Set<string> {
  const names = new Set<string>();
  for (const [, body] of css.matchAll(/(?:@theme|:root)\s*\{([^}]*)\}/g)) {
    for (const [, name] of body.matchAll(/(--[\w-]+)\s*:/g)) {
      if (/^--(color|font|radius)-/.test(name)) names.add(name);
    }
  }
  return names;
}

/** localStorage does not exist in the node test environment, and the module
 *  reaches for the bare global. A map is enough; `throws` covers the blocked-
 *  storage path, which is a real failure mode in a packaged renderer. */
function fakeStorage(options: { throws?: boolean } = {}) {
  const map = new Map<string, string>();
  const store = {
    getItem: (key: string) => {
      if (options.throws) throw new Error("storage is blocked");
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  vi.stubGlobal("localStorage", store);
  return map;
}

/** A matchMedia stand-in whose `change` listeners can be fired by hand. */
function fakeMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  vi.stubGlobal("window", { matchMedia: () => mq });
  return {
    emit(next: boolean) {
      mq.matches = next;
      for (const fn of listeners) fn();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("skins", () => {
  it("gives every registered skin a stylesheet block", () => {
    for (const id of SKIN_IDS) expect(blocks).toContain(id);
  });

  it("registers every stylesheet block", () => {
    // SAFETY: the assertion only fits toContain()'s parameter type — the
    // assertion IS the check, and an unregistered block fails the test.
    for (const id of blocks) expect(SKIN_IDS).toContain(id as (typeof SKIN_IDS)[number]);
  });

  it("never ships a stylesheet block for a preference that is not a palette", () => {
    // "auto" is a stored preference resolved before anything is stamped. A
    // `[data-skin="auto"]` block would be a third palette to keep in contrast
    // and would leave every consumer of the attribute unable to say what colour
    // anything is.
    expect(blocks.has("auto")).toBe(false);
  });

  it("defines every base token in every skin", () => {
    const reference = baseTokens();
    expect(reference.size).toBeGreaterThan(20);
    for (const id of SKIN_IDS) {
      expect([...reference].filter((token) => !tokensOf(id).has(token))).toEqual([]);
    }
  });

  it("describes each skin exactly once", () => {
    expect(SKINS.map((skin) => skin.id).sort()).toEqual([...SKIN_IDS].sort());
    for (const skin of SKINS) expect(skin.name.length).toBeGreaterThan(0);
  });

  it("defaults a new install to Automatic, and a DOM-less renderer to dark", () => {
    expect(DEFAULT_PREFERENCE).toBe("auto");
    expect(DEFAULT_SKIN).toBe("dark");
    expect([...THEME_PREFERENCES]).toEqual(["light", "dark", "auto"]);
  });
});

describe("migration from the four-skin era", () => {
  // Asserted against the mapping table rather than the implementation: an
  // implementation that special-cases `midnight` and forgets `foundry` fails
  // exactly one row, naming the population it would have re-themed.
  it.each([
    ["midnight", "dark"],
    ["foundry", "dark"],
    ["atelier", "light"],
    ["lagoon", "light"],
  ])("maps a stored %s to %s", (stored, expected) => {
    fakeStorage().set("murage-skin", stored);
    expect(readPreference()).toBe(expected);
  });

  it("rewrites storage so the migration runs once", () => {
    const store = fakeStorage();
    store.set("murage-skin", "lagoon");
    readPreference();
    expect(store.get("murage-skin")).toBe("light");
  });

  it.each(["light", "dark", "auto"])("leaves a current preference alone", (preference) => {
    fakeStorage().set("murage-skin", preference);
    expect(readPreference()).toBe(preference);
  });

  it("falls back to Automatic for a value from nowhere", () => {
    fakeStorage().set("murage-skin", "chartreuse");
    expect(readPreference()).toBe("auto");
  });

  it("survives storage that throws", () => {
    fakeStorage({ throws: true });
    expect(readPreference()).toBe("auto");
  });

  it("keeps index.html's pre-paint stamp in step with skins.ts", () => {
    // index.html duplicates this map on purpose — a module import there would
    // reintroduce the flash it closes. Losing a row would show up as one black
    // frame on launch for users of the skin you just retired: never in a test,
    // always in a bug report.
    const html = readFileSync(join(here, "../../index.html"), "utf8");
    for (const [legacy, target] of Object.entries(LEGACY_SKINS)) {
      expect(html).toMatch(new RegExp(`${legacy}\\s*:\\s*"${target}"`));
    }
    expect(html).toContain("prefers-color-scheme: dark");
  });
});

describe("automatic", () => {
  it("resolves auto from the OS", () => {
    fakeMatchMedia(true);
    expect(resolveSkin("auto")).toBe("dark");
    fakeMatchMedia(false);
    expect(resolveSkin("auto")).toBe("light");
  });

  it("ignores the OS once a theme is chosen", () => {
    fakeMatchMedia(true);
    expect(resolveSkin("light")).toBe("light");
  });

  it("falls back to dark where matchMedia does not exist", () => {
    vi.stubGlobal("window", {});
    expect(resolveSkin("auto")).toBe("dark");
  });

  it("follows the OS while the preference is auto", () => {
    fakeStorage().set("murage-skin", "auto");
    const mq = fakeMatchMedia(false);
    const seen: string[] = [];
    watchSystemSkin((id) => seen.push(id));
    mq.emit(true);
    expect(seen).toEqual(["dark"]);
  });

  it("stops following the OS after the user picks a theme", () => {
    // The subtle one. Drop the readPreference() guard inside the handler — the
    // plausible simplification, since the listener "is only registered for
    // auto" — and the app overrides an explicit choice the moment the OS flips.
    const store = fakeStorage();
    const mq = fakeMatchMedia(false);
    const seen: string[] = [];
    watchSystemSkin((id) => seen.push(id));
    store.set("murage-skin", "light");
    mq.emit(true);
    expect(seen).toEqual([]);
  });

  it("unsubscribes cleanly", () => {
    fakeStorage().set("murage-skin", "auto");
    const mq = fakeMatchMedia(false);
    const seen: string[] = [];
    watchSystemSkin((id) => seen.push(id))();
    mq.emit(true);
    expect(seen).toEqual([]);
  });
});
