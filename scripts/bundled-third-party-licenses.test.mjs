// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every third-party asset that ships inside the app has its license text
// travel with it (MIT and OFL both require it). Each row names the shipped
// asset, the third_party directory that holds the upstream license, and the
// file in it; the test proves the asset and the license exist, and that
// electron-builder.yml copies that directory to licenses/<name>.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const builder = readFileSync(new URL("electron-builder.yml", root), "utf8");

const BUNDLED = [
  { name: "silero-vad", asset: "public/vad/silero_vad.onnx", license: "LICENSE", text: /MIT License/ },
  { name: "instrument-serif", asset: "src/assets/fonts/instrument-serif-latin-400-normal.woff2", license: "OFL.txt", text: /SIL Open Font License/ },
  { name: "openmausbot-teams", asset: "library/packages/engineering.md", license: "LICENSE", text: /MIT License/ },
];

describe("bundled third-party licenses", () => {
  for (const row of BUNDLED) {
    it(`${row.name} ships with its license`, () => {
      expect(existsSync(new URL(row.asset, root)), row.asset).toBe(true);
      expect(readFileSync(new URL(`third_party/${row.name}/${row.license}`, root), "utf8")).toMatch(row.text);
      expect(builder).toMatch(new RegExp(`- from: third_party/${row.name}\\n\\s+to: licenses/${row.name}\\n`));
    });
  }
});
