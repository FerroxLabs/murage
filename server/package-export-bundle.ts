import { createHash } from "node:crypto";
import { createBotPackageExport, getBotPackageExportSelectionCandidates, type BotPackageExportInput, type BotPackageExportSelection } from "./package-export.ts";
import { BOT_PACKAGE_BUNDLE_FORMAT, BOT_PACKAGE_BUNDLE_VERSION, createBotPackageEntry, MAX_BOT_PACKAGE_ENTRIES, MAX_BOT_PACKAGE_EXPANDED_BYTES, normalizeBotPackagePath, parseBotPackageManifest, type BotPackageManifest } from "./bot-package-manifest.ts";
import { scanBotPackageContents } from "./bot-package-scan.ts";

export interface SelectedExportSkill {
  botId: string;
  key: string;
  name: string;
  license: string;
  /** Null means dependency metadata is unknown, not a verified empty graph. */
  dependencies: string[] | null;
  payloads: ReadonlyMap<string, Buffer>;
}
export interface BotPackageBundleInput {
  exportInput: BotPackageExportInput & { selection: BotPackageExportSelection };
  skills: readonly SelectedExportSkill[];
}

/** Assemble selected in-memory content only. No filesystem reads or writes.
 * The returned payload map is for the trusted archive writer, not the UI. */
export function createBotPackageExportBundle({ exportInput, skills }: BotPackageBundleInput) {
  if (!exportInput.selection) throw new Error("Explicit bundle selection is required");
  const definition = createBotPackageExport(exportInput);
  const candidates = getBotPackageExportSelectionCandidates(exportInput);
  const agentKeys = new Map(candidates.bots.map(bot => [bot.id, bot.key]));
  const selected = new Set(exportInput.selection.botIds);
  const payloads = new Map<string, Buffer>();
  const byKey = new Map<string, BotPackageManifest["skills"][number]>();
  const identities = new Map<string, string>();
  const assignments = new Map<string, Set<string>>();
  const warnings = new Set<string>();
  let bytes = 0;
  if (skills.length > MAX_BOT_PACKAGE_ENTRIES) throw new Error("Too many selected skill entries");
  for (const skill of skills) {
    if (!selected.has(skill.botId) || !agentKeys.has(skill.botId)) throw new Error("Selected skill belongs to an unselected bot");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skill.key)) throw new Error("Invalid selected skill key");
    if (skill.dependencies !== null && (!Array.isArray(skill.dependencies) || skill.dependencies.some(key => typeof key !== "string"))) throw new Error("Invalid skill dependency metadata");
    const dependencies = [...new Set(skill.dependencies ?? [])].sort();
    const files = [...skill.payloads.keys()].sort();
    if (!files.includes(`skills/${skill.key}/SKILL.md`)) throw new Error("Selected skill requires its SKILL.md file");
    const entries = files.map(path => {
      normalizeBotPackagePath(path);
      if (!path.startsWith(`skills/${skill.key}/`)) throw new Error("Selected skill file is outside its owned prefix");
      const payload = skill.payloads.get(path)!;
      if (!Buffer.isBuffer(payload)) throw new Error("Selected skill payload must be bytes");
      return createBotPackageEntry(path, payload);
    });
    const metadata = { key: skill.key, name: skill.name, license: skill.license, dependencies, files };
    const identity = JSON.stringify({ metadata, entries, dependenciesKnown: skill.dependencies !== null });
    if (identities.has(skill.key) && identities.get(skill.key) !== identity) throw new Error("Selected skills with the same key differ; resolve the conflict before exporting");
    if (!identities.has(skill.key)) {
      identities.set(skill.key, identity); byKey.set(skill.key, metadata);
      for (const entry of entries) {
        bytes += entry.bytes;
        if (payloads.size + 2 > MAX_BOT_PACKAGE_ENTRIES || bytes > MAX_BOT_PACKAGE_EXPANDED_BYTES) throw new Error("Selected package exceeds file or byte limits");
        payloads.set(entry.path, Buffer.from(skill.payloads.get(entry.path)!));
      }
    }
    if (skill.dependencies === null) warnings.add(`Dependency metadata is unknown for skill ${skill.key}; review its supporting files and requirements.`);
    const key = agentKeys.get(skill.botId)!;
    const assigned = assignments.get(key) ?? new Set<string>(); assigned.add(skill.key); assignments.set(key, assigned);
  }
  for (const skill of byKey.values()) for (const dependency of skill.dependencies) {
    if (!byKey.has(dependency)) throw new Error("A selected skill dependency is missing from the explicit selection");
  }
  for (const agent of definition.package.agents) {
    const assigned = assignments.get(agent.key);
    if (assigned?.size) agent.skills = [...assigned].sort();
  }
  const sortedPayloads = new Map([...payloads].sort(([left], [right]) => left.localeCompare(right)));
  const manifest = parseBotPackageManifest({ format: BOT_PACKAGE_BUNDLE_FORMAT, version: BOT_PACKAGE_BUNDLE_VERSION,
    definition, skills: [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key)), instructions: [],
    entries: [...sortedPayloads].map(([path, payload]) => createBotPackageEntry(path, payload)),
  });
  const manifestContent = JSON.stringify(manifest);
  const scan = scanBotPackageContents([{ path: "manifest.json", content: manifestContent }, ...[...sortedPayloads].map(([path, content]) => ({ path, content }))]);
  const reviewWarnings = [...warnings].sort();
  const canonicalSelection = { botIds: [...exportInput.selection.botIds].sort(), playbookKeys: [...exportInput.selection.playbookKeys].sort(), routineIds: [...exportInput.selection.routineIds].sort() };
  const previewHash = createHash("sha256").update(JSON.stringify({ manifest, selection: canonicalSelection, reviewWarnings, scan })).digest("hex");
  const files = [{ ...createBotPackageEntry("manifest.json", manifestContent), ...(!scan.blocked ? { content: manifestContent } : {}) },
    ...manifest.entries.map(entry => ({ ...entry, ...(!scan.blocked ? { content: sortedPayloads.get(entry.path)!.toString("utf8") } : {}) }))];
  return { manifest, payloads: sortedPayloads, scan, previewHash, files,
    summary: { agents: definition.package.agents.length, skills: manifest.skills.length, playbooks: definition.package.playbooks?.length ?? 0, routines: definition.package.routines?.length ?? 0, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
    reviewWarnings };
}
