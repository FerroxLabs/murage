// The wordmark is baked ink, not a tintable glyph.
//
// public/murage-logo.png is white — mean brightness of its opaque pixels is
// 246 — and it was rendered unconditionally, so on the light theme's card it
// was white on near-white and simply disappeared. murage-logo-dark.png is the
// same mark at 16. There is nothing CSS can do about a raster.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const onboarding = readFileSync(
  fileURLToPath(new URL("../components/Onboarding.tsx", import.meta.url)),
  "utf8",
);
const hook = readFileSync(
  fileURLToPath(new URL("./use-active-skin.ts", import.meta.url)),
  "utf8",
);

describe("the wordmark follows the theme", () => {
  it("shows the dark-ink mark on light and the white one on dark", () => {
    expect(onboarding).toContain('skin === "light" ? "/murage-logo-dark.png" : "/murage-logo.png"');
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
