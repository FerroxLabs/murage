// The wordmark is baked ink, not a tintable glyph.
//
// public/murage-logo.png is white — mean brightness of its opaque pixels is
// 246 — and it was rendered unconditionally, so on the light theme's card it
// was white on near-white and simply disappeared. murage-logo-dark.png is the
// same mark at 16. There is nothing CSS can do about a raster.
//
// The outcome-first onboarding (bf1dc245) then dropped the raster from its
// welcome step for a text eyebrow, which has no theme problem to solve. The
// rule survives the screen: wherever the white raster is shown, the light
// theme must be handed the dark one, and today nothing shows it at all.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const onboarding = readFileSync(join(root, "components/Onboarding.tsx"), "utf8");
const hook = readFileSync(join(root, "lib/use-active-skin.ts"), "utf8");

/** Shipped renderer sources: every .ts/.tsx under src that is not a test. */
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

/** Does this source show the white raster only with the dark one beside it,
 *  chosen by the live skin? A file that never names the raster has nothing to
 *  get wrong. */
function wordmarkFollowsTheme(source: string): boolean {
  if (!source.includes("/murage-logo.png")) return true;
  return source.includes('skin === "light" ? "/murage-logo-dark.png" : "/murage-logo.png"')
    && source.includes("useActiveSkin()");
}

describe("the wordmark follows the theme", () => {
  it("never shows the white raster without handing the light theme the dark one", () => {
    // The rule, proven against the shape that shipped the defect before it
    // sweeps: an unconditional white raster fails, the paired form passes.
    expect(wordmarkFollowsTheme('<img src="/murage-logo.png" alt="Murage" />')).toBe(false);
    expect(wordmarkFollowsTheme(
      'const skin = useActiveSkin();\n<img src={skin === "light" ? "/murage-logo-dark.png" : "/murage-logo.png"} alt="Murage" />',
    )).toBe(true);
    for (const file of sources(root)) {
      expect(wordmarkFollowsTheme(readFileSync(file, "utf8")), relative(root, file)).toBe(true);
    }
  });

  it("is not on the welcome step any more, which is text and needs no theme", () => {
    // bf1dc245: "WELCOME TO MURAGE" as an eyebrow over the outcome question.
    // The raster left with the avatar; if it comes back it comes back through
    // the rule above.
    expect(onboarding).toContain("WELCOME TO MURAGE");
    expect(onboarding).not.toContain("murage-logo");
  });

  it("reads the resolved palette, not the stored preference", () => {
    // Under Automatic the preference is the string "auto", which names no
    // asset. Only data-skin knows what that resolved to, and every path —
    // an explicit choice, a migrated legacy id, an OS flip mid-session —
    // agrees there because they all go through applySkin.
    expect(hook).toContain("document.documentElement.dataset.skin");
    expect(hook).not.toContain("readPreference");
  });

  it("keeps watching, because the OS can flip while the screen is open", () => {
    // Onboarding is the first screen and can sit open for minutes. A value
    // read once would be stale the moment the system switched to dark.
    expect(hook).toContain("MutationObserver");
    expect(hook).toContain('attributeFilter: ["data-skin"]');
    expect(hook).toContain("observer.disconnect()");
  });
});
