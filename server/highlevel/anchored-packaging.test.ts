import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
it("T-A12 packaged.anchoredAddonLoads is required on both native platforms", () => {
  const yml = read("../../electron-builder.yml"), after = read("../../scripts/after-pack.mjs");
  expect(yml).toContain("dist-native/anchored-read/darwin-${arch}/anchored-read.node");
  expect(yml).toContain("dist-native/anchored-read/win32-x64/anchored-read.node");
  expect(after).toContain("proveAnchoredReadResource(anchoredFile, packagedElectronBinary(context))");
  expect(after).toContain('path.join(resources, "anchored-read.node")');
  const pkg = JSON.parse(read("../../package.json"));
  for (const target of ["mac", "win"]) expect(pkg.scripts[`package:${target}`]).toContain("pnpm build:anchored-read");
  expect(read("../../.github/workflows/native-addon-msvc.yml")).toContain("node scripts/prove-anchored-read.mjs");
  expect(read("../../.github/workflows/package-mac-qualification.yml")).toContain("pnpm build:anchored-read");
});
