// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Where the browser broker keeps its socket and the owned launcher and receipt. In the data folder, not in a
 * predictable /tmp or %TEMP% name another user or Storage Sense can reach. A Unix socket path has a hard length limit
 * (about 104 bytes), so a very deep data folder falls back to the user's own runtime folder. Windows uses a named
 * pipe, so its length never matters; its folder is a sibling of browser-extension/ because the Windows helper must be the one that creates that itself. */
export function browserExtensionRuntimeDir(options: { dataDir: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; tmp?: string; uid?: number; random?: () => string }): string {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env;
  // Paths follow the platform asked about, not the host, so one answer holds wherever it is computed.
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  if (env.MURAGE_BROWSER_EXTENSION_RUNTIME_ROOT) return join(env.MURAGE_BROWSER_EXTENSION_RUNTIME_ROOT, `mbe-${createHash("sha256").update(options.dataDir).digest("hex").slice(0, 12)}`);
  // A short sibling of browser-extension/ on every platform: short enough for a Mac data folder
  // ("~/Library/Application Support/murage"), and never inside the folder the Windows helper must create itself.
  const inside = join(options.dataDir, "bx-run");
  if (platform === "win32") return inside;
  if (Buffer.byteLength(join(inside, "browser-0123456789abcdef.sock")) <= 100) return inside;
  const hash = createHash("sha256").update(options.dataDir).digest("hex").slice(0, 12), uid = options.uid ?? process.getuid?.() ?? 0;
  const base = env.XDG_RUNTIME_DIR || options.tmp || (platform === "darwin" ? env.TMPDIR || tmpdir() : "/tmp");
  // The predictable name first; if something else already holds it (not our directory, or not mode 0700), a fresh
  // unique name instead of failing. A candidate that cannot hold a socket path fails closed.
  const random = options.random ?? (() => randomBytes(6).toString("hex"));
  const candidates = [`murage-mbe-${hash}-${uid}`, ...Array.from({ length: 8 }, () => `murage-mbe-${hash}-${uid}-${random()}`)];
  for (const name of candidates) {
    const dir = join(base, name);
    if (Buffer.byteLength(join(dir, "browser-0123456789abcdef.sock")) > 100) throw Error("browser_extension_runtime_dir_too_long");
    let entry; try { entry = lstatSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return dir; continue; }
    if (entry.isDirectory() && entry.uid === uid && (entry.mode & 0o777) === 0o700) return dir;
  }
  throw Error("browser_extension_runtime_dir_unavailable: no usable runtime folder");
}
