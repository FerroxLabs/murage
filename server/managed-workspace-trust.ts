// Folder trust for Murage-managed thread desks (0.1.54 option C).
//
// A task or room turn with pinned skills links each skill into its private
// desk, `<dataDir>/workspaces/<botId>/threads/<threadId>`, under
// `.claude/skills` and `.agents/skills` (procedure-bundles.ts). Fuigo gates
// those directories like any project skill root, so every new task raised
// the "Trust this folder?" card for a folder Murage created itself.
//
// This module decides when such a desk may run trusted without asking. It is
// deliberately narrow, because Fuigo 1.0.20 has no per-session trust: the
// `--trust` a trusted turn passes persists a grant for the turn's workspace
// key (fuigo-workspace/src/folder_trust.rs `grant_folder_trust`). So every
// condition below is about that grant, and all of them must hold:
//
//   - the folder resolves (realpath) to exactly this turn's thread desk, and
//     no path component from the data dir down to the desk is a symlink. A
//     `..` spelling, a symlinked desk or a symlinked `threads` dir fails;
//   - the engine's workspace key for the folder is the desk itself. No git
//     root above it (that key would cover a parent) and no registry collapse.
//     Outside a repository, upstream `is_trusted` matches a record only for a
//     query whose own key equals it, so the grant covers this one folder;
//   - every trust-sensitive source the scan names is a skill root Murage links
//     into (`.claude/skills`, `.agents/skills`). Anything else, such as an
//     AGENTS.md, .mcp.json, hooks or `.fuigo/skills`, keeps the card;
//   - every entry in every project skill or command root (including
//     `.grok/skills`) is a symlink whose target resolves to
//     `<desk>/.murage-procedures/<bundleId>/skills/<same name>` of a published
//     bundle (`.complete` present) this turn pinned. A foreign directory, a
//     file, or a link that leaves the bundle keeps the card.
//
// User-chosen folders never match: they are not the thread desk.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import { canonicalFolder, gitRootOf, type FolderTrustScan } from "./folder-trust.ts";

/** The skill roots `preparePinnedProcedures` links into that Murage's scan
 * reports. */
const MURAGE_LINKED_SOURCES = new Set([".claude/skills", ".agents/skills"]);
/** Every project skill or command root upstream loads, plus Murage's own
 * `.grok/skills`. Each one that exists must hold only Murage links. */
const SKILL_ROOTS = [".fuigo", ".agents", ".claude", ".cursor", ".grok"].flatMap((d) => [`${d}/skills`, `${d}/commands`]);

const SAFE_ID = /^[\w-]+$/;

export interface ManagedWorkspaceTrustInput {
  /** Murage's data dir (`DATA_DIR`). */
  dataDir: string;
  botId: string;
  threadId: string;
  /** Bundle ids pinned for this turn. A link into any other bundle fails. */
  bundleIds: readonly string[];
}

function realDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function realFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The canonical thread desk when `folder` is this turn's desk reached
 * without any symlink below the data dir; null otherwise. */
export function managedThreadDesk(folder: string, input: Pick<ManagedWorkspaceTrustInput, "dataDir" | "botId" | "threadId">): string | null {
  if (!SAFE_ID.test(input.botId) || !SAFE_ID.test(input.threadId)) return null;
  if (!isAbsolute(folder) || folder.split(/[\\/]+/).includes("..")) return null;
  let data: string;
  try {
    data = realpathSync.native(input.dataDir);
  } catch {
    return null;
  }
  let at = data;
  for (const part of ["workspaces", input.botId, "threads", input.threadId]) {
    at = join(at, part);
    if (!realDirectory(at)) return null;
  }
  let real: string;
  try {
    real = realpathSync.native(folder);
  } catch {
    return null;
  }
  return real === at ? at : null;
}

/** Whether `entry` in a skill root is a link to a pinned, published bundle
 * skill of the same name inside `desk`. */
function isMurageSkillLink(desk: string, root: string, name: string, bundleIds: ReadonlySet<string>): boolean {
  const link = join(root, name);
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let target: string;
  try {
    target = realpathSync.native(link);
  } catch {
    return false; // dangling
  }
  const procedures = join(desk, ".murage-procedures");
  if (!target.startsWith(procedures + sep)) return false;
  const parts = target.slice(procedures.length + 1).split(sep);
  if (parts.length !== 3 || parts[1] !== "skills" || parts[2] !== name) return false;
  const bundleId = parts[0]!;
  if (!SAFE_ID.test(bundleId) || !bundleIds.has(bundleId)) return false;
  const bundle = join(procedures, bundleId);
  // realpath already proved no symlink on the way, but the bundle must be a
  // published one and the skill a real directory
  return realDirectory(procedures) && realDirectory(bundle) && realDirectory(join(bundle, "skills")) && realDirectory(target) && realFile(join(bundle, ".complete"));
}

/** Whether this Fuigo turn may run trusted without a card: `folder` is the
 * turn's own managed thread desk and holds nothing trust-sensitive except
 * Murage's links to the skills it pinned. `scan` is
 * `scanFolderTrustSources(folder, { fuigoHome })` for the same turn. */
export function managedWorkspaceAutoTrust(folder: string, scan: FolderTrustScan, input: ManagedWorkspaceTrustInput): boolean {
  const desk = managedThreadDesk(folder, input);
  if (!desk) return false;
  // grant scope: the engine keys the grant on exactly the desk
  if (scan.key !== desk || canonicalFolder(scan.folder) !== desk) return false;
  // a repository above the desk widens the loaders' walk past it, even when
  // its root is unrecordable (a dotfiles home) and the key falls back
  const gitRoot = gitRootOf(desk);
  if (gitRoot !== null && gitRoot !== desk) return false;
  if (!scan.sources.length || !scan.sources.every((source) => MURAGE_LINKED_SOURCES.has(source))) return false;
  const bundleIds = new Set(input.bundleIds.filter((id) => SAFE_ID.test(id)));
  if (!bundleIds.size) return false;
  let linked = 0;
  for (const rel of SKILL_ROOTS) {
    const [parent, leaf] = rel.split("/") as [string, string];
    const parentDir = join(desk, parent);
    const root = join(parentDir, leaf);
    let exists = false;
    try {
      lstatSync(root);
      exists = true;
    } catch {
      try {
        // a symlinked `.claude` whose `skills` is missing is still not ours
        if (lstatSync(parentDir).isSymbolicLink()) return false;
      } catch {
        /* no parent: nothing to check */
      }
    }
    if (!exists) continue;
    if (!realDirectory(parentDir) || !realDirectory(root)) return false;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return false;
    }
    for (const name of names) {
      if (!isMurageSkillLink(desk, root, name, bundleIds)) return false;
      linked++;
    }
  }
  return linked > 0;
}
