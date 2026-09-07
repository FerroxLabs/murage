import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type ProjectFolderLeaseMode = "writer" | "restore";
export interface ProjectFolderLease { ownerId: string; mode: ProjectFolderLeaseMode; canonicalPath: string; dev: string; ino: string }
interface HeldLease extends ProjectFolderLease { requestedPaths: Set<string> }
export class ProjectFolderLeaseError extends Error {
  readonly code: "invalid-path" | "conflict" | "owner-in-use" | "stale" | "unknown-owner" | "invalid-owner";
  constructor(code: ProjectFolderLeaseError["code"]) { super(`Project folder lease refused: ${code}`); this.name = "ProjectFolderLeaseError"; this.code = code; }
}
function directory(cwd: string): { requestedPath: string; canonicalPath: string; dev: string; ino: string } {
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0")) throw new ProjectFolderLeaseError("invalid-path");
  try {
    const requestedPath = resolve(cwd);
    const canonicalPath = realpathSync.native(requestedPath);
    const physical = statSync(canonicalPath, { bigint: true });
    const requested = statSync(requestedPath, { bigint: true });
    if (!physical.isDirectory() || !requested.isDirectory() || physical.dev !== requested.dev || physical.ino !== requested.ino
      || realpathSync.native(requestedPath) !== canonicalPath) throw new Error("Path changed during resolution");
    return { requestedPath, canonicalPath, dev: physical.dev.toString(), ino: physical.ino.toString() };
  } catch { throw new ProjectFolderLeaseError("invalid-path"); }
}
function nested(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}
function overlaps(left: Pick<ProjectFolderLease, "canonicalPath" | "dev" | "ino">, right: Pick<ProjectFolderLease, "canonicalPath" | "dev" | "ino">): boolean {
  return (left.dev === right.dev && left.ino === right.ino) || nested(left.canonicalPath, right.canonicalPath) || nested(right.canonicalPath, left.canonicalPath);
}
function view(lease: ProjectFolderLease): ProjectFolderLease {
  return { ownerId: lease.ownerId, mode: lease.mode, canonicalPath: lease.canonicalPath, dev: lease.dev, ino: lease.ino };
}

/** In-process registry only. Callers must retain the returned physical path
 * and revalidate before use; this does not lock out other OS processes. */
export class ProjectFolderLeases {
  private readonly held = new Map<string, HeldLease>();
  acquireWriter(ownerId: string, cwd: string): ProjectFolderLease { return this.acquire(ownerId, cwd, "writer"); }
  acquireRestore(ownerId: string, cwd: string): ProjectFolderLease { return this.acquire(ownerId, cwd, "restore"); }
  release(ownerId: string): boolean { return this.held.delete(ownerId); }
  conflicts(cwd: string, mode: ProjectFolderLeaseMode): ProjectFolderLease[] {
    if (mode !== "writer" && mode !== "restore") throw new ProjectFolderLeaseError("conflict");
    const target = directory(cwd);
    return [...this.held.values()].filter(lease => (mode === "restore" || lease.mode === "restore") && overlaps(target, lease)).map(view);
  }
  assertCurrent(ownerId: string): ProjectFolderLease {
    const lease = this.held.get(ownerId);
    if (!lease) throw new ProjectFolderLeaseError("unknown-owner");
    try {
      for (const path of [lease.canonicalPath, ...lease.requestedPaths]) {
        const current = directory(path);
        if (current.canonicalPath !== lease.canonicalPath || current.dev !== lease.dev || current.ino !== lease.ino) throw new Error("Identity changed");
      }
    } catch { throw new ProjectFolderLeaseError("stale"); }
    return view(lease);
  }
  private acquire(ownerId: string, cwd: string, mode: ProjectFolderLeaseMode): ProjectFolderLease {
    if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 200 || /[\x00-\x1f\x7f]/.test(ownerId)) throw new ProjectFolderLeaseError("invalid-owner");
    const target = directory(cwd);
    const existing = this.held.get(ownerId);
    if (existing) {
      this.assertCurrent(ownerId);
      if (existing.mode !== mode || existing.canonicalPath !== target.canonicalPath || existing.dev !== target.dev || existing.ino !== target.ino) throw new ProjectFolderLeaseError("owner-in-use");
      existing.requestedPaths.add(target.requestedPath);
      return view(existing);
    }
    if ([...this.held.values()].some(lease => (mode === "restore" || lease.mode === "restore") && overlaps(target, lease))) throw new ProjectFolderLeaseError("conflict");
    const lease: HeldLease = { ownerId, mode, canonicalPath: target.canonicalPath, dev: target.dev, ino: target.ino, requestedPaths: new Set([target.requestedPath]) };
    this.held.set(ownerId, lease);
    return view(lease);
  }
}
