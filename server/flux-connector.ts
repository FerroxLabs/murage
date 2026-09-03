// The safety envelope for writing Flux into a CLI's OWN config file.
//
// Every other Flux mechanism in this app is reversible for free: an env var
// dies with the child, a scoped HOME is an app-private directory we own. This
// module covers the one mechanism that is not — a write into a file the USER
// owns, that their CLI reads whether or not Murage is running, and that they
// may have hand-edited.
//
// Wayland (~/dev/wayland/app/src/process/connectors) shipped the two pieces
// that make this survivable — `safeFs.backupRealTarget` (symlink-safe
// snapshot) and `verifyRoute.verifyRouteOrRollback` (post-write probe with
// auto-rollback) — and then imported neither of them from its connectors. This
// is the same protection, wired on day one, with two additions Wayland lacks:
//
//   * the symlink check guards the WRITE as well as the backup. Wayland's
//     `backupRealTarget` refuses a config whose realpath escapes its home, but
//     `setupOpencode` then writes through the same symlink unguarded.
//   * the receipt carries a second hash, over the exact bytes we wrote, so
//     "the user edited this file" and "the user edited OUR block" are
//     distinguishable. Wayland stores only the managed hash and so cannot tell
//     an edit around us from no edit at all.
//
// The design rule behind all of it: a user's CLI config is their property.
// Destroying it is a worse outcome than not shipping the feature, so every
// path here fails CLOSED — a refusal, never a best-effort overwrite.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

/** Where this app keeps state it owns outright — receipts, snapshots, scoped
 *  homes. Read from `env` rather than the module constant so a test rig can
 *  point a whole connector at a temp dir without touching `~/.murage`, and so
 *  a `MURAGE_DATA_DIR` set after this module loaded still wins. */
export function murageStateDir(env: Record<string, string | undefined> = process.env): string {
  return env.MURAGE_DATA_DIR || DATA_DIR;
}

/** What the CLI's config file currently says about us.
 *
 *  - `absent`       — no config file at all.
 *  - `unconfigured` — a config file with no block of ours in it.
 *  - `routed`       — our block is present and byte-for-byte what the receipt
 *                     says we wrote. This is the ONLY state that may offer
 *                     Flux rows for a config-write engine.
 *  - `drifted`      — a block of ours is present but does not match the
 *                     receipt: either the user edited it, or another tool
 *                     wrote one, or we have no receipt for it at all. */
export type ConnectorState = "absent" | "unconfigured" | "routed" | "drifted";

/** What one install actually did to one file. Persisted so a later run can
 *  tell OUR block from the user's edits without guessing. */
export interface ConnectorReceipt {
  tool: string;
  /** The REAL path written — symlinks already resolved. */
  configPath: string;
  /** sha256 of the managed subject: the identifying part of the block we
   *  wrote, with the API key DELIBERATELY excluded so rotating a key does not
   *  read as drift (Wayland's rule, opencode.ts:64-67). */
  managedHash: string;
  /** sha256 of the exact bytes we wrote. Differs from the file on disk ⇒ the
   *  file changed since; combined with `managedHash` that separates "edited
   *  around us" (fine) from "edited us" (drift). */
  fileHash: string;
  /** Full-file snapshot of the file as it was BEFORE our first write. null
   *  when no config file existed then. Never re-taken — see `installConnector`. */
  backupPath: string | null;
  baseUrl: string;
  installedAt: string;
}

export interface ConnectorManifest {
  version: 1;
  tools: Record<string, ConnectorReceipt>;
}

export interface ConnectorPaths {
  /** The CLI's own config file, as the CLI resolves it. */
  configPath: string;
  /** The directory the config's REAL target must stay inside. A realpath that
   *  escapes it is treated as symlink traversal and refused, for the backup
   *  read and for the write. */
  allowedRoot: string;
  /** Our receipt store. App-private. */
  manifestPath: string;
  /** Where first-install snapshots go. App-private. */
  backupDir: string;
}

