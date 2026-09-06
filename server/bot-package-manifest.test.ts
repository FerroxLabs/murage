import { describe, expect, it } from "vitest";
import { parseTeamManifest } from "./team-manifest.ts";
import { parseBotPackage } from "./bot-package.ts";
import { createBotPackageEntry, createBotPackageExportPreview, MAX_BOT_PACKAGE_COMPRESSION_RATIO, MAX_BOT_PACKAGE_ENTRIES, MAX_BOT_PACKAGE_EXPANDED_BYTES, normalizeBotPackagePath, parseBotPackageManifest } from "./bot-package-manifest.ts";

function fixture() {
  const payloads = new Map([
    ["bots/scout/SOUL.md", "Only the selected Scout instructions."],
    ["bots/writer/SOUL.md", "Writer instructions are private until selected."],
    ["skills/research/SKILL.md", "Research sources."],
    ["skills/facts/SKILL.md", "Check facts."],
  ]);
  const manifest = {
    format: "murage.package.bundle", version: 1,
    definition: { format: "murage.package", version: 1, package: {
      id: "sample", release: "1.0.0", name: "Sample", tagline: "Sample team", summary: "Definition only", category: "Community",
      author: { name: "Example" }, license: "Unspecified", outcomes: ["Research"], setupMinutes: 2, requirements: { apps: [], capabilities: [] },
      chiefOfStaff: "writer",
      agents: [
        { key: "scout", name: "Scout", appearance: { color: "green" }, skills: ["research"] },
        { key: "writer", name: "Writer", appearance: { color: "blue" } },
      ],
      routines: [{ key: "daily", name: "Daily", agent: "scout", prompt: "Research", runOn: "ember", schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 15, enabledAfterInstall: false }],
    } },
    skills: [
      { key: "research", name: "Research", license: "MIT", dependencies: ["facts"], files: ["skills/research/SKILL.md"] },
      { key: "facts", name: "Facts", license: "Apache-2.0", dependencies: [], files: ["skills/facts/SKILL.md"] },
    ],
    instructions: [{ agent: "scout", path: "bots/scout/SOUL.md" }, { agent: "writer", path: "bots/writer/SOUL.md" }],
    entries: [...payloads].map(([path, payload]) => createBotPackageEntry(path, payload)),
  };
  return { manifest, payloads };
}
describe("versioned portable manifest", () => {
  it("supports the bounded envelope without changing existing package/team readers", () => {
    const { manifest } = fixture();
    expect(parseBotPackageManifest(manifest).definition.package.agents).toHaveLength(2);
    expect(parseBotPackage(manifest.definition as any).version).toBe(1);
    for (const version of [1, 2]) {
      const legacy = { format: "murage.team", version, team: { name: "Old team", members: [{ key: "one", name: "One", appearance: { color: "green" } }], ...(version === 1 ? { room: { name: "Old room", defaultResponder: { kind: "everyone" } } } : {}) } };
      expect(parseTeamManifest(legacy as any).version).toBe(version);
    }
  });
  it("rejects versions, runtime fields, credentials and permission grants instead of passing them through", () => {
    const { manifest } = fixture();
    expect(() => parseBotPackageManifest({ ...manifest, version: 2 })).toThrow();
    expect(() => parseBotPackageManifest({ ...manifest, credentials: { token: "fake" } })).toThrow();
    for (const field of ["cwd", "autoApprove", "alwaysAllow", "modelSelection", "transcripts", "token"]) {
      const bad = structuredClone(manifest);
      Object.assign(bad.definition.package.agents[0]!, { [field]: "forbidden" });
      expect(() => parseBotPackageManifest(bad), field).toThrow(/Unsupported package definition field/u);
    }
  });
  it.each(["../outside", "/absolute", "C:/path", "a\\b", "a//b", "a/./b", "a/../b", "a\0b", "a/trailing.", "a/trailing ", "con", "aux.txt", "a/LPT1.txt", "cafe\u0301.md"])("rejects nonportable path %j", (path) => {
    expect(() => normalizeBotPackagePath(path)).toThrow(/path/u);
  });
  it("rejects case aliases including directory components and unreferenced payloads", () => {
    const { manifest } = fixture();
    const extra = createBotPackageEntry("skills/facts/skill.md", "duplicate");
    expect(() => parseBotPackageManifest({ ...manifest, entries: [...manifest.entries, extra] })).toThrow(/entry path/u);
    const directoryAlias = createBotPackageEntry("skills/facts/Sub/a", "a");
    const otherAlias = createBotPackageEntry("skills/facts/sub/b", "b");
    expect(() => parseBotPackageManifest({ ...manifest, entries: [...manifest.entries, directoryAlias, otherAlias] })).toThrow(/case collision/u);
    expect(() => parseBotPackageManifest({ ...manifest, entries: [...manifest.entries, createBotPackageEntry("private.txt", "unexpected")] })).toThrow(/unreferenced/u);
  });
  it("rejects bad references and archive metadata over the fixed bounds", () => {
    const { manifest } = fixture();
    const bad = structuredClone(manifest);
    bad.skills[0]!.dependencies = ["missing"];
    expect(() => parseBotPackageManifest(bad)).toThrow(/dependency/u);
    expect(() => parseBotPackageManifest({ ...manifest, entries: manifest.entries.map((entry, index) => index ? entry : { ...entry, bytes: MAX_BOT_PACKAGE_EXPANDED_BYTES }) })).toThrow(/expanded/u);
    expect(() => parseBotPackageManifest({ ...manifest, entries: Array.from({ length: MAX_BOT_PACKAGE_ENTRIES }, (_, index) => createBotPackageEntry(`files/${index}`, "")) })).toThrow(/too many/u);
    expect(MAX_BOT_PACKAGE_COMPRESSION_RATIO).toBe(100); // A policy constant, not archive proof.
  });
});

