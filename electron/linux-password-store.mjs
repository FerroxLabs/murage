import { execFileSync } from "node:child_process";

export const KEYRING_PROBE_TIMEOUT_MS = 700;
const knownDesktop = /^(GNOME|KDE|Unity|XFCE|LXDE|LXQt|X-Cinnamon|Cinnamon|MATE|Pantheon|UKUI|Deepin)$/i;

/** ListNames returns only names with an owner and does not start a keyring.
 * Synchronous and bounded so the switch is set before Electron can emit ready.
 * The command is injected in tests; they never contact the session bus. */
export function probeSessionKeyring(run = execFileSync) {
  try {
    const reply = run("dbus-send", ["--session", "--print-reply", "--reply-timeout=500",
      "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"],
    { encoding: "utf8", timeout: KEYRING_PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const names = new Set([...reply.matchAll(/string "([^"]+)"/g)].map(match => match[1]));
    if (names.has("org.freedesktop.secrets")) return "gnome-libsecret";
    if (names.has("org.kde.kwalletd6")) return "kwallet6";
    if (names.has("org.kde.kwalletd5")) return "kwallet5";
  } catch { /* Missing bus, missing dbus-send or timeout: keep Electron's choice. */ }
  return null;
}

export function configureLinuxPasswordStore({ commandLine, platform = process.platform, env = process.env, probe = probeSessionKeyring }) {
  if (platform !== "linux" || commandLine.hasSwitch("password-store")) return null;
  if ((env.XDG_CURRENT_DESKTOP ?? "").split(":").some(name => knownDesktop.test(name.trim()))) return null;
  let backend;
  try { backend = probe(); } catch { return null; }
  if (!["gnome-libsecret", "kwallet5", "kwallet6"].includes(backend)) return null;
  commandLine.appendSwitch("password-store", backend);
  return backend;
}
