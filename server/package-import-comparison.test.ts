import { describe, expect, it } from "vitest";
import { createBotPackageEntry, parseBotPackageManifest } from "./bot-package-manifest.ts";
import { comparePackageImport, createPackageImportBaseline, type PackageImportBaseline } from "./package-import-comparison.ts";

function fixture() {
  return parseBotPackageManifest({ format: "murage.package.bundle", version: 1,
    definition: { format: "murage.package", version: 1, package: { id: "sample", release: "1.0.0", name: "Sample", tagline: "A fixture", summary: "Portable definitions", category: "Starter", author: { name: "Fixture" }, license: "MIT", outcomes: ["Useful notes"], setupMinutes: 2,
      requirements: { apps: [], capabilities: [] }, chiefOfStaff: "scout", agents: [{ key: "scout", name: "Scout", appearance: { color: "green" } }, { key: "writer", name: "Writer", appearance: { color: "blue" } }] } },
    skills: [], instructions: [{ agent: "scout", path: "bots/scout/SOUL.md" }], entries: [createBotPackageEntry("bots/scout/SOUL.md", "Original supplied notes")],
  });
}
describe("prior imported-selection comparison", () => {
  it("stores only stable identities and hashes, not content, and ignores release-only changes", () => {
    const manifest = fixture(), baseline = createPackageImportBaseline(manifest);
    expect(JSON.stringify(baseline)).not.toMatch(/Original supplied notes|Portable definitions|appearance/);
    manifest.definition.package.agents.reverse(); manifest.definition.package.release = "2.0.0";
    expect(comparePackageImport(manifest, baseline)).toEqual({ status: "compared", incomingRelease: "2.0.0", previousRelease: "1.0.0", changes: [] });
  });
  it("reports requirements and file-content changes using portable identity", () => {
    const manifest = fixture(), baseline = createPackageImportBaseline(manifest);
    manifest.definition.package.requirements.capabilities = ["browser"];
    manifest.entries[0] = createBotPackageEntry("bots/scout/SOUL.md", "Different supplied notes");
    expect(comparePackageImport(manifest, baseline).changes).toEqual(expect.arrayContaining([
      { category: "requirements", key: "package", change: "changed" }, { category: "file", key: "bots/scout/SOUL.md", change: "changed" }, { category: "instruction", key: "scout", change: "changed" },
    ]));
  });
  it("labels previously selected items omitted without treating them as local deletions", () => {
    const manifest = fixture(), baseline = createPackageImportBaseline(manifest);
    manifest.definition.package.agents = manifest.definition.package.agents.filter(agent => agent.key === "scout");
    expect(comparePackageImport(manifest, baseline).changes).toEqual([{ category: "agent", key: "writer", change: "omitted" }]);
    expect(baseline.entries.some(entry => entry.key === "writer")).toBe(true);
  });
  it("does not invent comparisons for legacy or malformed snapshots", () => {
    const manifest = fixture(), baseline = createPackageImportBaseline(manifest);
    expect(comparePackageImport(manifest).status).toBe("new");
    expect(comparePackageImport(manifest, undefined, true)).toMatchObject({ status: "unavailable", changes: [] });
    for (const previous of [null, {}, { ...baseline, packageId: "other" }, { ...baseline, entries: [] }, { ...baseline, entries: [...baseline.entries, baseline.entries[0]] }, { ...baseline, entries: [{ category: "file", key: "../../private", sha256: "f".repeat(64) }, ...baseline.entries] }]) {
      expect(comparePackageImport(manifest, previous as PackageImportBaseline, true)).toMatchObject({ status: "unavailable", changes: [] });
    }
  });
});
