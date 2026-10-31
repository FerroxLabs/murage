// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATE: macOS's folder prompt says why Murage asks. The strings live in the packaging config, and both mac packaging
// paths read them back out of the built Info.plist, so a config change cannot quietly drop them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAC_PROMPT_FOLDERS } from "./mac-folder-prompt.ts";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

describe("the Mac folder purpose strings", () => {
  it.each(MAC_PROMPT_FOLDERS)("%s is in mac.extendInfo in the approved words", (folder) => {
    const config = read("../electron-builder.yml");
    const extendInfo = config.slice(config.indexOf("  extendInfo:"), config.indexOf("NSScreenCaptureUsageDescription"));
    expect(config.indexOf("  extendInfo:")).toBeGreaterThan(config.indexOf("\nmac:\n"));
    expect(extendInfo).toContain(`    NS${folder}FolderUsageDescription: Murage needs this so your bots can work with files in your ${folder} folder when you ask.\n`);
  });

  it("the release and the qualification package both check the built plist", () => {
    for (const source of [read("../.github/workflows/release.yml"), read("../scripts/mac-artifact-qualification.mjs")]) {
      expect(source).toContain("FolderUsageDescription");
      expect(source).toContain("Contents/Info.plist");
      expect(source).toContain("Murage needs this so your bots can work with files in your");
    }
  });
});
