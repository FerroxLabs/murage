// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writer claims on a project's work roots (plan 3.2/3.3, SPEC-P 5.4 and
// 5.4a; lane E1 builds the claim, lane E2a's writer cards use the same one).
//
// One writer per work root at a time: a card that may write claims its root
// for its whole run, and a project room turn claims `work_roots[0]` when it
// is free. Two writers on one root therefore take turns; a room turn that
// finds the root held runs outside it (its own room folder) instead of
// waiting, so the lead can always answer (5.4a). Roots are compared by
// canonical path and by device and inode, and a root nested in another
// conflicts with it. In-process only: this orders Murage's own turns, it does
// not lock out other programs.
import { TurnResources } from "./turn-resources.ts";
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve, isAbsolute, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { projectTableExists } from "./project-turn-engine.ts";
import type { WriterRoot } from "./work-admission.ts";

export interface WriterRootOwner { botId: string; threadId: string; turnGeneration: string }

function nested(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

function overlaps(left: WriterRoot, right: WriterRoot): boolean {
  return (left.dev === right.dev && left.ino === right.ino) || nested(left.canonicalPath, right.canonicalPath) || nested(right.canonicalPath, left.canonicalPath);
}

export class WriterRootClaims {
  readonly #resources = new TurnResources();
  readonly #held = new Map<string, { root: WriterRoot; owner: WriterRootOwner }>();

  /** Take the root now; the release, or null while another writer holds it
   * (or one overlapping it). Idempotent release. */
  claim(root: WriterRoot, owner: WriterRootOwner, previous?: WriterRootOwner): (() => void) | null {
    const replacing = [...this.#held.entries()].filter(([, held]) => previous &&
      previous.botId === owner.botId && previous.threadId === owner.threadId &&
      held.owner.botId === previous.botId && held.owner.threadId === previous.threadId &&
      held.owner.turnGeneration === previous.turnGeneration && overlaps(held.root, root));
    for (const [key, held] of this.#held) if (overlaps(held.root, root) && !replacing.some(([oldKey]) => oldKey === key)) return null;
    const key = `${owner.turnGeneration}:${root.canonicalPath}`;
    const resource = `workspace:${root.canonicalPath}`;
    const resourceOwner = { threadId: owner.threadId, generation: owner.turnGeneration };
    // Synchronous transfer: validate every competing writer before moving ownership.
    for (const [, held] of replacing) this.#resources.releaseSome({ threadId: held.owner.threadId, generation: held.owner.turnGeneration }, [`workspace:${held.root.canonicalPath}`]);
    if (!this.#resources.claim(resource, resourceOwner)) {
      for (const [, held] of replacing) this.#resources.claim(`workspace:${held.root.canonicalPath}`, { threadId: held.owner.threadId, generation: held.owner.turnGeneration });
      return null;
    }
    for (const [oldKey] of replacing) this.#held.delete(oldKey);
    this.#held.set(key, { root, owner });
    return () => {
      if (this.#held.get(key)?.owner !== owner) return;
      this.#held.delete(key);
      this.#resources.releaseSome(resourceOwner, [resource]);
    };
  }

  holder(root: WriterRoot): WriterRootOwner | undefined {
    for (const held of this.#held.values()) if (overlaps(held.root, root)) return held.owner;
    return undefined;
  }
}

/** The project's first work root (a room turn's folder, 5.4a), checked
 * against the disk now: a root that moved or vanished since the owner picked
 * it is not used. Absent for a channel or a project without roots. */
export function projectRoomWorkRoot(db: DatabaseSync, groupId: string, index = 0): WriterRoot | undefined {
  if (!projectTableExists(db, "project_settings")) return undefined;
  const row = db.prepare("SELECT work_roots FROM project_settings WHERE group_id=? AND ended_at IS NULL").get(groupId) as { work_roots: string } | undefined;
  if (!row) return undefined;
  let roots: Array<{ path?: unknown; dev?: unknown; ino?: unknown }> = [];
  try { roots = JSON.parse(row.work_roots) as typeof roots; } catch { return undefined; }
  const first = roots[index];
  if (!first || typeof first.path !== "string" || typeof first.dev !== "string" || typeof first.ino !== "string") return undefined;
  try {
    const canonicalPath = realpathSync.native(first.path);
    const stat = statSync(canonicalPath, { bigint: true });
    if (!stat.isDirectory() || canonicalPath !== first.path || stat.dev.toString() !== first.dev || stat.ino.toString() !== first.ino) return undefined;
    return { canonicalPath, dev: first.dev, ino: first.ino };
  } catch { return undefined; }
}

/** Only structured file writes have a path claim; shell text is not a path protocol. */
export function rootsForStructuredWrite(tool: string, paths: readonly string[] | undefined, cwd: string, roots: readonly WriterRoot[]): WriterRoot[] {
  if (!/(?:write|edit|patch|create|delete|remove|rename|move)/i.test(tool) || !paths?.length) return [];
  const canonical = (path: string): string => {
    const absolute = resolve(cwd, path);
    try { return realpathSync.native(absolute); }
    catch { const parent = dirname(absolute); return parent === absolute ? absolute : resolve(canonical(parent), relative(parent, absolute)); }
  };
  return roots.filter(root => paths.some(path => nested(root.canonicalPath, canonical(path))));
}
