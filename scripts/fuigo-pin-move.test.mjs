import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { moveSites, movePin } from "./fuigo-pin-move.mjs";
import { FUIGO_VERSION } from "./prepare-fuigo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const receipt = `scripts/fuigo-${FUIGO_VERSION}-provenance.json`;
const sites = Object.keys(moveSites(FUIGO_VERSION, "9.9.9"));
const hashes = ["a", "b", "c"].map(ch => ch.repeat(64));
// Named here, not read from moveSites(): a site dropped from the tool must still be copied and checked after a move.
const MANIFEST = "scripts/engine-versions.json";

function copyRoot() {
  const directory = mkdtempSync(join(tmpdir(), "murage-fuigo-move-"));
  for (const file of new Set([...sites, receipt, MANIFEST])) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(join(root, file), join(directory, file));
  }
  captureFor(directory, "9.9.9");
  return directory;
}
function captureFor(directory, version) {
  const file = join(directory, `server/drivers/acp/__fixtures__/fuigo-init/initialize-${version}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version, result: { _meta: { agentVersion: version } } }));
}
const read = (directory, file) => readFileSync(join(directory, file), "utf8");

describe("fuigo-pin-move: one command moves every bundled-version site", () => {
  it("rewrites every site to the new release with pending pins and writes a pending receipt, then fills", () => {
    const directory = copyRoot();
    let filled = 0;
    try {
      movePin("9.9.9", hashes, { root: directory, fill: () => { filled++; } });
      expect(filled).toBe(1);
      expect(read(directory, "scripts/prepare-fuigo.mjs")).toContain('FUIGO_VERSION = "9.9.9"');
      expect(read(directory, "scripts/prepare-fuigo.mjs")).not.toMatch(/(?:tarballSha256|binarySha256): "[a-f0-9]{64}"/);
      expect(read(directory, "scripts/prepare-fuigo.mjs")).toContain("report gitHead FILL\x2dAT-NPM");
      expect(read(directory, "server/fuigo-native-update.ts")).toContain('QUALIFIED_FUIGO_VERSION = "9.9.9"');
      for (const file of sites) expect(read(directory, file), file).not.toContain(FUIGO_VERSION);
      const engines = JSON.parse(read(directory, MANIFEST)).engines;
      expect([engines.fuigo.version, engines["fuigo-qualified"].version], "W-MOVE manifest moved").toEqual(["9.9.9", "9.9.9"]);
      const proof = JSON.parse(read(directory, "scripts/fuigo-9.9.9-provenance.json"));
      expect(proof).toMatchObject({ version: "9.9.9", status: "FILL\x2dAT-NPM", source: "FILL\x2dAT-NPM" });
      for (const row of proof.packages) {
        expect(row.version).toBe("9.9.9");
        expect(row.tarball).toContain("-9.9.9.tgz");
        for (const key of ["tarballSha256", "integrity", "shasum"]) expect(row[key]).toBe("FILL\x2dAT-NPM");
      }
    } finally { safeWipeSync(directory); }
  });

  it.each(["site missing", "fill failed"])("%s: every file is restored and no receipt is left", failure => {
    const directory = copyRoot();
    if (failure === "site missing") copyFileSync(join(root, "package.json"), join(directory, "server/fuigo-native-update.ts"));
    const before = sites.map(file => read(directory, file));
    try {
      expect(() => movePin("9.9.9", hashes, { root: directory, fill: () => { throw new Error("fixture fill failed"); } }))
        .toThrow(failure === "site missing" ? /server\/fuigo-native-update\.ts/ : /fixture fill failed/);
      expect(sites.map(file => read(directory, file))).toEqual(before);
      expect(existsSync(join(directory, "scripts/fuigo-9.9.9-provenance.json"))).toBe(false);
    } finally { safeWipeSync(directory); }
  });

  it("refuses until the new release's real initialize capture is in the tree, before writing anything", () => {
    const directory = copyRoot();
    unlinkSync(join(directory, "server/drivers/acp/__fixtures__/fuigo-init/initialize-9.9.9.json"));
    const before = sites.map(file => read(directory, file));
    let filled = 0;
    try {
      expect(() => movePin("9.9.9", hashes, { root: directory, fill: () => { filled++; } }), "W-MOVE capture required").toThrow(/initialize-9\.9\.9\.json/);
      expect(filled).toBe(0);
      expect(sites.map(file => read(directory, file))).toEqual(before);
    } finally { safeWipeSync(directory); }
  });

  it("refuses a version that is not newer, and bad digests, before writing anything", () => {
    const directory = copyRoot();
    const before = sites.map(file => read(directory, file));
    try {
      expect(() => movePin(FUIGO_VERSION, hashes, { root: directory, fill: () => {} })).toThrow(/newer/);
      expect(() => movePin("9.9.9", ["bad", ...hashes.slice(1)], { root: directory, fill: () => {} })).toThrow(/Usage/);
      expect(sites.map(file => read(directory, file))).toEqual(before);
    } finally { safeWipeSync(directory); }
  });
});
