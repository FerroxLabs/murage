// Where the user's personal folders actually are, on each platform.
//
// A checkpoint restore runs `git clean -fd` in the bot's working folder, so
// that folder must never BE one of the user's personal folders. Deciding which
// those are by joining `homedir()` to the English names "Desktop", "Documents"
// and "Downloads" is wrong on all three platforms, and wrong in a way that
// fails open — it protects a path that may not exist while the real folder,
// full of the user's files, is left unguarded:
//
//   Windows  OneDrive's Known Folder Move redirects Desktop, Documents and
//            Pictures into %USERPROFILE%\OneDrive\... (or "OneDrive - <Tenant>",
//            or another drive entirely, and the user may rename it). Verified on
//            a real Windows 11 box: SHGetKnownFolderPath answered
//            C:\Users\<u>\OneDrive\Desktop while C:\Users\<u>\Desktop did not
//            exist at all — and C:\Users\<u>\Documents DID exist as a leftover,
//            so the old guard protected an empty husk and left the live
//            Documents folder open. The paths are also localized: a German
//            install has "Dokumente", not "Documents".
//   macOS    iCloud's "Desktop & Documents Folders" moves both under
//            ~/Library/Mobile Documents/com~apple~CloudDocs/ and leaves a
//            symlink behind, and ~/Library itself is not a place to run
//            `git clean -fd`.
//   Linux    the XDG user dirs put Desktop/Documents/Downloads wherever
//            ~/.config/user-dirs.dirs says, under localized names.
//
// Three rules hold everywhere here:
//
//   Never guess what a documented lookup can answer. Windows reads the
//   redirect targets the shell itself writes; Linux reads the XDG file; macOS
//   has fixed on-disk names (the Finder localizes only the *display* name, via
//   a .localized marker — the directory on disk is always "Desktop").
//
//   Fail safe. Every lookup is additive: the default locations are ALWAYS in
//   the list, and a failed lookup subtracts nothing. Protecting one folder too
//   many costs a bot its checkpoints in that folder; protecting one too few
//   costs the user their files.
//
//   Compare with shared/path-identity.mjs, never with string equality, and let
//   the caller resolve symlinks — see `refusalReason` in checkpoints.ts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";

import { samePath } from "../shared/path-identity.mjs";

/** A folder no checkpoint may be taken in, with the name the refusal says. */
export type ProtectedFolder = { path: string; label: string };

/**
 * The platform's own answers, injected so every branch below can be exercised
 * on any host. `ok` is false when a lookup that should have worked did not, and
 * that is the one thing the process cache refuses to remember.
 */
export type FolderProbe = {
  platform: string;
  env: NodeJS.ProcessEnv;
  /** Raw `reg query` output for HKCU User Shell Folders, or null if it failed. */
  windowsUserShellFolders: () => string | null;
  /** Contents of the XDG user-dirs.dirs file, or null if there is none. */
  xdgUserDirs: (home: string) => string | null;
};

/** The default locations, used as the base of the list on every platform and
 * as the whole of it when a lookup fails. Ordered so the more specific
 * refusal messages read naturally; the order is otherwise immaterial. */
const DEFAULT_NAMES = ["Desktop", "Documents", "Downloads", "Pictures"] as const;

/**
 * HKCU User Shell Folders value name -> the label a refusal uses. These value
 * names are language-invariant (only the *data* is localized), which is what
 * makes the registry the right answer for a German or Japanese install.
 * Downloads has no legacy name and is keyed by its known-folder GUID.
 */
const WINDOWS_SHELL_VALUES: ReadonlyArray<readonly [string, string]> = [
  ["Desktop", "Desktop"],
  ["Personal", "Documents"],
  ["{374DE290-123F-4565-9164-39C4925E467B}", "Downloads"],
  ["My Pictures", "Pictures"],
];

/** OneDrive publishes its sync roots as environment variables. The root itself
 * is protected (not its contents): a `git clean -fd` there deletes files that
 * then get deleted in the cloud and on every other device. */
const ONEDRIVE_VARS = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"];

/** XDG user-dirs variable -> label. */
const XDG_DIRS: ReadonlyArray<readonly [string, string]> = [
  ["XDG_DESKTOP_DIR", "Desktop"],
  ["XDG_DOCUMENTS_DIR", "Documents"],
  ["XDG_DOWNLOAD_DIR", "Downloads"],
  ["XDG_PICTURES_DIR", "Pictures"],
];