/**
 * The engine-specific half: three pure text transforms. Everything dangerous
 * (symlinks, backups, receipts, drift, rollback) is handled by this module, so
 * a new engine only has to know its own file format.
 */
export interface ConnectorPlan {
  /** Our managed subject as it stands in `text`, or null when our block is not
   *  there. Must not throw on a malformed file — return null. */
  read(text: string): string | null;
  /** `text` (null when the file is absent) with our block installed. Throws to
   *  refuse — a malformed or hostile-shaped config must not be overwritten. */
  write(text: string | null): { text: string; managedSubject: string };
  /** `text` with ONLY our block removed and everything else — including edits
   *  made after we wrote — preserved. null when there was nothing of ours. */
  strip(text: string): string | null;
}

export interface ConnectorStatus {
  state: ConnectorState;
  receipt: ConnectorReceipt | null;
  /** The real path we would read/write, or null when it cannot be resolved
   *  safely (a symlink escaping `allowedRoot`, say). */
  configPath: string | null;
  /** Set when `configPath` is null: why the path was refused. */
  unsafe?: string;
}

export interface InstallResult {
  ok: boolean;
  state: ConnectorState | "failed";
  /** Did the bytes on disk actually change? */
  changed: boolean;
  /** Did a failed post-write verification undo the write? */
  rolledBack: boolean;
  backupPath: string | null;
  /** Copy-pasteable manual restore, or null when there is no snapshot. */
  rollbackCommand: string | null;
  reason?: string;
}

export interface RemoveResult {
  ok: boolean;
  removed: boolean;
  /** Set when the block we removed did not match the receipt; the drifted file
   *  was snapshotted here first. */
  driftBackupPath?: string;
  reason?: string;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Resolve `configPath` to the real file we may touch, or throw.
 *
 * A config path is allowed to BE a symlink — that is a normal dotfile-manager
 * setup — but only to a target that stays inside `allowedRoot`. A link out of
 * the tree is how a config write becomes an arbitrary-file write, so it is
 * refused for reads and writes alike. A DANGLING link is refused too: the
 * alternative is `writeFileAtomic`'s rename silently replacing the link with a
 * regular file, which destroys the user's link for good.
 *
 * Both sides are realpath-normalised before comparing, so a root reached
 * through a link (macOS /tmp → /private/tmp) still compares equal.
 */
export function resolveConfigTarget(configPath: string, allowedRoot: string): string {
  const realRoot = realOf(allowedRoot);
  let link = false;
  try {
    link = lstatSync(configPath).isSymbolicLink();
  } catch {
    /* missing is fine — resolved through the parent below */
  }

  let target: string;
  if (link) {
    try {
      target = realpathSync(configPath);
    } catch {
      throw new Error(`refusing to touch ${configPath}: it is a symlink with no valid target`);
    }
  } else if (existsSync(configPath)) {
    target = realpathSync(configPath);
  } else {
    target = join(realOf(dirname(configPath)), basename(configPath));
  }

  const rel = relative(realRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `refusing to touch ${configPath}: real target ${target} escapes ${realRoot}`,
    );
  }
  return target;
}

export function readConnectorManifest(manifestPath: string): ConnectorManifest {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { version: 1, tools: {} };
    const tools = (raw as { tools?: unknown }).tools;
    if (!tools || typeof tools !== "object" || Array.isArray(tools)) return { version: 1, tools: {} };
    return { version: 1, tools: tools as Record<string, ConnectorReceipt> };
  } catch {
    // No manifest, or one we cannot parse. Treating it as empty is safe: the
    // worst case is that a present block reads as `drifted` and we refuse to
    // write, which is the fail-closed direction.
    return { version: 1, tools: {} };
  }
}

