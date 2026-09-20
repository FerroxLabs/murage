// What the connected-apps catalog is called, and what it is never called.
//
// Two defects the owner hit in the same week:
//   - The catalog was described as "hundreds of apps". It is 500+ apps, and
//     the claim was written out by hand in several places, one of which was a
//     first-run panel that is on its way out.
//   - The company behind the catalog was named on screen. Nobody bought it,
//     nobody has heard of it, and it tells a person nothing. The apps are
//     named instead: Gmail, Slack, Notion, GitHub.
//
// These are source contracts, like naming.test.ts: the words matter, not how
// any one screen lays them out.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { APPS_CLAIM, APPS_KEY_FIELD_LABEL, COMPOSIO_KEY_FIELD_SELECTOR } from "./ConnectedAppsLock";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

/** Prose inside a string literal or between JSX tags, the way naming.test.ts
 * reads it: an identifier, an import, a URL and a comment are not prose. */
function visibleWords(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
    if (!code.trim() || /^\s*import /.test(code)) continue;
    for (const [, text] of code.matchAll(/"([^"\\]{2,})"/g)) found.push(text);
    for (const [, text] of code.matchAll(/>([^<>{}]{2,})</g)) found.push(text);
  }
  return found
    .map((text) => text.trim())
    .filter((text) => !/[`${}]|\s[?:]\s|&&/.test(text) && (/\s/.test(text) || /^[A-Z][a-z]+$/.test(text)));
}

const SURFACES = ["./ConnectedAppsLock.tsx", "./PluginsPanel.tsx", "./ApiKeys.tsx"] as const;

describe("the connected-apps catalog", () => {
  it("is 500+ apps, named by the apps people know", () => {
    expect(APPS_CLAIM).toBe("500+ apps, including Gmail, Slack, Notion and GitHub");
    // The panel's own headline sentence uses the constant, not a copy of it.
    expect(read("./PluginsPanel.tsx")).toContain("One Flux Router key connects ${APPS_CLAIM}.");
    for (const file of SURFACES) {
      expect(visibleWords(read(file)).filter((text) => /hundreds of/i.test(text)), file).toEqual([]);
    }
  });

  it("is never described by the name of the company behind it", () => {
    for (const file of SURFACES) {
      expect(visibleWords(read(file)).filter((text) => /composio/i.test(text)), file).toEqual([]);
    }
  });

  it("keeps no price, no model count and no em dash in its copy", () => {
    for (const file of SURFACES) {
      for (const text of visibleWords(read(file))) {
        expect(text, `${file}: ${text}`).not.toMatch(/\u2014/);
        expect(text, `${file}: ${text}`).not.toMatch(/\b(?:cheap|cheaper|discount|wholesale|affordable|free daily allowance)\b/i);
        expect(text, `${file}: ${text}`).not.toMatch(/\d+\+ models/i);
      }
    }
  });
});

describe("the Settings deep-link and the field it looks for", () => {
  // The lock's secondary way in puts the cursor in the key field by finding
  // it with a selector built out of the field's visible label. Rewriting the
  // label used to leave the link hunting for a field that no longer answered
  // to that name, and it failed in silence.
  it("agrees with the label ApiKeys actually renders", () => {
    expect(COMPOSIO_KEY_FIELD_SELECTOR).toBe(`input[aria-label="${APPS_KEY_FIELD_LABEL}"]:not([disabled])`);
    const keys = read("./ApiKeys.tsx");
    // The row takes the label from the same constant the selector is built
    // from, and the input is labelled with the row's label.
    expect(keys).toContain("label: APPS_KEY_FIELD_LABEL,");
    expect(keys).toContain("aria-label={credential.label}");
    // Never spelled out again here, which is how the two drifted apart.
    expect(keys).not.toMatch(/label:\s*"[^"]*project key"/i);
  });
});
