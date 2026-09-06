// Caller-owned atomic commit is mandatory: createBot is not a transaction.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBotPackageArchive } from "./bot-package-archive.ts";
import { createBotPackageExportPreview, MAX_BOT_PACKAGE_ENTRIES, MAX_BOT_PACKAGE_EXPANDED_BYTES, normalizeBotPackagePath, parseBotPackageManifest, type BotPackageSelection } from "./bot-package-manifest.ts";
import { scanBotPackageContents } from "./bot-package-scan.ts";
import { packageAgentAsMember } from "./bot-package.ts";
import { importedMemberProfile } from "./team-manifest.ts";
import { isSkillName, parseSkillMd } from "./skills.ts";
import type { ModelSelection } from "./contracts.ts";
import type { BotRecord, GroupRecord } from "./store.ts";
import type { Routine } from "./routines.ts";
import { comparePackageImport, createPackageImportBaseline } from "./package-import-comparison.ts";

export class BotPackageImportError extends Error {
  readonly code: string;
  constructor(code: string) { super("Package import refused (" + code + ")."); this.code = code; }
}
function fail(code: string): never { throw new BotPackageImportError(code); }
type Intake = Awaited<ReturnType<typeof readBotPackageArchive>>;
export interface BotPackageContents { manifest: unknown; payloads: ReadonlyMap<string, Buffer> }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
function readContents(contents: BotPackageContents, signal?: AbortSignal): Intake {
  if (signal?.aborted) fail("PACKAGE_IMPORT_CANCELLED");
  const manifest = parseBotPackageManifest(contents.manifest);
  if (contents.payloads.size + 1 > MAX_BOT_PACKAGE_ENTRIES || contents.payloads.size !== manifest.entries.length) fail("PACKAGE_CONTENT_ENTRY_MISMATCH");
  const encoded = canonical(manifest);
  let expanded = Buffer.byteLength(encoded);
  if (expanded > MAX_BOT_PACKAGE_EXPANDED_BYTES) fail("PACKAGE_CONTENT_LIMIT");
  const payloads = new Map<string, Buffer>();
  const actualEntries: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const entry of [...manifest.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (signal?.aborted) fail("PACKAGE_IMPORT_CANCELLED");
    const bytes = contents.payloads.get(entry.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== entry.bytes) fail("PACKAGE_CONTENT_ENTRY_MISMATCH");
    expanded += bytes.length;
    if (expanded > MAX_BOT_PACKAGE_EXPANDED_BYTES) fail("PACKAGE_CONTENT_LIMIT");
    const digest = hash(bytes);
    if (digest !== entry.sha256) fail("PACKAGE_CONTENT_HASH_MISMATCH");
    actualEntries.push({ path: entry.path, bytes: bytes.length, sha256: digest });
    payloads.set(entry.path, Buffer.from(bytes));
  }
  const scan = scanBotPackageContents([{ path: "manifest.json", content: encoded }, ...[...payloads].map(([path, content]) => ({ path, content }))]);
  return { manifest, payloads, scan, sha256: hash(canonical({ format: "murage.package.contents-digest", version: 1, manifest, entries: actualEntries })) };
}
function selectionSnapshot(selection: BotPackageSelection): BotPackageSelection {
  if (!selection || typeof selection !== "object") fail("EXPLICIT_SELECTION_REQUIRED");
  const copied = {} as BotPackageSelection;
  for (const field of ["agents", "skills", "routines", "instructions"] as const) {
    const list = selection[field];
    if (!Array.isArray(list) || list.some((value) => typeof value !== "string") || new Set(list).size !== list.length) fail("INVALID_SELECTION");
    copied[field] = [...list].sort();
  }
  if (Object.keys(selection).some((field) => !Object.hasOwn(copied, field))) fail("INVALID_SELECTION");
  return copied;
}
export function packageImportSelectionHash(selection: BotPackageSelection): string {
  return hash(JSON.stringify(selectionSnapshot(selection)));
}
type ImportHistoryBot = Pick<BotRecord, "id" | "threadId" | "name"> & Partial<Pick<BotRecord, "installedPackage" | "packageImportReceipt" | "createdAt">>;
function inspect(intake: Intake, selection: BotPackageSelection, existingBots: readonly ImportHistoryBot[] = []) {
  const chosen = createBotPackageExportPreview({ manifest: intake.manifest, payloads: intake.payloads, selection });
  const selected = chosen.manifest;
  const summary = selected ? {
    name: intake.scan.blocked ? "Blocked package" : selected.definition.package.name, agents: selected.definition.package.agents.length,
    routines: selected.definition.package.routines?.length ?? 0,
    skills: selected.skills.length, instructions: selected.instructions.length,
    suggestedChief: intake.scan.blocked ? null : selected.definition.package.chiefOfStaff ?? null,
    importedChiefRole: false as const, skillsInitiallyEnabled: false as const,
  } : null;
  const previous = existingBots.filter(bot => bot.installedPackage?.id === selected?.definition.package.id)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id));
  const latest = previous[0];
  // A receipt group has one baseline owner to avoid duplicating its hashes
  // for every bot. Deleted/legacy owners produce an explicit unavailable result.
  const baselineOwner = latest?.packageImportReceipt
    ? previous.find(bot => bot.packageImportReceipt?.importId === latest.packageImportReceipt?.importId && bot.packageImportReceipt?.baseline)
    : undefined;
  const comparison = selected && !intake.scan.blocked
    ? comparePackageImport(selected, baselineOwner?.packageImportReceipt?.baseline, previous.length > 0) : undefined;
  const reviewHash = hash(JSON.stringify({ version: 2, archiveSha256: intake.sha256, selection, scan: intake.scan, summary, missingDependencies: chosen.missingDependencies, comparison }));
  return { archiveSha256: intake.sha256, reviewHash, selectionHash: packageImportSelectionHash(selection), scan: intake.scan, summary, missingDependencies: chosen.missingDependencies, comparison, selected };
}

