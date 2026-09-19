import { execFileSync } from "node:child_process";
import path from "node:path";

// Mandatory integrity labels of an elevated token: High (an administrator who
// accepted UAC, or "Run as administrator") and System.
const ELEVATED_LABELS = ["S-1-16-12288", "S-1-16-16384"];
let cached;

/** Whether this Windows process runs elevated. The backup helper refuses an
 * elevated token by design, so callers refuse before closing anything and say
 * why instead of failing after the window has closed. False when Windows
 * cannot say, so an unknown answer never blocks a backup. */
export function windowsElevated({ platform = process.platform, run, fresh = false } = {}) {
  if (platform !== "win32") return false;
  if (!fresh && cached !== undefined && !run) return cached;
  const whoami = run ?? (() => execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), ["/groups", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 5000 }));
  let elevated = false;
  try { const groups = String(whoami()); elevated = ELEVATED_LABELS.some(label => groups.includes(label)); } catch { elevated = false; }
  if (!run) cached = elevated;
  return elevated;
}
