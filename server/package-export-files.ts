import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { MAX_BOT_PACKAGE_ENTRIES, MAX_BOT_PACKAGE_EXPANDED_BYTES, normalizeBotPackagePath } from "./bot-package-manifest.ts";

export interface PackageExportSkillSource { directory: string; expectedSkillSha256?: string }
export class PackageExportFilesError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Selected skill export refused (${code}).`); this.code = code; }
}
function fail(code: string): never { throw new PackageExportFilesError(code); }
const skillName = (name: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64;
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function directory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_SKILL_SOURCE");
  return stat;
}
function roots(workspaceRoot: string) {
  directory(workspaceRoot);
  const workspace = realpathSync(workspaceRoot), skills = join(workspace, "skills");
  directory(skills);
  return { workspace, skills };
}
function sourcePath(skills: string, name: string, sources?: ReadonlyMap<string, PackageExportSkillSource>) {
  if (!skillName(name)) fail("INVALID_SKILL_SELECTION");
  const source = sources?.get(name);
  if (sources && !source) fail("UNKNOWN_SKILL_SELECTION");
  const path = source ? resolve(source.directory) : join(skills, name);
  const rel = relative(skills, path).replaceAll("\\", "/");
  if (rel !== name && !/^\.revisions\/[a-f0-9]{64}$/.test(rel)) fail("UNSAFE_SKILL_SOURCE");
  if (rel.startsWith(".revisions/")) directory(join(skills, ".revisions"));
  directory(path);
  return { path, expected: source?.expectedSkillSha256 };
}
function guarded<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { throw error instanceof PackageExportFilesError ? error : new PackageExportFilesError("SKILL_SOURCE_UNREADABLE"); }
}

/** No file content is read while enumerating candidates. Installed callers
 * provide protected manifest sources so reviewed revisions are named correctly. */
export function listPackageExportSkillCandidates(workspaceRoot: string, sources?: ReadonlyMap<string, PackageExportSkillSource>) {
  return guarded(() => {
    const { skills } = roots(workspaceRoot);
    const names = sources ? [...sources.keys()] : readdirSync(skills).filter(skillName);
    if (names.length > MAX_BOT_PACKAGE_ENTRIES) fail("SKILL_EXPORT_LIMIT");
    return names.sort().map(name => { sourcePath(skills, name, sources); return { key: name, name }; });
  });
}

/** Collect only explicitly selected trees. Code/reference files remain inert
 * bytes for the upstream scan and human review; nothing is executed or fetched. */
export function collectPackageExportSkills(workspaceRoot: string, selectedSkillNames: readonly string[], sources?: ReadonlyMap<string, PackageExportSkillSource>) {
  return guarded(() => {
    if (!Array.isArray(selectedSkillNames) || selectedSkillNames.length > MAX_BOT_PACKAGE_ENTRIES || new Set(selectedSkillNames).size !== selectedSkillNames.length || selectedSkillNames.some(name => typeof name !== "string" || !skillName(name))) fail("INVALID_SKILL_SELECTION");
    const payloads = new Map<string, Buffer>();
    const metadata: Array<{ key: string; name: string; license: string; dependencies: string[]; dependencyStatus: "unverified"; files: string[] }> = [];
    const warnings = selectedSkillNames.length ? ["Skill dependencies are unverified. Review the included SKILL.md, scripts and references; no dependencies were inferred or fetched."] : [];
    if (!selectedSkillNames.length) return { payloads, skills: metadata, warnings };
    const { workspace, skills } = roots(workspaceRoot);
    const observed = new Map<string, Stats>([[workspace, directory(workspace)], [skills, directory(skills)]]);
    let bytes = 0, count = 1; // Reserve the bundle manifest entry.
    const copy = (absolute: string, path: string, depth = 0) => {
      if (++count > MAX_BOT_PACKAGE_ENTRIES || depth > 64) fail("SKILL_EXPORT_LIMIT");
      try { normalizeBotPackagePath(path); } catch { fail("UNSAFE_SKILL_SOURCE"); }
      const before = lstatSync(absolute); observed.set(absolute, before);
      if (before.isSymbolicLink()) fail("UNSAFE_SKILL_SOURCE");
      if (before.isDirectory()) {
        const folded = new Set<string>();
        for (const name of readdirSync(absolute).sort()) {
          if (folded.has(name.toLowerCase())) fail("UNSAFE_SKILL_SOURCE");
          folded.add(name.toLowerCase()); copy(join(absolute, name), `${path}/${name}`, depth + 1);
        }
        return;
      }
      if (!before.isFile() || before.nlink !== 1) fail("UNSAFE_SKILL_SOURCE");
      if (before.size > MAX_BOT_PACKAGE_EXPANDED_BYTES - bytes) fail("SKILL_EXPORT_LIMIT");
      const fd = openSync(absolute, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      try {
        if (!same(before, fstatSync(fd))) fail("SKILL_SOURCE_CHANGED");
        const content = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < content.length) {
          const length = readSync(fd, content, offset, Math.min(64 * 1024, content.length - offset), null);
          if (!length) fail("SKILL_SOURCE_CHANGED");
          offset += length;
        }
        if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || !same(before, fstatSync(fd)) || !same(before, lstatSync(absolute))) fail("SKILL_SOURCE_CHANGED");
        bytes += content.length; payloads.set(path, content);
      } finally { closeSync(fd); }
    };
    for (const name of selectedSkillNames) {
      const source = sourcePath(skills, name, sources);
      if (source.path.includes(`${join(skills, ".revisions")}/`)) observed.set(join(skills, ".revisions"), directory(join(skills, ".revisions")));
      copy(source.path, `skills/${name}`);
      const skill = payloads.get(`skills/${name}/SKILL.md`);
      if (!skill) fail("SKILL_METADATA_INVALID");
      if (source.expected && createHash("sha256").update(skill).digest("hex") !== source.expected) fail("SKILL_SOURCE_CHANGED");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(skill);
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match || Buffer.byteLength(match[1]) > 64 * 1024) fail("SKILL_METADATA_INVALID");
      const document = parseDocument(match[1]);
      if (document.errors.length) fail("SKILL_METADATA_INVALID");
      const fields = document.toJS({ maxAliasCount: 0 });
      if (!fields || typeof fields !== "object" || fields.name !== name || typeof fields.description !== "string" || !fields.description.trim()) fail("SKILL_METADATA_INVALID");
      if (fields.license !== undefined && (typeof fields.license !== "string" || fields.license.trim().length > 200)) fail("SKILL_METADATA_INVALID");
      metadata.push({ key: name, name, license: typeof fields.license === "string" && fields.license.trim() ? fields.license.replace(/\s+/g, " ").trim() : "Unspecified", dependencies: [], dependencyStatus: "unverified", files: [...payloads.keys()].filter(path => path.startsWith(`skills/${name}/`)) });
    }
    for (const [path, before] of observed) if (!same(before, lstatSync(path))) fail("SKILL_SOURCE_CHANGED");
    return { payloads, skills: metadata, warnings };
  });
}
