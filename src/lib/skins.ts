// Themes are pure CSS. Each palette is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart.
//
// Two layers, deliberately separate:
//
//   preference   "light" | "dark" | "auto"   ← what the user chose, persisted
//        │  resolveSkin()
//        ▼
//   resolved     "light" | "dark"            ← what is stamped on <html>
//
// There is no `[data-skin="auto"]` block and there must never be one. Automatic
// is a preference, not a palette: a third block would be a third palette to
// keep in contrast, and every consumer of the attribute (the picker,
// electron/skin-overlay.cjs) would stop being able to say what colour anything
// is.

/** The palettes that exist as CSS blocks. */
export const SKIN_IDS = ["light", "dark"] as const;
export type SkinId = (typeof SKIN_IDS)[number];

/** What the picker edits and what localStorage holds. */
export const THEME_PREFERENCES = ["light", "dark", "auto"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type Skin = {
  id: SkinId;
  name: string;
};

export const SKINS: readonly Skin[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];

/**
 * A new install follows the OS. It is the only default that is never wrong:
 * a dark default is wrong for every light-mode user on first launch, and every
 * existing install already carries an explicit value (see LEGACY_SKINS).
 */
export const DEFAULT_PREFERENCE: ThemePreference = "auto";

/**
 * The palette a renderer that cannot answer matchMedia falls back to — SSR, a
 * locked-down context, a test. Dark, because it matches the app's native window
 * background. This is no longer "the default theme"; DEFAULT_PREFERENCE is.
 */
export const DEFAULT_SKIN: SkinId = "dark";

const KEY = "murage-skin";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Skins that no longer exist, mapped to the palette that preserves their
 * brightness. Read-side only: a value written by any earlier build must land
 * somewhere deliberate, not fall through to the default — without this a
 * Lagoon user (a *light* skin) would silently wake up in dark mode.
 * Removing a row here silently re-themes everyone who was on that skin.
 *
 * index.html carries a copy of this map for its pre-paint stamp; skins.test.ts
 * asserts the two stay identical.
 */
export const LEGACY_SKINS: Readonly<Record<string, SkinId>> = Object.freeze({
  midnight: "dark",
  foundry: "dark",
  atelier: "light",
  lagoon: "light",
});

// The input is whatever localStorage handed back — a string this app wrote on
// an earlier run, a value edited by hand, or a leftover from a renamed skin.
// The list is the schema.
function isPreference(value: unknown): value is ThemePreference {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // check itself is what decides, and a non-member returns false.
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` alone doesn't shield it.
function getStore(): Storage | undefined {
  try {
    // A bare feature test, not a narrowing of parsed input: in a renderer
    // without storage the identifier is simply not defined.
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The OS setting, or DEFAULT_SKIN where it cannot be asked. */
export function systemSkin(): SkinId {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return DEFAULT_SKIN;
    }
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return DEFAULT_SKIN;
  }
}

/** The palette a preference currently means. */
export function resolveSkin(preference: ThemePreference): SkinId {
  return preference === "auto" ? systemSkin() : preference;
}

export function readPreference(): ThemePreference {
  try {
    const stored = getStore()?.getItem(KEY);
    if (isPreference(stored)) return stored;
    if (typeof stored === "string" && Object.hasOwn(LEGACY_SKINS, stored)) {
      const migrated = LEGACY_SKINS[stored];
      // Rewrite so the migration happens once, and so a later downgrade cannot
      // resurrect a skin id that no longer has a CSS block. Best-effort: if the
      // write fails the read still returns the right value and the migration
      // simply runs again next launch.
      writePreference(migrated);
      return migrated;
    }
    return DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function writePreference(preference: ThemePreference): void {
  try {
    getStore()?.setItem(KEY, preference);
  } catch {
    /* quota / private mode — the theme still applies for this session */
  }
}

/**
 * Point the document at a palette. Called once before the first paint
 * (main.tsx) and again on every change from the picker or the OS — a stamped
 * attribute rather than a class so it can never collide with Tailwind.
 *
 * This takes a resolved SkinId, never a preference: the native chrome bridge
 * below has no palette for "auto" and would fall back to dark on a light OS.
 */
export function applySkin(id: SkinId): void {
  document.documentElement.dataset.skin = id;
  // The one surface CSS cannot reach: on Windows the caption buttons sit in a
  // native overlay the main process paints, and the main process also owns the
  // window's own background colour for the next cold start. Best-effort: a
  // browser tab or an older desktop build has no bridge, and the theme still
  // applies without it.
  try {
    void window.muragebox?.applySkin?.(id)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
}

/** Persist a preference and paint its resolution. Returns what was painted. */
export function applyPreference(preference: ThemePreference): SkinId {
  const id = resolveSkin(preference);
  writePreference(preference);
  applySkin(id);
  return id;
}

/**
 * Follow the OS while the preference is "auto". Returns an unsubscribe.
 * Registered once at module scope from main.tsx, NOT inside a component — the
 * theme must keep tracking the OS whether or not Settings is mounted.
 *
 * The handler re-reads the preference rather than trusting a captured value, so
 * a listener registered at startup cannot fight a user who has since picked an
 * explicit theme.
 */
export function watchSystemSkin(onChange: (id: SkinId) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mq = window.matchMedia(DARK_QUERY);
  const handler = () => {
    if (readPreference() === "auto") onChange(mq.matches ? "dark" : "light");
  };
  // Safari < 14 only has addListener; Electron does not need it, a browser
  // build might.
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }
  mq.addListener?.(handler);
  return () => mq.removeListener?.(handler);
}
