// The iOS app draws the page under the status bar and the home indicator
// (viewport-fit=cover, contentInsetAdjustmentBehavior = .never), so the web UI
// owns both insets. Seen on an iPhone with a Dynamic Island: the "Open bot
// list" button sat under the clock, and full-screen Bot settings could not be
// closed because its Close button was under the island. These pin every
// top-anchored and bottom-anchored surface to its inset so a later edit cannot
// quietly drop one. env() is 0px on the desktop and in the Android shell, so
// none of this moves anything there.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL(".", import.meta.url));
const read = (file: string) => readFileSync(join(srcDir, file), "utf8");

/** The className of the element whose opening tag contains `anchor`. */
function elementAt(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('className="', source.lastIndexOf("<", at)) + 'className="'.length;
  return source.slice(open, source.indexOf('"', open));
}

describe("the shared safe-area rules", () => {
  const css = read("styles.css");

  it("defines the insets once, with the keyboard releasing the bottom one", () => {
    expect(css).toContain("--inset-top: env(safe-area-inset-top, 0px);");
    expect(css).toContain("--inset-bottom: env(safe-area-inset-bottom, 0px);");
    expect(css).toMatch(/:root\[data-keyboard="open"\] \{\s*--inset-bottom: 0px;/);
    expect(css).toContain("--vvh-inset: calc(var(--vvh, 100dvh) - var(--inset-top) - var(--inset-bottom));");
  });

  it("moves an overlay-inset backdrop inside the safe area and shrinks --vvh for it", () => {
    const rule = css.slice(css.indexOf(".overlay-inset {"), css.indexOf("}", css.indexOf(".overlay-inset {")));
    expect(rule).toContain("--vvh: var(--vvh-inset);");
    expect(rule).toContain("top: calc(var(--inset-top) + var(--vvt, 0px));");
    expect(rule).toContain("bottom: var(--inset-bottom);");
    // The strips it no longer covers are still dimmed.
    expect(css).toMatch(/\.overlay-inset::before \{\s*bottom: 100%;\s*height: var\(--inset-top\);/);
    expect(css).toMatch(/\.overlay-inset::after \{\s*top: 100%;\s*height: var\(--inset-bottom\);/);
  });
});

describe("the chat column's own controls", () => {
  it("puts the Open bot list button in the chat header's row, below the status bar", () => {
    // The button is the row's first flex item now, not an absolutely
    // positioned overlay in App.tsx, so it inherits the row's inset padding
    // and is centred with the name by construction.
    expect(read("App.tsx")).not.toContain('aria-label="Open bot list"');
    for (const file of ["components/ChatHeader.tsx", "components/GroupView.tsx"]) {
      const source = read(file);
      expect(source, file).toContain('"pt-[calc(0.75rem+env(safe-area-inset-top))]"');
      expect(source, file).toContain("<OpenBotListButton />");
      // No corner reserved for an overlay any more.
      expect(source, file).not.toContain("pl-11");
      expect(source, file).toContain('"pl-3 md:pl-5"');
    }
  });

  it("keeps every other header that carries the button below the status bar", () => {
    for (const file of ["components/BrowserWorkspace.tsx", "components/LocalVmWorkspace.tsx"]) {
      expect(read(file), file).toContain("pt-[calc(0.75rem+env(safe-area-inset-top))] max-md:pl-3");
    }
    expect(read("components/TeamMapPage.tsx")).toContain("pt-[calc(1.25rem+env(safe-area-inset-top))]");
    expect(read("components/SkillRecorderPage.tsx")).toContain("h-[calc(60px+env(safe-area-inset-top))]");
    expect(read("components/SkillRecorderPage.tsx")).toContain("pt-[env(safe-area-inset-top)]");
    expect(read("components/OpenBotListButton.tsx")).toContain("pt-[calc(0.75rem+env(safe-area-inset-top))] md:hidden");
  });

  it("keeps the call hang-up buttons below the status bar", () => {
    for (const file of ["components/CallView.tsx", "components/GroupCallView.tsx"]) {
      expect(elementAt(read(file), 'aria-label="Hang up"'), file).toContain("top-[calc(1.25rem+env(safe-area-inset-top))]");
    }
  });

  it("keeps the calendar focus view's Back button below the status bar", () => {
    const source = read("components/RoutineCalendarPage.tsx");
    const header = source.slice(source.indexOf("<header", source.indexOf("export function RoutinesPage(")));
    expect(header.slice(0, 300)).toContain("pt-[calc(0.75rem+env(safe-area-inset-top))]");
  });

  it("keeps the drawer's footer above the home indicator", () => {
    expect(read("components/Sidebar.tsx")).toContain('"pb-3 pt-2 max-md:pb-[calc(0.75rem+var(--inset-bottom))]"');
  });

  it("keeps the update notice above the home indicator", () => {
    expect(read("components/UpdateBanner.tsx")).toContain("fixed bottom-[calc(1rem+var(--inset-bottom))] left-4");
  });
});

describe("full-screen sheets on a phone", () => {
  it("starts Bot settings' header below the status bar and ends its footer above the home indicator", () => {
    const source = read("components/BotSettingsDialog.tsx");
    const header = elementAt(source, '<header className="flex shrink-0');
    expect(header).toContain("max-sm:pt-[calc(0.75rem+var(--inset-top))]");
    // The desktop's centred layout keeps its own padding.
    expect(header).toContain("py-3");
    expect(header).toContain("sm:px-5");
    expect(source.slice(source.indexOf("<footer"), source.indexOf("<footer") + 200)).toContain("max-sm:pb-[calc(0.5rem+var(--inset-bottom))]");
  });

  it("pads Settings' full-bleed sheet by both insets, below md only", () => {
    expect(read("components/SettingsModal.tsx")).toContain('"max-md:pt-[var(--inset-top)] max-md:pb-[var(--inset-bottom)]"');
  });

  it("pads each panel that covers the chat below md", () => {
    for (const file of ["components/SettingsPanel.tsx", "components/InspectorPanel.tsx", "components/ComputerPanel.tsx"]) {
      const source = read(file);
      expect(source, file).toContain('"max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full",\n        // Covering the chat');
      expect(source, file).toContain('"max-md:pt-[var(--inset-top)] max-md:pb-[var(--inset-bottom)]"');
    }
    expect(read("components/WorkspacePane.tsx")).toContain('narrow && "absolute inset-0 z-40 w-full border-l-0 pt-[var(--inset-top)] pb-[var(--inset-bottom)]"');
  });

  it("keeps the image lightbox's header and footer clear of both insets", () => {
    const lightbox = read("components/ImageMedia.tsx");
    expect(lightbox).toContain("p-3 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-[calc(0.75rem+env(safe-area-inset-bottom))]");
  });

  it("leaves room for the insets around centred <dialog> cards", () => {
    const room = "2*max(var(--inset-top),var(--inset-bottom))";
    for (const file of ["components/TeamExportDialog.tsx", "components/BundleImportDialog.tsx", "components/Announcements.tsx"]) {
      expect(read(file), file).toContain(`max-h-[calc(100dvh-`);
      expect(read(file), file).toContain(room);
      expect(read(file), file).not.toMatch(/max-h-\[calc\(100dvh-(2rem|32px)\)\]/);
    }
    const whatsNew = read("components/WhatsNewDialog.tsx");
    expect(whatsNew.split(room).length - 1).toBe(3);
    expect(whatsNew).not.toContain("max-h-[calc(100dvh-32px)]");
  });
});

describe("every modal backdrop", () => {
  // A backdrop that centres (or top-aligns) a dialog: it hosts controls a
  // person has to reach, so it must move inside the safe area. Click-away
  // layers (`fixed inset-0 z-30` with nothing in them) do not.
  const BACKDROP = /className="([^"]*\bfixed (?:inset-0|inset-x-0 top-0) z-[^"]*\bitems-(?:center|start)\b[^"]*)"/g;
  // SettingsModal's backdrop turns into a full-bleed sheet below md, which
  // pads itself (above); SignedOutCard pads its top inline.
  const OWN_INSETS = new Set(["components/SettingsModal.tsx", "components/SignedOutCard.tsx"]);

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".tsx") && !name.includes(".test.")) files.push(relative(srcDir, path).split(sep).join("/")); // "/" on every OS, to match OWN_INSETS
    }
  };
  walk(join(srcDir, "components"));

  it("is overlay-inset", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of files) {
      if (OWN_INSETS.has(file)) continue;
      for (const match of read(file).matchAll(BACKDROP)) {
        seen += 1;
        if (!match[1].split(/\s+/).includes("overlay-inset")) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it("caps its dialog by --vvh, which overlay-inset shrinks, not by a bare 100dvh", () => {
    for (const [file, cap] of [
      ["components/ChannelDetailsPanel.tsx", "max-h-[min(760px,calc(var(--vvh,100dvh)-1.5rem))]"],
      ["components/Sidebar.tsx", "max-h-[calc(var(--vvh,100dvh)-24px)]"],
      ["components/Sidebar.tsx", "max-h-[min(680px,calc(var(--vvh,100dvh)-2rem))]"],
      ["components/PluginsPanel.tsx", "h-[min(780px,calc(var(--vvh,100dvh)-2rem))]"],
      ["components/TeamLibraryPanel.tsx", "h-[min(780px,calc(var(--vvh,100dvh)-2rem))]"],
      ["components/TeamSettingsDialog.tsx", "max-h-[min(760px,calc(var(--vvh,100dvh)-1.5rem))]"],
    ] as const) {
      expect(read(file), file).toContain(cap);
    }
  });
});
