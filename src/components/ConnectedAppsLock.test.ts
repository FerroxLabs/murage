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

import { APPS_CLAIM, showOwnKeyRetiredLine } from "./ConnectedAppsLock";

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
    expect(read("./PluginsPanel.tsx")).toContain("One Flux Router key connects ${appsClaimFor(catalog?.total, APPS_CLAIM)}.");
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

describe("the one quiet line for someone who once saved a key of their own", () => {
  it("shows until an app is connected through Flux Router, not merely until the broker answers", () => {
    const base = { composio: { configured: false, ownKeyRetired: true } };
    expect(showOwnKeyRetiredLine(base)).toBe(true);
    // Flux reachable but nothing connected yet: still shown (and again after an outage).
    expect(showOwnKeyRetiredLine({ composio: { ...base.composio, configured: true, broker: "flux" } })).toBe(true);
    expect(showOwnKeyRetiredLine({ composio: { ...base.composio, configured: true, broker: "flux" } }, { anyConnected: true })).toBe(false);
    expect(showOwnKeyRetiredLine({ composio: { configured: false, ownKeyRetired: false } })).toBe(false);
    expect(showOwnKeyRetiredLine({ composio: { configured: false } })).toBe(false);
    expect(showOwnKeyRetiredLine(null)).toBe(false);
  });

  it("is a plain line, not a dialog", () => {
    const source = read("./ConnectedAppsLock.tsx");
    const line = source.slice(source.indexOf("export function OwnKeyRetiredLine"), source.indexOf("/** One headline"));
    expect(line).toContain('t("connectedApps.ownKeyRetired")');
    expect(line).not.toMatch(/role="dialog"|aria-modal|onClick|<button/);
  });
});
