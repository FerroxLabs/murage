// Additive archive envelope around the existing Murage package v1 format.
// This is a pure manifest/selection boundary, not archive extraction or a
// content-safety verdict. Existing team/package readers remain unchanged.
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseBotPackage, type ParsedBotPackage } from "./bot-package.ts";

export const BOT_PACKAGE_BUNDLE_FORMAT = "murage.package.bundle" as const;
export const BOT_PACKAGE_BUNDLE_VERSION = 1 as const;
export const MAX_BOT_PACKAGE_ENTRIES = 1000;
export const MAX_BOT_PACKAGE_EXPANDED_BYTES = 50 * 1024 * 1024;
// Archive intake must enforce this against actual compressed/expanded bytes;
// a manifest cannot prove an archive's compression ratio.
export const MAX_BOT_PACKAGE_COMPRESSION_RATIO = 100;
const key = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u);
const text = (max: number) => z.string().trim().min(1).max(max);

/** Reject noncanonical paths rather than rewriting them into collisions. */
export function normalizeBotPackagePath(value: string): string {
  if (!value || value.length > 240 || value !== value.normalize("NFC") || /[\\\x00-\x1f\x7f:]/u.test(value)
    || value.startsWith("/") || value.endsWith("/")) throw new Error("Invalid package entry path");
  for (const segment of value.split("/")) {
    if (!segment || segment === "." || segment === ".." || /[. ]$/u.test(segment) || /[<>"|?*]/u.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) throw new Error("Invalid package entry path");
  }
  return value;
}
const pathSchema = z.string().transform((value, context) => {
  try { return normalizeBotPackagePath(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid package entry path" }); return z.NEVER; }
});
const entrySchema = z.object({ path: pathSchema, bytes: z.number().int().min(0).max(MAX_BOT_PACKAGE_EXPANDED_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const skillSchema = z.object({ key, name: text(100), license: text(200), dependencies: z.array(key).max(200), files: z.array(pathSchema).min(1).max(MAX_BOT_PACKAGE_ENTRIES) }).strict();
const instructionSchema = z.object({ agent: key, path: pathSchema }).strict();
const envelopeSchema = z.object({
  format: z.literal(BOT_PACKAGE_BUNDLE_FORMAT), version: z.literal(BOT_PACKAGE_BUNDLE_VERSION), definition: z.unknown(),
  skills: z.array(skillSchema).max(200), instructions: z.array(instructionSchema).max(200), entries: z.array(entrySchema).max(MAX_BOT_PACKAGE_ENTRIES),
}).strict();
export type BotPackageEntry = z.infer<typeof entrySchema>;
export interface BotPackageManifest extends Omit<z.infer<typeof envelopeSchema>, "definition"> { definition: ParsedBotPackage }
export interface BotPackageSelection { agents: string[]; skills: string[]; routines: string[]; instructions: string[] }

function unique(values: string[], label: string): Set<string> {
  const seen = new Set<string>();
  for (const value of values) { if (seen.has(value)) throw new Error(`Duplicate package ${label}`); seen.add(value); }
  return seen;
}
/** Legacy parsers intentionally strip unknown fields. New bundles reject
 * those fields so runtime state cannot silently masquerade as valid input. */
function rejectRemovedFields(input: unknown, parsed: unknown): void {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    input.forEach((value, index) => rejectRemovedFields(value, parsed[index]));
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    if (!parsed || typeof parsed !== "object") throw new Error("Unsupported package definition field");
    for (const name of Object.keys(input)) {
      if (!Object.hasOwn(parsed, name)) throw new Error("Unsupported package definition field");
      rejectRemovedFields((input as Record<string, unknown>)[name], (parsed as Record<string, unknown>)[name]);
    }
  }
}

export function parseBotPackageManifest(value: unknown): BotPackageManifest {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw new Error("Invalid package manifest"); }
  if (!serialized || Buffer.byteLength(serialized) > MAX_BOT_PACKAGE_EXPANDED_BYTES) throw new Error("Package manifest is too large");
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) throw new Error("Unsupported or malformed package manifest");
  const definition = parseBotPackage(parsed.data.definition as ParsedBotPackage);
  rejectRemovedFields(parsed.data.definition, definition);
  const result: BotPackageManifest = { ...parsed.data, definition };
  const agents = new Set(definition.package.agents.map((agent) => agent.key));
  const skills = unique(result.skills.map((skill) => skill.key), "skill key");
  const entries = unique(result.entries.map((entry) => entry.path.toLowerCase()), "entry path");
  const exactEntries = new Set(result.entries.map((entry) => entry.path));
  const referenced = new Set<string>();
  const pathComponents = new Map<string, string>();
  let expanded = Buffer.byteLength(serialized);
  // The reserved metadata entry also consumes archive entry/byte budget.
  if (result.entries.length + 1 > MAX_BOT_PACKAGE_ENTRIES) throw new Error("Package has too many entries");
  if (entries.has("manifest.json")) throw new Error("Package entry collides with manifest.json");
  for (const entry of result.entries) {
    expanded += entry.bytes;
    if (expanded > MAX_BOT_PACKAGE_EXPANDED_BYTES) throw new Error("Package expanded content is too large");
    const parts = entry.path.toLowerCase().split("/");
    const originalParts = entry.path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const folded = parts.slice(0, index).join("/");
      const original = originalParts.slice(0, index).join("/");
      if (pathComponents.has(folded) && pathComponents.get(folded) !== original) throw new Error("Package path case collision");
      pathComponents.set(folded, original);
    }
    for (let index = 1; index < parts.length; index++) if (entries.has(parts.slice(0, index).join("/"))) throw new Error("Package file/directory path collision");
  }
  unique(result.instructions.map((instruction) => instruction.agent), "instruction owner");
  for (const instruction of result.instructions) {
    if (!agents.has(instruction.agent) || instruction.path !== `bots/${instruction.agent}/SOUL.md` || !exactEntries.has(instruction.path)) throw new Error("Invalid package instruction reference");
    referenced.add(instruction.path);
  }
  for (const skill of result.skills) {
    unique(skill.dependencies, "skill dependency");
    unique(skill.files, "skill file");
    for (const dependency of skill.dependencies) if (dependency === skill.key || !skills.has(dependency)) throw new Error("Invalid package skill dependency");
    for (const file of skill.files) {
      if (!file.startsWith(`skills/${skill.key}/`) || !exactEntries.has(file)) throw new Error("Invalid package skill file reference");
      referenced.add(file);
    }
  }
  for (const agent of definition.package.agents) {
    unique(agent.skills ?? [], "agent skill reference");
    for (const skill of agent.skills ?? []) if (!skills.has(skill)) throw new Error("Unknown package agent skill");
  }
  if (referenced.size !== result.entries.length) throw new Error("Package contains unreferenced payloads");
  return result;
}

export function createBotPackageEntry(path: string, payload: string | Uint8Array): BotPackageEntry {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  if (bytes.length > MAX_BOT_PACKAGE_EXPANDED_BYTES) throw new Error("Package payload is too large");
  return { path: normalizeBotPackagePath(path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Select exactly requested content. Missing dependencies make the preview
 * non-exportable; they are reported, never auto-added or silently removed. */
export function createBotPackageExportPreview(input: {
  manifest: unknown; payloads: ReadonlyMap<string, string | Uint8Array>; selection: BotPackageSelection;
}): { manifest: BotPackageManifest | null; missingDependencies: string[]; omitted: BotPackageSelection; requiresContentScan: true } {
  const source = parseBotPackageManifest(input.manifest);
  const available: BotPackageSelection = {
    agents: source.definition.package.agents.map((agent) => agent.key), skills: source.skills.map((skill) => skill.key),
    routines: (source.definition.package.routines ?? []).map((routine) => routine.key), instructions: source.instructions.map((instruction) => instruction.agent),
  };
  const chosen = {} as Record<keyof BotPackageSelection, Set<string>>;
  const omitted = {} as BotPackageSelection;
  for (const category of ["agents", "skills", "routines", "instructions"] as const) {
    const values = input.selection[category];
    if (!Array.isArray(values)) throw new Error("Explicit package selection is required");
    chosen[category] = unique(values, "selection");
    if (values.some((value) => !available[category].includes(value))) throw new Error("Unknown package selection");
    omitted[category] = available[category].filter((value) => !chosen[category].has(value));
  }
  if (!chosen.agents.size) throw new Error("Select at least one package agent");
  const missing = new Set<string>();
  const agents = source.definition.package.agents.filter((agent) => chosen.agents.has(agent.key));
  const skills = source.skills.filter((skill) => chosen.skills.has(skill.key));
  const routines = (source.definition.package.routines ?? []).filter((routine) => chosen.routines.has(routine.key));
  const instructions = source.instructions.filter((instruction) => chosen.instructions.has(instruction.agent));
  for (const agent of agents) for (const dependency of agent.skills ?? []) if (!chosen.skills.has(dependency)) missing.add(`skill:${dependency}`);
  for (const skill of skills) for (const dependency of skill.dependencies) if (!chosen.skills.has(dependency)) missing.add(`skill:${dependency}`);
  for (const routine of routines) if (!chosen.agents.has(routine.agent)) missing.add(`agent:${routine.agent}`);
  for (const instruction of instructions) if (!chosen.agents.has(instruction.agent)) missing.add(`agent:${instruction.agent}`);
  if (missing.size) return { manifest: null, missingDependencies: [...missing].sort(), omitted, requiresContentScan: true };
  const paths = new Set([...skills.flatMap((skill) => skill.files), ...instructions.map((instruction) => instruction.path)]);
  const entries = source.entries.filter((entry) => paths.has(entry.path)).map((entry) => {
    const payload = input.payloads.get(entry.path);
    if (payload === undefined) throw new Error("Selected package payload is missing");
    const actual = createBotPackageEntry(entry.path, payload);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error("Selected package payload failed integrity verification");
    return actual;
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const playbookKeys = new Set(agents.flatMap((agent) => agent.playbooks ?? []));
  const pkg = source.definition.package;
  const definition: ParsedBotPackage = { ...source.definition, package: {
    ...pkg, agents, routines,
    playbooks: (pkg.playbooks ?? []).filter((playbook) => playbookKeys.has(playbook.key)),
    // Rooms carry only selected fresh members, never existing workspace IDs.
    rooms: (pkg.rooms ?? []).flatMap(room => {
      const members = room.members.filter(member => chosen.agents.has(member));
      if (!members.length) return [];
      const defaultResponder = room.defaultResponder.kind === "agent" && !members.includes(room.defaultResponder.agent)
        ? { kind: "mentions" as const } : room.defaultResponder;
      return [{ ...room, members, defaultResponder }];
    }),
    ...(pkg.chiefOfStaff && chosen.agents.has(pkg.chiefOfStaff) ? { chiefOfStaff: pkg.chiefOfStaff } : { chiefOfStaff: undefined }),
  } };
  return { manifest: parseBotPackageManifest({ format: BOT_PACKAGE_BUNDLE_FORMAT, version: BOT_PACKAGE_BUNDLE_VERSION, definition, skills, instructions, entries }), missingDependencies: [], omitted, requiresContentScan: true };
}
