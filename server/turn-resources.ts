// Adapted from OpenMausBot #981/#983, e014babe6fe162e9a7397dc37e0f025725f334c2.
// Apache-2.0; preserve Murage's own browser/computer integration callers.
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export type TurnOwner = Readonly<{ threadId: string; generation: string }>;

/** Claims cover a whole turn and its final cleanup, not an individual click.
 * These coordinate app-managed resources, not arbitrary shell commands. */
export class TurnResources {
  private readonly owners = new Map<string, TurnOwner>();

  claim(resource: string, owner: TurnOwner): boolean {
    return this.claimAll([resource], owner);
  }

  /** Admission can require browser, computer and workspace together. Refusal
   * must not leave a partial lease that blocks an otherwise independent turn. */
  claimAll(resources: readonly string[], owner: TurnOwner): boolean {
    for (const resource of resources) {
      for (const [key, current] of this.owners) {
        if (overlaps(key, resource) && !sameOwner(current, owner)) return false;
      }
    }
    const frozen = Object.freeze({ ...owner });
    for (const resource of resources) this.owners.set(resource, frozen);
    return true;
  }

  owns(resource: string, owner: TurnOwner): boolean {
    const current = this.owners.get(resource);
    return Boolean(current && sameOwner(current, owner));
  }

  release(owner: TurnOwner): void {
    for (const [key, current] of this.owners) {
      if (sameOwner(current, owner)) this.owners.delete(key);
    }
  }
}

function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.threadId === b.threadId && a.generation === b.generation;
}

export function workspaceResource(cwd: string): string {
  // The selected folder must exist. Native realpath resolves symlinks and
  // filename casing on case-insensitive volumes before overlap checks.
  const canonical = realpathSync.native(resolve(cwd));
  return `workspace:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
}

function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.startsWith("workspace:") || !b.startsWith("workspace:")) return false;
  const left = a.slice("workspace:".length), right = b.slice("workspace:".length);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep) && !/^[A-Za-z]:/.test(path));
  };
  return contains(left, right) || contains(right, left);
}