/** No payload text in preview; review binds archive bytes and selection. */
export async function previewBotPackageImport(archivePath: string, options: { selection: BotPackageSelection; existingBots?: readonly ImportHistoryBot[]; signal?: AbortSignal }) {
  const selection = selectionSnapshot(options.selection);
  const intake = await readBotPackageArchive(archivePath, { signal: options.signal });
  const { selected: _selected, ...preview } = inspect(intake, selection, options.existingBots);
  return preview;
}

export async function previewBotPackageContents(contents: BotPackageContents, options: { selection: BotPackageSelection; existingBots?: readonly ImportHistoryBot[]; signal?: AbortSignal }) {
  const selection = selectionSnapshot(options.selection);
  const intake = readContents(contents, options.signal);
  const { selected: _selected, ...preview } = inspect(intake, selection, options.existingBots);
  return preview;
}
export interface PreparedBotPackageImport {
  id: string; archiveSha256: string; reviewHash: string;
  selectionHash: string;
  bots: BotRecord[]; groups: GroupRecord[]; routines: Routine[];
  files: Array<{ path: string; content: Buffer }>;
  baseline: ReturnType<typeof createPackageImportBaseline>;
}
export interface BotPackageAtomicCommitInput { prepared: PreparedBotPackageImport; stagingDirectory: string }
/** Not an existing Store API. Caller validates fresh IDs, atomically promotes
 * files/records/routines, emits after success and rolls back before throwing. */
export type BotPackageAtomicCommit = (input: BotPackageAtomicCommitInput) => void;

