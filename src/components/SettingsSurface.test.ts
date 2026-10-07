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

import { sectionsForSurface, settingsSectionRedirect } from "./SettingsModal";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";

const source = readFileSync(fileURLToPath(new URL("./SettingsModal.tsx", import.meta.url)), "utf8");

const SECTIONS = [
  { id: "general", desktopOnly: undefined },
  { id: "connections", desktopOnly: true },
  { id: "engines", desktopOnly: true },
  { id: "channels", desktopOnly: true },
  { id: "companion", desktopOnly: true },
  { id: "computer", desktopOnly: true },
  { id: "memory", desktopOnly: true },
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

  it("waits for the surface before leaving a desktop section it was opened on", () => {
    // Opened on Models before the surface answered: stay, do not land on General for good.
    expect(settingsSectionRedirect(SECTIONS, "connections" as never, undefined, sectionsForSurface(SECTIONS, undefined))).toBeNull();
    // Once the phone answers, the withheld pane is left.
    expect(settingsSectionRedirect(SECTIONS, "connections" as never, false, sectionsForSurface(SECTIONS, false))).toBe("general");
    // A failed first ask answers false without confirming anything: a desktop
    // whose /api/config blipped once must not be moved to General for good.
    expect(settingsSectionRedirect(SECTIONS, "connections" as never, false, sectionsForSurface(SECTIONS, false), false)).toBeNull();
    expect(source).toContain("settingsSectionRedirect(SECTIONS, section, desktop, visible, confirmed)");
    // A section on offer is kept; one filtered out by search moves to the first match.
    expect(settingsSectionRedirect(SECTIONS, "usage" as never, undefined, sectionsForSurface(SECTIONS, undefined))).toBeNull();
    expect(settingsSectionRedirect(SECTIONS, "general" as never, true, SECTIONS.filter((entry) => entry.id === "usage"))).toBe("usage");
  });

  it("changes nothing on the desktop", () => {
    expect(sectionsForSurface(SECTIONS, true)).toEqual(SECTIONS);
  });

  it("locks the panes themselves, not just the navigation", () => {
    // A stale `appSettingsSection` — set on the desktop, or restored from
    // state — must not render a withheld pane just because the nav no longer
    // offers it.
    for (const id of ["connections", "engines", "channels", "computer", "companion", "memory", "botDefaults", "images", "webSearch", "voice", "models", "backups", "experimental", "aboutMe", "houseRules", "skills"]) {
      expect(source, `${id} renders without a surface check`).toContain(`desktop === true && section === "${id}"`);
    }
  });

  it("never treats an unknown surface as the desktop", () => {
    expect(source).not.toMatch(/desktop\s*!==\s*false/);
    expect(source).not.toMatch(/desktop\s*\?\?\s*true/);
  });
});

it("loads Memory as a separate chunk after About me",()=>{expect(source).toMatch(/retryableLazy\(\(\) => import\("\.\/MemorySection"\)\)/);expect(source).not.toMatch(/import .* from "\.\/MemorySection"/);const ids=SETTINGS_SECTIONS.map(entry=>entry.id);expect(ids.indexOf("memory")).toBeGreaterThan(ids.indexOf("aboutMe"));expect(SETTINGS_SECTIONS.find(entry=>entry.id==="memory")).toMatchObject({group:"bots",desktopOnly:true});});

it("Memory uses the retryable component and its retry boundary",()=>{expect(source).toContain("<MemorySection.Component />");expect(source).toContain("onRetry={MemorySection.retry}");});
