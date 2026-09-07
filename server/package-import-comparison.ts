import { createHash } from "node:crypto";
import { MAX_BOT_PACKAGE_ENTRIES, normalizeBotPackagePath, parseBotPackageManifest, type BotPackageManifest } from "./bot-package-manifest.ts";

const CATEGORIES = ["agent", "playbook", "routine", "skill", "instruction", "file", "requirements", "chief-suggestion"] as const;
type Category = typeof CATEGORIES[number];
export interface PackageImportBaseline {
  packageId: string;
  release: string;
  entries: Array<{ category: Category; key: string; sha256: string }>;
}
export interface PackageImportComparison {
  status: "new" | "compared" | "unavailable";
  incomingRelease: string;
  previousRelease?: string;
  /** Omitted means absent from this selection, never deletion of local work. */
  changes: Array<{ category: Category; key: string; change: "added" | "changed" | "omitted" }>;
}
// A valid manifest has at most 1000 files plus bounded metadata collections.
const MAX_BASELINE_ENTRIES = 2 * MAX_BOT_PACKAGE_ENTRIES;
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized).sort((a, b) => lexical(JSON.stringify(a), JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => lexical(a, b)).map(([key, item]) => [key, normalized(item)]));
  return value;
}
const lexical = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const identity = (entry: { category: Category; key: string }) => `${entry.category}:${entry.key}`;

/** Snapshot only portable selected definitions, never a bot's runtime state. */
export function createPackageImportBaseline(input: BotPackageManifest): PackageImportBaseline {
  const manifest = parseBotPackageManifest(input);
  const pkg = manifest.definition.package;
  const entries: PackageImportBaseline["entries"] = [];
  const files = new Map(manifest.entries.map(entry => [entry.path, entry]));
  const add = (category: Category, key: string, value: unknown) => {
    if (entries.length >= MAX_BASELINE_ENTRIES) throw new Error("Package comparison exceeds its entry limit");
    entries.push({ category, key, sha256: createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex") });
  };
  pkg.agents.forEach(agent => add("agent", agent.key, agent));
  pkg.playbooks?.forEach(playbook => add("playbook", playbook.key, playbook));
  pkg.routines?.forEach(routine => add("routine", routine.key, routine));
  manifest.skills.forEach(skill => add("skill", skill.key, { ...skill, fileEntries: skill.files.map(path => files.get(path)) }));
  manifest.instructions.forEach(instruction => add("instruction", instruction.agent, { ...instruction, fileEntry: files.get(instruction.path) }));
  manifest.entries.forEach(entry => add("file", entry.path, entry));
  add("requirements", "package", pkg.requirements);
  add("chief-suggestion", "package", pkg.chiefOfStaff ?? null);
  entries.sort((a, b) => lexical(identity(a), identity(b)));
  return { packageId: pkg.id, release: pkg.release, entries };
}

function validBaseline(value: unknown, packageId: string): value is PackageImportBaseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const baseline = value as Partial<PackageImportBaseline>;
  if (Object.keys(value).some(key => !["packageId", "release", "entries"].includes(key)) || baseline.packageId !== packageId
    || typeof baseline.release !== "string" || baseline.release.length > 30 || !/^\d+\.\d+\.\d+$/.test(baseline.release)
    || !Array.isArray(baseline.entries) || baseline.entries.length < 3 || baseline.entries.length > MAX_BASELINE_ENTRIES) return false;
  const seen = new Set<string>();
  for (const entry of baseline.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some(key => !["category", "key", "sha256"].includes(key))
      || !CATEGORIES.includes(entry.category) || typeof entry.key !== "string" || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) return false;
    if (entry.category === "file") {
      try { normalizeBotPackagePath(entry.key); } catch { return false; }
    } else if (["requirements", "chief-suggestion"].includes(entry.category)) {
      if (entry.key !== "package") return false;
    } else if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.key)) return false;
    const id = identity(entry);
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return seen.has("requirements:package") && seen.has("chief-suggestion:package") && baseline.entries.some(entry => entry.category === "agent");
}

export function comparePackageImport(manifest: BotPackageManifest, previous?: PackageImportBaseline, existingPackage = false): PackageImportComparison {
  const incoming = createPackageImportBaseline(manifest);
  if (previous === undefined && !existingPackage) return { status: "new", incomingRelease: incoming.release, changes: incoming.entries.map(({ category, key }) => ({ category, key, change: "added" })) };
  if (!validBaseline(previous, incoming.packageId)) return { status: "unavailable", incomingRelease: incoming.release, changes: [] };
  const before = new Map(previous.entries.map(entry => [identity(entry), entry]));
  const after = new Set(incoming.entries.map(identity));
  const changes: PackageImportComparison["changes"] = [];
  for (const entry of incoming.entries) {
    const prior = before.get(identity(entry));
    if (!prior || prior.sha256 !== entry.sha256) changes.push({ category: entry.category, key: entry.key, change: prior ? "changed" : "added" });
  }
  for (const entry of previous.entries) if (!after.has(identity(entry))) changes.push({ category: entry.category, key: entry.key, change: "omitted" });
  changes.sort((a, b) => lexical(identity(a), identity(b)));
  return { status: "compared", incomingRelease: incoming.release, previousRelease: previous.release, changes };
}