function prepare(intake: Intake, inspected: ReturnType<typeof inspect>, options: {
  existingBots: readonly Pick<BotRecord, "id" | "threadId" | "name">[]; modelSelection: ModelSelection;
}): PreparedBotPackageImport {
  const manifest = inspected.selected;
  if (!manifest) fail("MISSING_SELECTED_DEPENDENCY");
  const at = Date.now();
  const takenNames = new Set(options.existingBots.map((bot) => bot.name.trim().toLowerCase()));
  const takenIds = new Set(options.existingBots.flatMap((bot) => [bot.id, bot.threadId]));
  const freshId = () => { let id: string; do { id = randomUUID(); } while (takenIds.has(id)); takenIds.add(id); return id; };
  const result: PreparedBotPackageImport = { id: randomUUID(), archiveSha256: intake.sha256, reviewHash: inspected.reviewHash,
    selectionHash: inspected.selectionHash,
    bots: [], groups: [], routines: [], files: [], baseline: createPackageImportBaseline(manifest) };
  const ids = new Map<string, string>();
  const pkg = manifest.definition.package;
  const skillsByKey = new Map(manifest.skills.map((skill) => [skill.key, skill]));
  const instructionsByAgent = new Map(manifest.instructions.map((entry) => [entry.agent, entry.path]));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const payload = (path: string) => { const content = intake.payloads.get(path); if (!content) fail("MISSING_PACKAGE_PAYLOAD"); return content; };
  let stagedBytes = 0;
  const allAssigned = new Set<string>();
  const addFile = (path: string, content: Uint8Array | string) => {
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    stagedBytes += bytes.length;
    // Shared skills copied to many bots still count against actual staged
    // bytes/files, not merely their one occurrence in the source ZIP.
    if (stagedBytes > MAX_BOT_PACKAGE_EXPANDED_BYTES || result.files.length + 3 >= MAX_BOT_PACKAGE_ENTRIES) fail("PACKAGE_STAGING_LIMIT");
    result.files.push({ path: normalizeBotPackagePath(path), content: bytes });
  };
  for (const agent of pkg.agents) {
    const id = freshId(), threadId = freshId();
    const profile = importedMemberProfile(packageAgentAsMember(agent), takenNames);
    const instructionPath = instructionsByAgent.get(agent.key);
    if (instructionPath) {
      const bytes = payload(instructionPath);
      const instructions = decoder.decode(bytes);
      // Approved SOUL adapter uses existing description; never truncate.
      if (instructions.length > 4000 || instructions.includes("\0")) fail("SOUL_INSTRUCTIONS_EXCEED_PROFILE_LIMIT");
      profile.description = instructions;
      addFile("workspaces/" + id + "/SOUL.md", bytes);
    }
    const playbooks = (pkg.playbooks ?? []).filter((playbook) => agent.playbooks?.includes(playbook.key));
    const bot: BotRecord = {
      id, threadId, ...profile, notifications: false, unread: false,
      modelSelection: structuredClone(options.modelSelection), resumeCursors: {}, createdAt: at,
      tasks: [{ threadId, title: "New task", createdAt: at, resumeCursors: {} }],
      composio: false, computer: "off", browser: false, autoApprove: false, chiefOfStaff: false,
      ...(playbooks.length ? { playbooks: structuredClone(playbooks) } : {}),
      installedPackage: { id: pkg.id, name: pkg.name, release: pkg.release, requiredApps: pkg.requirements.apps.map((app) => ({ ...app })) },
    };
    result.bots.push(bot); ids.set(agent.key, id);
    const assigned = new Set<string>();
    const collect = (skillKey: string) => {
      if (assigned.has(skillKey)) return;
      assigned.add(skillKey);
      const skill = skillsByKey.get(skillKey);
      if (!skill) fail("MISSING_SELECTED_DEPENDENCY");
      skill.dependencies.forEach(collect);
    };
    (agent.skills ?? []).forEach(collect);
    const skillState: Record<string, unknown> = {};
    for (const skillKey of [...assigned].sort()) {
      allAssigned.add(skillKey);
      const skill = skillsByKey.get(skillKey)!;
      if (!isSkillName(skillKey)) fail("UNSUPPORTED_SKILL_NAME");
      const markdownPath = "skills/" + skillKey + "/SKILL.md";
      if (!skill.files.includes(markdownPath)) fail("SKILL_MARKDOWN_REQUIRED");
      const markdown = decoder.decode(payload(markdownPath));
      const parsed = parseSkillMd(markdown);
      if ("error" in parsed || parsed.name !== skillKey) fail("INVALID_SKILL_METADATA");
      if (parsed.license && parsed.license !== skill.license) fail("SKILL_LICENSE_MISMATCH");
      for (const path of skill.files) addFile("workspaces/" + id + "/" + path, payload(path));
      skillState[skillKey] = {
        description: parsed.description, enabled: false, source: "package:" + pkg.id + "@" + pkg.release,
        sha256: hash(payload(markdownPath)), importedAt: new Date(at).toISOString(),
        license: skill.license, warnings: [], skippedFiles: [],
      };
    }
    if (assigned.size) addFile("skill-state/" + id + "/skills.json", JSON.stringify(skillState, null, 2) + "\n");
  }
  for (const routine of pkg.routines ?? []) {
    const botId = ids.get(routine.agent);
    if (!botId) fail("MISSING_ROUTINE_OWNER");
    result.routines.push({
      id: freshId(), name: routine.name, prompt: routine.prompt, target: "bot", botId,
      runOn: routine.runOn, enabled: false, schedule: structuredClone(routine.schedule),
      durationMinutes: routine.durationMinutes,
      ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
      nextRunAt: null, createdAt: at, updatedAt: at,
    });
  }
  if (manifest.skills.some((skill) => !allAssigned.has(skill.key))) fail("UNASSIGNED_SELECTED_SKILL");
  return result;
}

