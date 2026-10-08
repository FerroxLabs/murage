// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";

/** The longest Unix socket path the kernel takes: sun_path is 104 bytes on macOS and the BSDs, 108 on Linux, each
 * including the terminating NUL. The broker names its socket browser-<16 hex>.sock inside the runtime folder. */
const socketPathMax = (platform: NodeJS.Platform): number => platform === "linux" ? 107 : 103;
const socketFits = (dir: string, platform: NodeJS.Platform): boolean => Buffer.byteLength(posix.join(dir, "browser-0123456789abcdef.sock")) <= socketPathMax(platform);

/** Where the browser broker keeps its socket and the owned launcher and receipt. In the data folder, not in a
 * predictable /tmp or %TEMP% name another user or Storage Sense can reach. A Unix socket path has a hard length limit
 * (about 104 bytes), so a very deep data folder falls back to the user's own runtime folder. Windows uses a named
 * pipe, so its length never matters; its folder is a sibling of browser-extension/ because the Windows helper must be the one that creates that itself. */
export function browserExtensionRuntimeDir(options: { dataDir: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; tmp?: string; uid?: number; random?: () => string }): string {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env;
  // Paths are spelled for the target platform, not the host (a Unix socket path is always "/"-separated).
  const join = platform === "win32" ? win32.join : posix.join;
  if (env.MURAGE_BROWSER_EXTENSION_RUNTIME_ROOT) return join(env.MURAGE_BROWSER_EXTENSION_RUNTIME_ROOT, `mbe-${createHash("sha256").update(options.dataDir).digest("hex").slice(0, 12)}`);
  // A short sibling of browser-extension/ on every platform: short enough for a Mac data folder
  // ("~/Library/Application Support/murage"), and never inside the folder the Windows helper must create itself.
  const inside = join(options.dataDir, "bx-run");
  // The data folder keeps its historical 100-byte budget so an existing install never moves its runtime folder (the
  // browser's native host registration points into it); the fallback below uses the kernel's real limit.
  if (platform === "win32" || Buffer.byteLength(join(inside, "browser-0123456789abcdef.sock")) <= 100) return inside;
  const hash = createHash("sha256").update(options.dataDir).digest("hex").slice(0, 12), uid = options.uid ?? process.getuid?.() ?? 0;
  const base = env.XDG_RUNTIME_DIR || options.tmp || (platform === "darwin" ? env.TMPDIR || tmpdir() : "/tmp");
  // The predictable name first (the one an existing registration already points at), then a shorter predictable one,
  // since the macOS per-user temp folder alone takes about 48 of the 103 bytes; if something else already holds a name
  // (not our directory, or not mode 0700), a fresh short unique name instead of failing. A candidate that cannot hold
  // a socket path is skipped, and none fitting fails closed.
  const random = options.random ?? (() => randomBytes(4).toString("hex"));
  const candidates = [`murage-mbe-${hash}-${uid}`, `mbe-${hash}-${uid}`, ...Array.from({ length: 8 }, () => `mbe-${uid}-${random()}`)];
  let fitted = false;
  for (const name of candidates) {
    const dir = join(base, name);
    if (!socketFits(dir, platform)) continue;
    fitted = true;
    let entry; try { entry = lstatSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return dir; continue; }
    if (entry.isDirectory() && entry.uid === uid && (entry.mode & 0o777) === 0o700) return dir;
  }
  throw Error(fitted ? "browser_extension_runtime_dir_unavailable: no usable runtime folder" : "browser_extension_runtime_dir_too_long");
}
