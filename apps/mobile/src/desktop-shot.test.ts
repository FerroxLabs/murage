// The picture of the desktop's Settings, then "Phone and other devices" on the
// "Get your code ready" screen (scripts/desktop-phone-shot.mjs). It goes stale
// the day the desktop page changes its words, so this compares the words the
// script recorded with the ones CompanionSection.tsx has now. When it fails:
// rerun `node apps/mobile/scripts/desktop-phone-shot.mjs` and commit what it
// writes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GET_CODE_ALT, GET_CODE_BODY, SCAN_HINT } from "./screens";

interface Shot {
  file: string;
  bytes: number;
  sha256: string;
}
interface Manifest {
  strings: { title: string; switchLabel: string; switchSubtitle: string; cardTitle: string };
  width: number;
  height: number;
  shots: Record<"light" | "dark", Shot>;
}

const manifest = JSON.parse(readFileSync(new URL("./assets/desktop-phone-shot.json", import.meta.url), "utf8")) as Manifest;
const page = readFileSync(new URL("../../../src/components/CompanionSection.tsx", import.meta.url), "utf8");
const constant = (name: string) => page.match(new RegExp(`export const ${name} = "([^"]*)";`))?.[1];

describe("the picture of the desktop page", () => {
  it("shows the words the desktop page uses now", () => {
    expect({
      title: constant("COMPANION_PAGE_TITLE"),
      switchLabel: constant("TURN_ON_LABEL"),
      switchSubtitle: constant("TURN_ON_SUBTITLE"),
      cardTitle: constant("SIGN_IN_CARD_TITLE"),
    }).toEqual(manifest.strings);
  });

  it("is named the way the phone names it", () => {
    expect(GET_CODE_BODY).toContain(`then Settings, then ${manifest.strings.title}.`);
    expect(SCAN_HINT).toContain(`then Settings, then ${manifest.strings.title}.`);
    expect(GET_CODE_ALT).toContain(manifest.strings.title);
    expect(GET_CODE_ALT).toContain(manifest.strings.switchLabel);
    expect(GET_CODE_ALT).toContain(manifest.strings.cardTitle);
  });

  it("is the file the script recorded, light and dark, and small", () => {
    for (const theme of ["light", "dark"] as const) {
      const shot = manifest.shots[theme];
      const bytes = readFileSync(new URL(`./assets/${shot.file}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), theme).toBe(shot.sha256);
      expect(bytes.length, theme).toBeLessThanOrEqual(100 * 1024);
    }
  });
});
