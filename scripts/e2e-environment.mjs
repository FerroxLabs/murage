import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// The terms version this build asks for (shared/terms.ts is TypeScript, so read it as text).
const termsVersion = /TERMS_VERSION = "([^"]+)"/.exec(readFileSync(new URL("../shared/terms.ts", import.meta.url), "utf8"))?.[1];

/** Build a fixture environment, not a copy of a developer's credentials.
 * PATH retains system tooling, with this exact Node runtime first. Engine
 * selection is separately pinned to the verification-only instance. */
export function e2eEnvironment(base, dataDir, execPath = process.execPath) {
  const env = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ", "NO_COLOR", "FORCE_COLOR"]) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  const fixtureHome = join(dataDir, "fixture-home");
  return {
    ...env,
    PATH: [dirname(execPath), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(delimiter),
    HOME: fixtureHome,
    USERPROFILE: fixtureHome,
    APPDATA: join(fixtureHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(fixtureHome, "AppData", "Local"),
    XDG_CONFIG_HOME: join(fixtureHome, ".config"),
    XDG_CACHE_HOME: join(fixtureHome, ".cache"),
    XDG_DATA_HOME: join(fixtureHome, ".local", "share"),
    HERMES_HOME: join(fixtureHome, ".hermes"),
    MURAGE_DATA_DIR: dataDir,
    MURAGE_PORT: base.MURAGE_PORT,
    MURAGE_UI_PORT: base.MURAGE_UI_PORT,
    MURAGE_WEBHOOK_PORT: base.MURAGE_WEBHOOK_PORT,
    FAKE_CLAUDE_MODE: "happy",
    // A fixture install has no one to tick the terms box; the headless
    // declaration (server/terms.ts) stands in. A spec about the terms screen
    // itself sets MURAGE_TERMS_PENDING=1 to see the real first-run answer.
    ...(termsVersion && base.MURAGE_TERMS_PENDING !== "1" ? { MURAGE_TERMS_ACCEPTED: termsVersion } : {}),
  };
}
