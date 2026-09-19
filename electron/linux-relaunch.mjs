import fs from "node:fs";

/** Whether this Linux system would crash a Murage that restarts itself.
 *
 * `app.relaunch()` starts the new process with no_new_privs set, so Chromium's
 * setuid sandbox helper cannot work there and the process needs unprivileged
 * user namespaces. Ubuntu 24.04 restricts those through AppArmor unless the
 * program runs under its own profile (the .deb installs one for Murage);
 * other kernels can switch them off entirely. The first launch is unaffected,
 * because it uses the setuid helper, so only a restart dies: the window closes
 * and nothing comes back. Callers refuse before closing anything instead. */
export function linuxRelaunchBlocked({ platform = process.platform, read = file => fs.readFileSync(file, "utf8") } = {}) {
  if (platform !== "linux") return false;
  const value = file => { try { return String(read(file)).trim(); } catch { return null; } };
  if (value("/proc/sys/kernel/unprivileged_userns_clone") === "0" || value("/proc/sys/user/max_user_namespaces") === "0") return true;
  if (value("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") !== "1") return false;
  const label = value("/proc/self/attr/apparmor/current") ?? value("/proc/self/attr/current") ?? "";
  return !/^murage(?: |$)/.test(label);
}
