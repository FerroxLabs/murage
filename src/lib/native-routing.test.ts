// Every place the app saves a file or opens a page outside itself goes
// through save-file.ts / open-external.ts, so the phone app is never
// skipped by one call site that still builds its own anchor or tab.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("downloads", () => {
  it.each([
    ["../components/Files.tsx"],
    ["./conversation-export.ts"],
    ["./team-files.ts"],
    ["../components/WorkspacePane.tsx"],
  ])("%s never builds its own blob anchor", (path) => {
    const source = read(path);
    expect(source).not.toContain("URL.createObjectURL");
    expect(source).toMatch(/from "@\/lib\/save-file"/);
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
