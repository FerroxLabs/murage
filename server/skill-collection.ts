// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's own skills: imported once from a file, folder, zip or link,
// scanned by Skill Guard, and switched on per bot from Settings → Skills.
//
// DATA_DIR/skill-collection/<name>/ holds a skill's files and
// DATA_DIR/skill-collection/collection.json the records. An import is written
// into a private .incoming-<uuid> folder and renamed into place, so a half
// written skill is never listed.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { isSkillName, parseSkillMd } from "./skills.ts";
import { scanSkill } from "./skill-guard/scan.ts";
import type { SkillScan } from "./skill-guard/types.ts";

export const MAX_SKILL_FILES = 30;
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 2 * 1024 * 1024;

export type SkillSourceKind = "file" | "folder" | "zip" | "link";
export interface CollectionSkill {
  name: string;
  description: string;
  source: { kind: SkillSourceKind; label: string };
  importedAt: string;
  /** Paths of the files kept, SKILL.md first. */
  files: string[];
  /** Files that were not text and so were not kept. */
  skipped: string[];
  scan: SkillScan;
}
type SkillFile = { path: string; content: string };
type Refusal = { error: string; code: "invalid" | "too-big" };

const root = () => join(DATA_DIR, "skill-collection");
const recordsPath = () => join(root(), "collection.json");

function readRecords(): Record<string, CollectionSkill> {
  try {
    const parsed = JSON.parse(readFileSync(recordsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRecords(records: Record<string, CollectionSkill>): void {
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  const temp = join(root(), `.collection-${randomUUID()}.json`);
  writeFileSync(temp, `${JSON.stringify(records, null, 1)}\n`, { mode: 0o600 });
  renameSync(temp, recordsPath());
}

/** A relative path inside the skill, or null when it tries to leave it. */
function safeRelative(path: string): string | null {
  const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) return null;
  const parts = clean.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "" || /[\0<>:"|?*]/.test(part))) return null;
  return parts.join("/");
}

/** Finds the shallowest SKILL.md, re-roots every path at its folder (drops
 *  files outside it), and enforces the bounds. */
export function normalizeSkillFiles(input: SkillFile[]): { files: SkillFile[] } | Refusal {
  const files: SkillFile[] = [];
  for (const file of input) {
    const path = safeRelative(file.path);
    if (path === null) return { error: `"${file.path}" is not a path inside the skill.`, code: "invalid" };
    files.push({ path, content: file.content });
  }
  const skillFiles = files.filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
  if (!skillFiles.length) return { error: "That doesn't contain a skill. A skill is a folder with a SKILL.md file in it.", code: "invalid" };
  const main = skillFiles.sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0]!;
  const prefix = main.path.slice(0, -"SKILL.md".length);
  const kept = files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ path: file.path.slice(prefix.length), content: file.content }));
  if (kept.length > MAX_SKILL_FILES) return { error: `This skill is too big to import (over ${MAX_SKILL_FILES} files).`, code: "too-big" };
  let total = 0;
  for (const file of kept) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (bytes > MAX_SKILL_FILE_BYTES) return { error: `This skill is too big to import (${file.path} is over 256 KB).`, code: "too-big" };
  }
  if (total > MAX_SKILL_TOTAL_BYTES) return { error: "This skill is too big to import (over 2 MB in all).", code: "too-big" };
  kept.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : 1));
  return { files: kept };
}

export function listCollection(): CollectionSkill[] {
  return Object.values(readRecords()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getCollectionSkill(name: string): (CollectionSkill & { text: string; contents: SkillFile[] }) | null {
  if (!isSkillName(name)) return null;
  const record = readRecords()[name];
  if (!record) return null;
  const contents: SkillFile[] = [];
  for (const path of record.files) {
    const relative = safeRelative(path);
    if (!relative) continue;
    try {
      contents.push({ path: relative, content: readFileSync(join(root(), name, relative), "utf8") });
    } catch {
      // a file removed by hand: the rest still reads
    }
  }
  const text = contents.find((file) => file.path === "SKILL.md")?.content;
  return text === undefined ? null : { ...record, text, contents };
}

export function importCollectionSkill(
  input: SkillFile[],
  source: CollectionSkill["source"],
  options: { replace?: boolean; skipped?: string[] } = {},
): CollectionSkill | { error: string; code: "invalid" | "too-big" | "exists" } {
  const normalized = normalizeSkillFiles(input);
  if ("error" in normalized) return normalized;
  const skillMd = normalized.files[0]!;
  const parsed = parseSkillMd(skillMd.content);
  if ("error" in parsed) return { error: `That skill's instructions can't be read: ${parsed.error}`, code: "invalid" };
  if (!isSkillName(parsed.name)) return { error: `"${parsed.name}" is not a usable skill name (lowercase letters, numbers and dashes).`, code: "invalid" };
  const records = readRecords();
  if (records[parsed.name] && !options.replace) return { error: `You already have a skill called ${parsed.name}.`, code: "exists" };

  const scan = scanSkill({ name: parsed.name, description: parsed.description, triggerTerms: [], files: normalized.files });
  const incoming = join(root(), `.incoming-${randomUUID()}`);
  mkdirSync(incoming, { recursive: true, mode: 0o700 });
  try {
    for (const file of normalized.files) {
      const target = join(incoming, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.content, { mode: 0o600, flag: "wx" });
    }
    const destination = join(root(), parsed.name);
    const previous = existsSync(destination) ? join(root(), `.replaced-${randomUUID()}`) : null;
    if (previous) renameSync(destination, previous);
    renameSync(incoming, destination);
    if (previous) rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true });
    throw error;
  }
  const record: CollectionSkill = {
    name: parsed.name,
    description: parsed.description,
    source,
    importedAt: new Date().toISOString(),
    files: normalized.files.map((file) => file.path),
    skipped: options.skipped ?? [],
    scan,
  };
  writeRecords({ ...readRecords(), [parsed.name]: record });
  return record;
}

export function deleteCollectionSkill(name: string): boolean {
  if (!isSkillName(name)) return false;
  const records = readRecords();
  if (!records[name]) return false;
  delete records[name];
  writeRecords(records);
  rmSync(join(root(), name), { recursive: true, force: true });
  return true;
}