/**
 * Directories whose immediate children are whole volumes or whole home
 * folders. `parse().root` catches "/" and "C:\", but not "/Volumes/Work" or
 * "/Users/someone-else" — each of which is just as unbounded, and one of which
 * is not even this user's to clean.
 */
const MOUNT_PARENTS: Record<string, readonly string[]> = {
  darwin: ["/Volumes", "/Users"],
  linux: ["/home", "/media", "/mnt", "/run/media"],
  win32: [],
};

/** The path rules of the platform being asked about, which on a test host is
 * not the one node:path bound itself to at import. */
function pathsOf(platform: string): typeof posixPath {
  return platform === "win32" ? win32Path : posixPath;
}

/** Whether `path` names one specific folder, with no room left for the
 * process's cwd or current drive to decide which. Stricter than isAbsolute on
 * Windows, where "\\Desktop" is rooted but means a different folder depending
 * on which drive the process happens to be sitting on. */
function fullyQualified(path: string, platform: string): boolean {
  return platform === "win32"
    ? /^(?:[A-Za-z]:[\\/]|[\\/][\\/])/.test(path)
    : path.startsWith("/");
}

/** The real probe: the shell's registry on Windows, the XDG file on Linux. */
export function systemProbe(): FolderProbe {
  return {
    platform: process.platform,
    env: process.env,
    windowsUserShellFolders: () => {
      try {
        // The documented source of truth is SHGetKnownFolderPath, and Node has
        // no binding for it (node:os offers homedir/tmpdir/userInfo and nothing
        // else; there is no core registry or known-folder API). `reg query` on
        // this key is the same data the shell serves: checked against a real
        // Windows 11 machine with Known Folder Move on, the registry values and
        // SHGetKnownFolderPath agreed for Desktop, Documents, Downloads and
        // Pictures, character for character.
        return execFileSync(
          "reg",
          ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"],
          { encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
        );
      } catch {
        return null;
      }
    },
    xdgUserDirs: (home) => {
      const base = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
      try {
        return readFileSync(join(base, "user-dirs.dirs"), "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** Expand %VAR% against a Windows environment, whose names are
 * case-insensitive. Returns null when a name is unknown, so a half-expanded
 * "%FOO%\Desktop" is never mistaken for a path. */
function expandWindows(value: string, env: NodeJS.ProcessEnv): string | null {
  let unknown = false;
  const out = value.replaceAll(/%([^%]+)%/g, (_whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    const found = key === undefined ? undefined : env[key];
    if (found === undefined) unknown = true;
    return found ?? "";
  });
  return unknown ? null : out;
}

/** Parse `reg query` output into value name -> data. `reg` separates the three
 * columns with runs of spaces, and a value name may itself contain single
 * spaces ("My Pictures"), so the type column is what the line is split on. */
function parseRegQuery(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\S.*?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.+?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

/** Read `NAME="value"` assignments out of an XDG user-dirs.dirs file and
 * expand $HOME / ${HOME}. Comment lines are skipped; a relative value (the
 * format allows `"$HOME/Desktop"` only, but be strict anyway) is dropped. */
function parseXdgUserDirs(contents: string, home: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(XDG_[A-Z_]+_DIR)\s*=\s*"(.*)"\s*$/.exec(line);
    if (!match) continue;
    const expanded = match[2].replaceAll(/\$\{HOME\}|\$HOME/g, home);
    if (posixPath.isAbsolute(expanded)) values.set(match[1], expanded);
  }
  return values;
}

/**
 * Every folder a checkpoint must refuse, for this `home` on this platform.
 * Additive by construction: the defaults go in first and no branch below can
 * remove one, so a lookup that fails leaves the list exactly as safe as the old
 * hardcoded one and a lookup that succeeds only widens it.
 *
 * `ok` is false when a lookup was expected to answer and did not — the caller's
 * cache uses it to avoid freezing a degraded list for the life of the process.
 */
export function protectedFolders(
  home: string,
  probe: FolderProbe = systemProbe(),
): { folders: ProtectedFolder[]; ok: boolean } {
  const p = pathsOf(probe.platform);
  const folders: ProtectedFolder[] = [];
  /** The defaults and the fixed locations, built from the home we were given
   * and therefore exactly as qualified as it is. */
  const add = (path: string, label: string): void => {
    const full = p.normalize(path);
    if (!folders.some((f) => samePath(f.path, full, probe.platform) && f.label === label)) {
      folders.push({ path: full, label });
    }
  };
  /** A value that came from a lookup, which may be anything at all. It must
   * name one specific folder: a relative entry in user-dirs.dirs, or a registry
   * value left half-expanded, would otherwise become a protected "folder" whose
   * meaning moves with the process's cwd. Rejecting one never empties the list,
   * because the defaults are already in it. */
  const addFromLookup = (path: string | null | undefined, label: string): void => {
    if (path && fullyQualified(path, probe.platform)) add(path, label);
  };

  for (const name of DEFAULT_NAMES) add(p.join(home, name), name);

  let ok = true;

  if (probe.platform === "win32") {
    const output = probe.windowsUserShellFolders();
    if (output === null) ok = false;
    else {
      const values = parseRegQuery(output);
      for (const [valueName, label] of WINDOWS_SHELL_VALUES) {
        const raw = values.get(valueName);
        // A key the shell did not write is not a failure: Downloads is absent
        // on older profiles, and the default already covers it.
        if (raw === undefined) continue;
        const expanded = expandWindows(raw, probe.env);
        if (expanded === null) ok = false;
        else addFromLookup(expanded, label);
      }
    }
    for (const name of ONEDRIVE_VARS) addFromLookup(probe.env[name]?.trim(), "OneDrive");
  } else if (probe.platform === "darwin") {
    // Names on disk are fixed; what moves is the whole pair, under iCloud Drive.
    const icloud = p.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
    add(p.join(home, "Library"), "Library");
    add(icloud, "iCloud Drive");
    // ~/Desktop is a symlink to these once "Desktop & Documents Folders" is on,
    // so the caller's realpath already catches a cwd spelled ~/Desktop. It does
    // not catch a cwd spelled as the iCloud path directly when the symlink is
    // missing (a second Mac not yet synced, or the user having removed it), and
    // that is a real folder full of real files either way.
    for (const name of ["Desktop", "Documents"]) add(p.join(icloud, name), name);
  } else {
    const fromEnv = new Map<string, string>();
    for (const [variable] of XDG_DIRS) {
      const value = probe.env[variable]?.trim();
      // These are normally sourced by the shell, not exported, so treat their
      // absence as ordinary and fall through to the file — and treat a junk
      // value the same way, rather than letting it shadow a good file entry.
      if (value && fullyQualified(value, probe.platform)) fromEnv.set(variable, value);
    }
    const contents = probe.xdgUserDirs(home);
    const fromFile = contents === null ? new Map<string, string>() : parseXdgUserDirs(contents, home);
    // No user-dirs.dirs is normal (a minimal system, or xdg-user-dirs not
    // installed) — the defaults are then the right answer, not a failure.
    for (const [variable, label] of XDG_DIRS) {
      addFromLookup(fromEnv.get(variable) ?? fromFile.get(variable), label);
    }
  }

  return { folders, ok };
}

/**
 * Whether `dir` is a directory of mount points ("/Volumes", "/home") or one of
 * its immediate children — a whole volume, or another user's whole home — the
 * cases `parse().root` cannot see. Cheap and stateless, so it is not cached.
 */
export function volumeRootReason(dir: string, platform: string = process.platform): string | null {
  const parents = MOUNT_PARENTS[platform] ?? [];
  if (parents.some((mount) => samePath(mount, dir, platform))) {
    return "checkpoints are not taken in a folder of mount points";
  }
  const parent = pathsOf(platform).dirname(dir);
  if (samePath(dir, parent, platform)) return null; // a filesystem root; not ours to name
  return parents.some((mount) => samePath(mount, parent, platform))
    ? "checkpoints are not taken at a volume or home root"
    : null;
}

let cache: { home: string; platform: string; folders: ProtectedFolder[] } | null = null;

/**
 * `protectedFolders` for the process, computed at most once. Runs on every
 * turn, and on Windows the lookup spawns `reg`, so the successful answer is
 * kept — but ONLY the successful one. A cache that remembered a failure would
 * pin the degraded default list for the rest of the session, which is the one
 * way a cache here could make Murage protect less than it otherwise would.
 */
export function cachedProtectedFolders(home: string = homedir()): ProtectedFolder[] {
  if (cache && samePath(cache.home, home) && cache.platform === process.platform) return cache.folders;
  const { folders, ok } = protectedFolders(home);
  if (ok) cache = { home, platform: process.platform, folders };
  else cache = null;
  return folders;
}

/** Tests only: forget the process cache. */
export function clearProtectedFolderCache(): void {
  cache = null;
}