function writeConnectorManifest(manifestPath: string, manifest: ConnectorManifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export function connectorReceipt(manifestPath: string, tool: string): ConnectorReceipt | null {
  return readConnectorManifest(manifestPath).tools[tool] ?? null;
}

function dropReceipt(manifestPath: string, tool: string): void {
  const manifest = readConnectorManifest(manifestPath);
  if (!(tool in manifest.tools)) return;
  delete manifest.tools[tool];
  writeConnectorManifest(manifestPath, manifest);
}

/** Read the file at `target`, or null when it is not there. */
function readOrNull(target: string): string | null {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

/** The mode to give the replacement inode. An existing config keeps its own
 *  permissions — silently widening a 0600 file that is about to hold an API
 *  key is its own vulnerability — and a file we create is 0600. */
function modeFor(target: string, existed: boolean): number {
  if (!existed) return 0o600;
  try {
    return statSync(target).mode & 0o777;
  } catch {
    return 0o600;
  }
}

/**
 * Classify the config file. Pure read — never writes, never creates a
 * directory, safe to call from a catalog build.
 */
export function connectorStatus(paths: ConnectorPaths, tool: string, plan: ConnectorPlan): ConnectorStatus {
  const receipt = connectorReceipt(paths.manifestPath, tool);
  let target: string;
  try {
    target = resolveConfigTarget(paths.configPath, paths.allowedRoot);
  } catch (error) {
    return { state: "absent", receipt, configPath: null, unsafe: (error as Error).message };
  }

  const text = readOrNull(target);
  if (text === null) return { state: "absent", receipt, configPath: target };

  let subject: string | null = null;
  try {
    subject = plan.read(text);
  } catch {
    subject = null;
  }
  if (subject === null) return { state: "unconfigured", receipt, configPath: target };
  if (!receipt) return { state: "drifted", receipt, configPath: target };
  return {
    state: sha256(subject) === receipt.managedHash ? "routed" : "drifted",
    receipt,
    configPath: target,
  };
}

function snapshot(backupDir: string, tool: string, bytes: string, suffix: string): string {
  const dir = join(backupDir, tool);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}.${process.pid}${suffix}`);
  writeFileAtomic(path, bytes, { mode: 0o600 });
  return path;
}

export function rollbackCommandFor(backupPath: string | null, configPath: string): string | null {
  return backupPath ? `cp ${JSON.stringify(backupPath)} ${JSON.stringify(configPath)}` : null;
}

export interface InstallOptions {
  paths: ConnectorPaths;
  tool: string;
  plan: ConnectorPlan;
  baseUrl: string;
  /**
   * Post-write live probe. Run AFTER the file is on disk, because the whole
   * point is to prove the route the CLI will actually read. `false` or a throw
   * rolls the file back to exactly what it was.
   *
   * Optional so tests and headless installs can opt out — but note that an
   * install with no probe reports `ok` on a route nobody has confirmed.
   */
  verify?: () => Promise<boolean>;
  /** Overwrite a drifted block. Off by default, and never set by the app on
   *  its own — only when a human has been shown the drift and said yes. */
  force?: boolean;
}

/**
 * Write our block into the CLI's config, safely.
 *
 * Order is load-bearing:
 *   1. resolve the real target and refuse a symlink out of the tree;
 *   2. classify drift and refuse rather than clobber;
 *   3. snapshot the ORIGINAL file, once ever;
 *   4. atomic write, preserving the file's own permissions;
 *   5. record the receipt;
 *   6. verify live, and undo everything if the route does not work.
 *
 * Step 3 before step 4 is what makes step 6 possible. Step 2 before step 3 is
 * what stops a re-run from snapshotting an already-modified file as if it were
 * pristine.
 */
export async function installConnector(options: InstallOptions): Promise<InstallResult> {
  const { paths, tool, plan, baseUrl } = options;

  let target: string;
  try {
    target = resolveConfigTarget(paths.configPath, paths.allowedRoot);
  } catch (error) {
    return {
      ok: false,
      state: "failed",
      changed: false,
      rolledBack: false,
      backupPath: null,
      rollbackCommand: null,
      reason: (error as Error).message,
    };
  }

  const prior = connectorReceipt(paths.manifestPath, tool);
  const before = readOrNull(target);
  const existed = before !== null;

  // ---- drift ----------------------------------------------------------
  // The decision: a drifted block is a REFUSAL, not an overwrite.
  //
  // We cannot tell a deliberate user edit from a corruption, and the two want
  // opposite handling. Overwriting silently reverts a considered change (a
  // pinned base URL, a hand-added model) with no trace and no way back short
  // of the snapshot. Refusing costs the user one explicit re-run. The
  // asymmetry is the whole argument: refusing is recoverable, clobbering is
  // not. `force` exists for the case where a human has seen the drift.
  //
  // Note what is NOT drift: an edit anywhere else in the file. `plan.read`
  // looks only at our own block, so a user who adds an unrelated key keeps a
  // `routed` status and a working re-run — which is why the receipt carries
  // `fileHash` separately and this check does not consult it.
  if (existed) {
    let subject: string | null = null;
    try {
      subject = plan.read(before);
    } catch {
      subject = null;
    }
    if (subject !== null && !options.force) {
      const owned = prior !== null && sha256(subject) === prior.managedHash;
      if (!owned) {
        return {
          ok: false,
          state: "drifted",
          changed: false,
          rolledBack: false,
          backupPath: prior?.backupPath ?? null,
          rollbackCommand: rollbackCommandFor(prior?.backupPath ?? null, target),
          reason: prior
            ? `${target} has a Flux block that is not the one we wrote — refusing to overwrite it`
            : `${target} already has a Flux block we have no record of — refusing to overwrite it`,
        };
      }
    }
  }

  // ---- render ---------------------------------------------------------
  let rendered: { text: string; managedSubject: string };
  try {
    rendered = plan.write(before);
  } catch (error) {
    return {
      ok: false,
      state: "failed",
      changed: false,
      rolledBack: false,
      backupPath: prior?.backupPath ?? null,
      rollbackCommand: null,
      reason: (error as Error).message,
    };
  }

  // ---- first-install-only snapshot ------------------------------------
  // Reuse the existing snapshot whenever it is still on disk. A second install
  // that re-snapshotted would capture the file WITH our block already in it,
  // and the "restore the user's original" guarantee would quietly become
  // "restore the last thing we wrote".
  let backupPath = prior?.backupPath ?? null;
  if (backupPath && !existsSync(backupPath)) backupPath = null;
  if (backupPath === null && existed) {
    try {
      backupPath = snapshot(paths.backupDir, tool, before, ".backup");
    } catch (error) {
      return {
        ok: false,
        state: "failed",
        changed: false,
        rolledBack: false,
        backupPath: null,
        rollbackCommand: null,
        reason: `could not snapshot ${target}: ${(error as Error).message}`,
      };
    }
  }

  // ---- write ----------------------------------------------------------
  const changed = rendered.text !== before;
  if (changed) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileAtomic(target, rendered.text, { mode: modeFor(target, existed) });
    } catch (error) {
      return {
        ok: false,
        state: "failed",
        changed: false,
        rolledBack: false,
        backupPath,
        rollbackCommand: rollbackCommandFor(backupPath, target),
        reason: (error as Error).message,
      };
    }
  }

  const receipt: ConnectorReceipt = {
    tool,
    configPath: target,
    managedHash: sha256(rendered.managedSubject),
    fileHash: sha256(rendered.text),
    backupPath,
    baseUrl,
    installedAt: new Date().toISOString(),
  };
  const manifest = readConnectorManifest(paths.manifestPath);
  manifest.tools[tool] = receipt;
  writeConnectorManifest(paths.manifestPath, manifest);

  // ---- verify, or undo ------------------------------------------------
  if (options.verify) {
    let live = false;
    try {
      live = await options.verify();
    } catch {
      live = false;
    }
    if (!live) {
      try {
        restore(target, backupPath, existed);
      } catch (error) {
        // Neither verified nor cleanly restored. The receipt stays so the
        // rollback command still names the snapshot; the caller must surface
        // this, because the file is in a state nobody chose.
        return {
          ok: false,
          state: "failed",
          changed,
          rolledBack: false,
          backupPath,
          rollbackCommand: rollbackCommandFor(backupPath, target),
          reason: `route verification failed and rollback also failed: ${(error as Error).message}`,
        };
      }
      dropReceipt(paths.manifestPath, tool);
      return {
        ok: false,
        state: "failed",
        changed: false,
        rolledBack: true,
        backupPath,
        rollbackCommand: rollbackCommandFor(backupPath, target),
        reason: "the Flux route did not answer after the write — the config was restored",
      };
    }
  }

  return {
    ok: true,
    state: "routed",
    changed,
    rolledBack: false,
    backupPath,
    rollbackCommand: rollbackCommandFor(backupPath, target),
  };
}

/** Put `target` back: the snapshot's bytes, or delete the file we created. */
function restore(target: string, backupPath: string | null, existed: boolean): void {
  if (!existed || backupPath === null) {
    rmSync(target, { force: true });
    return;
  }
  const bytes = readFileSync(backupPath, "utf8");
  writeFileAtomic(target, bytes, { mode: modeFor(target, true) });
}

export interface RemoveOptions {
  paths: ConnectorPaths;
  tool: string;
  plan: ConnectorPlan;
}

/**
 * Surgical disconnect: delete OUR block and nothing else.
 *
 * The full snapshot is deliberately NOT restored here. It is a nuclear option
 * that would also throw away every edit the user made after the install; the
 * right disconnect leaves the file exactly as it would have been had we never
 * written, which for an untouched file means byte-identical to the original.
 *
 * Drift is handled differently from install, on purpose. Install refuses,
 * because rewriting is a guess. Disconnect proceeds, because the user asked
 * for our block to go and refusing would trap them with a provider they cannot
 * remove from inside the app — but it snapshots the drifted file first, so the
 * edit they lose is still on disk under a path we report.
 */
export async function removeConnector(options: RemoveOptions): Promise<RemoveResult> {
  const { paths, tool, plan } = options;

  let target: string;
  try {
    target = resolveConfigTarget(paths.configPath, paths.allowedRoot);
  } catch (error) {
    return { ok: false, removed: false, reason: (error as Error).message };
  }

  const receipt = connectorReceipt(paths.manifestPath, tool);
  const before = readOrNull(target);
  if (before === null) {
    dropReceipt(paths.manifestPath, tool);
    return { ok: true, removed: false, reason: "no config file to clean up" };
  }

  let next: string | null;
  let subject: string | null;
  try {
    subject = plan.read(before);
    next = plan.strip(before);
  } catch (error) {
    return { ok: false, removed: false, reason: (error as Error).message };
  }
  if (next === null) {
    dropReceipt(paths.manifestPath, tool);
    return { ok: true, removed: false, reason: "nothing of ours in this config" };
  }

  let driftBackupPath: string | undefined;
  if (subject !== null && (!receipt || sha256(subject) !== receipt.managedHash)) {
    try {
      driftBackupPath = snapshot(paths.backupDir, tool, before, ".pre-disconnect");
    } catch (error) {
      return { ok: false, removed: false, reason: `could not snapshot before removal: ${(error as Error).message}` };
    }
  }

  try {
    writeFileAtomic(target, next, { mode: modeFor(target, true) });
  } catch (error) {
    return { ok: false, removed: false, reason: (error as Error).message, driftBackupPath };
  }
  dropReceipt(paths.manifestPath, tool);
  return { ok: true, removed: true, driftBackupPath };
}