/** Recheck reviewed bytes; stage only inert files owned by fresh identities.
 * No dependency fetch, link synchronization, skill enablement or hook runs. */
interface ImportOptions {
  dataDir: string; selection: BotPackageSelection;
  expectedArchiveSha256: string; expectedReviewHash: string; acknowledgeWarnings?: boolean;
  existingBots: readonly ImportHistoryBot[]; modelSelection: ModelSelection;
  atomicCommit: BotPackageAtomicCommit; signal?: AbortSignal;
}
async function importIntake(options: ImportOptions, load: () => Promise<Intake>) {
  const selection = selectionSnapshot(options.selection);
  const existingBots = options.existingBots.map((bot) => ({ id: bot.id, threadId: bot.threadId, name: bot.name,
    createdAt: bot.createdAt, installedPackage: bot.installedPackage && structuredClone(bot.installedPackage),
    packageImportReceipt: bot.packageImportReceipt && structuredClone(bot.packageImportReceipt) }));
  const modelSelection = structuredClone(options.modelSelection);
  const intake = await load();
  const inspected = inspect(intake, selection, existingBots);
  if (intake.sha256 !== options.expectedArchiveSha256 || inspected.reviewHash !== options.expectedReviewHash) fail("PACKAGE_REVIEW_CHANGED");
  if (inspected.scan.blocked) fail("PACKAGE_CONTENT_BLOCKED");
  if (inspected.scan.reviewRequired && options.acknowledgeWarnings !== true) fail("PACKAGE_REVIEW_REQUIRED");
  const prepared = prepare(intake, inspected, { existingBots, modelSelection });
  const root = lstatSync(options.dataDir);
  if (!root.isDirectory() || root.isSymbolicLink()) fail("UNSAFE_IMPORT_DIRECTORY");
  const stagingDirectory = mkdtempSync(join(options.dataDir, ".package-import-"));
  try {
    for (const file of prepared.files) {
      if (options.signal?.aborted) fail("PACKAGE_IMPORT_CANCELLED");
      const path = join(stagingDirectory, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.content, { flag: "wx", mode: 0o600 });
    }
    if (options.signal?.aborted) fail("PACKAGE_IMPORT_CANCELLED");
    options.atomicCommit({ prepared, stagingDirectory });
    return { id: prepared.id, archiveSha256: prepared.archiveSha256, reviewHash: prepared.reviewHash, bots: prepared.bots, groups: prepared.groups, routines: prepared.routines };
  } finally { rmSync(stagingDirectory, { recursive: true, force: true }); }
}

export async function importBotPackageArchive(options: ImportOptions & { archivePath: string }) {
  return importIntake(options, () => readBotPackageArchive(options.archivePath, { signal: options.signal }));
}

export async function importBotPackageContents(options: ImportOptions & { contents: BotPackageContents }) {
  return importIntake(options, async () => readContents(options.contents, options.signal));
}
