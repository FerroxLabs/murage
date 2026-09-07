// A paired phone must never be shown a credential.
//
// The remote-surface work removed the welcome gate, the engine scan and the
// phone-setup screen, but it could not reach this file — so App Settings kept
// rendering Connections (xAI, Box, Composio, the OpenCode gateway, and the VPS
// connection), Engines (CLI installers), Local VM and Phone on a device whose
// whole job is reading conversations. The browser door refuses the routes
// behind those panes, so nothing could be executed from there. A key on screen
// is still a key disclosed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sectionsForSurface } from "./SettingsModal";

const source = readFileSync(fileURLToPath(new URL("./SettingsModal.tsx", import.meta.url)), "utf8");

const SECTIONS = [
  { id: "general", desktopOnly: undefined },
  { id: "connections", desktopOnly: true },
  { id: "engines", desktopOnly: true },
  { id: "channels", desktopOnly: true },
  { id: "companion", desktopOnly: true },
  { id: "computer", desktopOnly: true },
  { id: "usage", desktopOnly: undefined },
] as unknown as Parameters<typeof sectionsForSurface>[0];

describe("which settings a surface may see", () => {
  it("withholds every credential and execution pane from a phone", () => {
    const ids = sectionsForSurface(SECTIONS, false).map((entry) => entry.id);
    expect(ids).not.toContain("connections");
    expect(ids).not.toContain("engines");
    expect(ids).not.toContain("channels");
    expect(ids).not.toContain("computer");
    expect(ids).not.toContain("companion");
    // and still leaves it something worth opening
    expect(ids).toEqual(["general", "usage"]);
  });

  it("withholds them while the surface is still unknown", () => {
    // Neutral is the narrow side here. Showing an API key for one frame and
    // then hiding it has already disclosed it; a section arriving a moment
    // late on the desktop costs nothing.
    expect(sectionsForSurface(SECTIONS, undefined).map((entry) => entry.id)).toEqual(["general", "usage"]);
  });

  it("changes nothing on the desktop", () => {
    expect(sectionsForSurface(SECTIONS, true)).toEqual(SECTIONS);
  });

  it("locks the panes themselves, not just the navigation", () => {
    // A stale `appSettingsSection` — set on the desktop, or restored from
    // state — must not render a withheld pane just because the nav no longer
    // offers it.
    for (const id of ["connections", "engines", "channels", "computer", "companion"]) {
      expect(source, `${id} renders without a surface check`).toContain(`desktop === true && section === "${id}"`);
    }
  });

  it("never treats an unknown surface as the desktop", () => {
    expect(source).not.toMatch(/desktop\s*!==\s*false/);
    expect(source).not.toMatch(/desktop\s*\?\?\s*true/);
  });
});