describe("pure selected export preview", () => {
  it("includes only selected bots, instructions and skills, leaves routines paused, and computes deterministic content hashes", () => {
    const { manifest, payloads } = fixture();
    const selection = { agents: ["scout"], skills: ["research", "facts"], routines: ["daily"], instructions: ["scout"] };
    const preview = createBotPackageExportPreview({ manifest, payloads, selection });
    expect(preview.missingDependencies).toEqual([]);
    expect(preview.requiresContentScan).toBe(true);
    expect(preview.manifest?.definition.package.agents.map((agent) => agent.key)).toEqual(["scout"]);
    expect(preview.manifest?.definition.package.routines?.[0]?.enabledAfterInstall).toBe(false);
    expect(preview.manifest?.definition.package.chiefOfStaff).toBeUndefined();
    expect(preview.manifest?.entries.map((entry) => entry.path)).toEqual(["bots/scout/SOUL.md", "skills/facts/SKILL.md", "skills/research/SKILL.md"]);
    expect(preview.omitted.instructions).toEqual(["writer"]);
    expect(createBotPackageExportPreview({ manifest, payloads: new Map([...payloads].reverse()), selection })).toEqual(preview);
    expect(createBotPackageEntry("x", "hello").sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
  it("reports missing dependencies without silently adding them or producing an exportable manifest", () => {
    const { manifest, payloads } = fixture();
    const preview = createBotPackageExportPreview({ manifest, payloads, selection: { agents: ["scout"], skills: ["research"], routines: [], instructions: [] } });
    expect(preview.manifest).toBeNull();
    expect(preview.missingDependencies).toEqual(["skill:facts"]);
    expect(preview.omitted.skills).toEqual(["facts"]);
  });
  it("refuses stale or absent selected payloads and unknown selection; unselected payloads are not read", () => {
    const { manifest, payloads } = fixture();
    const selection = { agents: ["writer"], skills: [], routines: [], instructions: ["writer"] };
    expect(() => createBotPackageExportPreview({ manifest, payloads: new Map(), selection })).toThrow(/missing/u);
    expect(() => createBotPackageExportPreview({ manifest, payloads: new Map([["bots/writer/SOUL.md", "changed"]]), selection })).toThrow(/integrity/u);
    expect(() => createBotPackageExportPreview({ manifest, payloads, selection: { ...selection, agents: ["unknown"] } })).toThrow(/Unknown/u);
    const selectedOnly = new Map([["bots/writer/SOUL.md", payloads.get("bots/writer/SOUL.md")!]]);
    expect(createBotPackageExportPreview({ manifest, payloads: selectedOnly, selection }).manifest?.entries).toHaveLength(1);
  });
});
