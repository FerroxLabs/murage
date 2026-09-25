// Every place the app saves a file or opens a page outside itself goes
// through save-file.ts / open-external.ts, so the phone app is never
// skipped by one call site that still builds its own anchor or tab.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("downloads", () => {
  it.each([
    ["./conversation-export.ts"],
    ["./team-files.ts"],
    ["../components/WorkspacePane.tsx"],
  ])("%s never builds its own blob anchor", (path) => {
    const source = read(path);
    expect(source).not.toContain("URL.createObjectURL");
    expect(source).toMatch(/from "@\/lib\/save-file"/);
  });

  // R6 (D4 fix round 1): /api/artifacts is desktop-authority-only
  // (server/desktop-policy.ts DESKTOP_AUTHORITY_ROUTES) and answers 404
  // without the desktop proof, which the phone app cannot supply. So — unlike
  // every other download site — this one deliberately keeps its own blob
  // anchor via `clickDownload` and never reaches for native at all.
  it("../components/Files.tsx keeps the saved artifact download desktop-only, never native", () => {
    const source = read("../components/Files.tsx");
    expect(source).toMatch(/from "@\/lib\/save-file"/);
    expect(source).toContain("clickDownload(url, artifact.filename)");
    expect(source).not.toContain("nativeAvailable");
    expect(source).not.toContain("nativeHas");
    expect(source).not.toContain("saveUrl(");
    expect(source).not.toContain("saveBlob(");
  });

  it("the expired-link renewal saves through saveUrl, not a detached anchor", () => {
    const source = read("../components/MediaPlayer.tsx");
    expect(source).toContain("saveUrl(next.url, asset.name)");
    expect(source).not.toContain("anchor.download = asset.name");
  });

  it("a code snippet goes to the phone app when it can take it", () => {
    expect(read("./code-block.ts")).toContain('if (nativeHas("saveFile"))');
  });
});

describe("pages outside Murage", () => {
  it.each([["../components/ConnectorCard.tsx"], ["../components/PluginsPanel.tsx"]])("%s opens through openExternalPage", (path) => {
    const source = read(path);
    expect(source).toContain("openExternalPage(url,");
    expect(source).not.toContain('window.open("", "_blank")');
  });

  it("the live desktop only pre-opens a browser tab when neither app can open it", () => {
    const source = read("../components/ComputerPanel.tsx");
    expect(source).toContain('!window.muragebox?.desktopViewer && !window.muragebox?.openExternal && !nativeHas("openExternal")');
    expect(source).toContain('await callNative("openExternal", viewerUrl)');
  });
});
