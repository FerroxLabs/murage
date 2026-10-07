import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Per-turn Fuigo logs worth keeping: a turn that failed or retried. */
export const FUIGO_TURN_LOGS_KEEP = 20;
/** Names that never leave the per-turn home, even inside logs/. */
const SECRET_NAME = /auth|credential|secret|token|oauth|session|cookie|\.key$|\.pem$|\.db(?:-wal|-shm)?$|\.sqlite/i;

/** Copy only regular files and real directories from `src` into `dest`;
 * symlinks and every other type are skipped, never followed. */
function copyRegular(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(src)) {
    if (SECRET_NAME.test(name)) continue;
    const from = join(src, name), to = join(dest, name);
    let info;
    try { info = lstatSync(from); } catch { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) copyRegular(from, to);
    else if (info.isFile()) copyFileSync(from, to);
  }
}

/** Move `<home>/logs` (only logs, never auth or session files) to
 * `<root>/<turnId>/`, then keep the newest `keep` turn directories.
 * Best effort: a failure here never blocks the turn's cleanup. */
export function keepFuigoTurnLogs(home: string, turnId: string, root: string, keep = FUIGO_TURN_LOGS_KEEP): boolean {
  try {
    const logs = join(home, "logs");
    const id = turnId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "turn";
    if (!existsSync(logs)) return false;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const dest = join(root, id);
    rmSync(dest, { recursive: true, force: true });
    // Never rename: logs/ itself may be a symlink, and a rename would carry
    // links (and secrets) into the kept dir. Copy regular files, then remove
    // the source with rmSync, which unlinks a symlink without following it.
    const top = lstatSync(logs);
    if (top.isSymbolicLink() || !top.isDirectory()) { rmSync(logs, { recursive: true, force: true }); return false; }
    copyRegular(logs, dest);
    rmSync(logs, { recursive: true, force: true });
    const dirs = readdirSync(root)
      .map((name) => { try { return { name, at: lstatSync(join(root, name)).mtimeMs }; } catch { return null; } })
      .filter((entry): entry is { name: string; at: number } => entry !== null)
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    for (const old of dirs.slice(keep)) rmSync(join(root, old.name), { recursive: true, force: true });
    return true;
  } catch { return false; }
}
