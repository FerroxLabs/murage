// protected-folders.ts contract: the list of folders a checkpoint refuses is
// discovered from each platform's own answer, not guessed from homedir() plus
// English names — and a lookup that fails subtracts nothing from it.
//
// Every platform branch runs on every host: the platform and the lookups are
// injected, and fixture paths are built from an already-canonical temp root so
// nothing here depends on the reviewer's own filesystem casing.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import {
  cachedProtectedFolders,
  clearProtectedFolderCache,
  protectedFolders,
  volumeRootReason,
  type FolderProbe,
} from "./protected-folders.ts";

// checkpoints.ts pulls in config.ts, which creates DATA_DIR at import time and
// reads MURAGE_DATA_DIR to do it — so point it at scratch before that happens,
// never at the user's real ~/.murage (same pattern as checkpoints.test.ts).
const DATA_ROOT = mkdtempSync(join(tmpdir(), "murage-protected-folders-"));
process.env.MURAGE_DATA_DIR = join(DATA_ROOT, "data");

const scratchDirs: string[] = [];
afterEach(async () => {
  clearProtectedFolderCache();
  while (scratchDirs.length > 0) await removeTempDir(scratchDirs.pop()!);
});

/** A temp directory whose path is canonical from the start — the trap an
 * earlier lane fell into is comparing against a /var alias of /private/var. */
function canonicalTemp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), prefix)));
  scratchDirs.push(dir);
  return dir;
}

function probe(platform: string, over: Partial<FolderProbe> = {}): FolderProbe {
  return {
    platform,
    env: {},
    windowsUserShellFolders: () => null,
    xdgUserDirs: () => null,
    ...over,
  };
}

/** The paths in the list, lower-cased: the module answers in whatever spelling
 * the platform gave it, and these assertions are about which folders are in it. */
function paths(result: { folders: { path: string }[] }): string[] {
  return result.folders.map((f) => f.path.toLowerCase());
}

function labelFor(result: { folders: { path: string; label: string }[] }, path: string): string | undefined {
  return result.folders.find((f) => f.path.toLowerCase() === path.toLowerCase())?.label;
}

/** `reg query` output in the exact shape Windows prints it — four-space
 * columns, a value name containing a space ("My Pictures"), and Downloads
 * carried only by its known-folder GUID. */
function regOutput(rows: ReadonlyArray<readonly [string, string]>): string {
  const head = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n";
  return head + rows.map(([name, data]) => `    ${name}    REG_EXPAND_SZ    ${data}`).join("\r\n") + "\r\n";
}

describe("Windows: the shell's own redirect targets", () => {
  const HOME = "C:\\Users\\testuser";

  // Captured verbatim from a real Windows 11 machine with OneDrive Known
  // Folder Move switched on (username replaced), then checked against
  // SHGetKnownFolderPath on that same machine: Desktop, Documents, Downloads
  // and Pictures agreed character for character. The %USERPROFILE% rows and
  // the mixed plain/redirected shape are the machine's, not an invention.
  const REAL_WORLD = regOutput([
    ["AppData", "%USERPROFILE%\\AppData\\Roaming"],
    ["Desktop", "C:\\Users\\testuser\\OneDrive\\Desktop"],
    ["Favorites", "%USERPROFILE%\\Favorites"],
    ["My Music", "%USERPROFILE%\\Music"],
    ["My Pictures", "C:\\Users\\testuser\\OneDrive\\Pictures"],
    ["Personal", "C:\\Users\\testuser\\OneDrive\\Documents"],
    ["{374DE290-123F-4565-9164-39C4925E467B}", "%USERPROFILE%\\Downloads"],
  ]);

  it("protects the OneDrive-redirected folders AND the default ones", () => {
    const result = protectedFolders(
      HOME,
      probe("win32", {
        env: { USERPROFILE: HOME, OneDrive: "C:\\Users\\testuser\\OneDrive" },
        windowsUserShellFolders: () => REAL_WORLD,
      }),
    );

    expect(result.ok).toBe(true);
    // the real locations, which homedir() + "Desktop" never names
    expect(paths(result)).toContain("c:\\users\\testuser\\onedrive\\desktop");
    expect(paths(result)).toContain("c:\\users\\testuser\\onedrive\\documents");
    expect(paths(result)).toContain("c:\\users\\testuser\\onedrive\\pictures");
    expect(labelFor(result, "C:\\Users\\testuser\\OneDrive\\Documents")).toBe("Documents");
    // %USERPROFILE% expanded, not left as a literal
    expect(paths(result)).toContain("c:\\users\\testuser\\downloads");
    expect(paths(result).some((p) => p.includes("%"))).toBe(false);
    // the sync root itself: cleaning it deletes from the cloud and every device
    expect(paths(result)).toContain("c:\\users\\testuser\\onedrive");
    // and the defaults stay, because the pre-move folder usually still has files
    for (const name of ["desktop", "documents", "downloads", "pictures"]) {
      expect(paths(result)).toContain(`c:\\users\\testuser\\${name}`);
    }
  });

  it("follows a renamed tenant folder and a move to another drive", () => {
    const result = protectedFolders(
      HOME,
      probe("win32", {
        env: { USERPROFILE: HOME, OneDriveCommercial: "C:\\Users\\testuser\\OneDrive - Contoso Ltd" },
        windowsUserShellFolders: () =>
          regOutput([
            ["Desktop", "C:\\Users\\testuser\\OneDrive - Contoso Ltd\\Desktop"],
            ["Personal", "D:\\Sync\\Contoso\\Documents"],
            ["{374DE290-123F-4565-9164-39C4925E467B}", "E:\\Downloads"],
          ]),
      }),
    );

    expect(result.ok).toBe(true);
    expect(paths(result)).toContain("c:\\users\\testuser\\onedrive - contoso ltd\\desktop");
    expect(paths(result)).toContain("d:\\sync\\contoso\\documents");
    expect(paths(result)).toContain("e:\\downloads");
    expect(paths(result)).toContain("c:\\users\\testuser\\onedrive - contoso ltd");
  });

  it("follows localized folder names, which the value names never are", () => {
    // A German install has no folder called "Documents". The registry VALUE is
    // still spelled "Personal" — that is the whole reason to read it.
    const result = protectedFolders(
      "C:\\Users\\hans",
      probe("win32", {
        env: { USERPROFILE: "C:\\Users\\hans" },
        windowsUserShellFolders: () =>
          regOutput([
            ["Desktop", "%USERPROFILE%\\Schreibtisch"],
            ["Personal", "%USERPROFILE%\\Dokumente"],
            ["{374DE290-123F-4565-9164-39C4925E467B}", "%USERPROFILE%\\Downloads"],
            ["My Pictures", "%USERPROFILE%\\Bilder"],
          ]),
      }),
    );

    expect(result.ok).toBe(true);
    expect(paths(result)).toContain("c:\\users\\hans\\dokumente");
    expect(labelFor(result, "C:\\Users\\hans\\Dokumente")).toBe("Documents");
    expect(paths(result)).toContain("c:\\users\\hans\\schreibtisch");
    expect(paths(result)).toContain("c:\\users\\hans\\bilder");
  });

  it("still protects the default locations when the lookup fails", () => {
    const result = protectedFolders(
      HOME,
      probe("win32", { env: { USERPROFILE: HOME }, windowsUserShellFolders: () => null }),
    );

    // fail safe: no registry, no OneDrive env — but never an empty list
    expect(result.ok).toBe(false);
    for (const name of ["desktop", "documents", "downloads", "pictures"]) {
      expect(paths(result)).toContain(`c:\\users\\testuser\\${name}`);
    }
  });

  it("drops a value it cannot expand rather than protecting a literal %VAR%", () => {
    const result = protectedFolders(
      HOME,
      probe("win32", {
        env: { USERPROFILE: HOME },
        windowsUserShellFolders: () =>
          regOutput([
            ["Personal", "%NOSUCHVAR%\\Documents"],
            ["Desktop", "%userprofile%\\Bureau"],
          ]),
      }),
    );

    expect(result.ok).toBe(false); // an unexpandable value is a failed lookup
    expect(paths(result).some((p) => p.includes("nosuchvar"))).toBe(false);
    expect(paths(result)).toContain("c:\\users\\testuser\\documents"); // default kept
    // environment variable names are case-insensitive on Windows
    expect(paths(result)).toContain("c:\\users\\testuser\\bureau");
  });

  it("never admits a value that is not an absolute path", () => {
    // A drive-relative or plain-relative registry value would otherwise become
    // a "protected folder" that resolves against whatever the process's cwd
    // happens to be that turn — a guard whose meaning moves is not a guard.
    const result = protectedFolders(
      HOME,
      probe("win32", {
        env: { USERPROFILE: HOME },
        windowsUserShellFolders: () =>
          regOutput([
            ["Personal", "Documents"],
            ["Desktop", "\\Desktop"],
          ]),
      }),
    );

    expect(result.folders.every((f) => /^[A-Za-z]:\\/.test(f.path))).toBe(true);
  });
});

describe("macOS: iCloud Drive and the Library", () => {
  it("protects the iCloud Desktop and Documents, iCloud Drive, and ~/Library", () => {
    const home = "/Users/testuser";
    const result = protectedFolders(home, probe("darwin"));
    const icloud = "/users/testuser/library/mobile documents/com~apple~clouddocs";

    expect(result.ok).toBe(true);
    expect(paths(result)).toContain(`${icloud}/desktop`);
    expect(paths(result)).toContain(`${icloud}/documents`);
    expect(paths(result)).toContain(icloud);
    expect(paths(result)).toContain("/users/testuser/library");
    for (const name of ["Desktop", "Documents", "Downloads", "Pictures"]) {
      expect(paths(result)).toContain(`/users/testuser/${name.toLowerCase()}`);
    }
  });
});

describe("Linux: the XDG user dirs", () => {
  const HOME = "/home/testuser";

  it("follows localized directories declared in user-dirs.dirs", () => {
    const result = protectedFolders(
      HOME,
      probe("linux", {
        xdgUserDirs: () =>
          [
            "# This file is written by xdg-user-dirs-update",
            'XDG_DESKTOP_DIR="$HOME/Schreibtisch"',
            'XDG_DOCUMENTS_DIR="${HOME}/Dokumente"',
            'XDG_DOWNLOAD_DIR="/data/testuser/Downloads"',
            'XDG_PICTURES_DIR="$HOME/Bilder"',
          ].join("\n"),
      }),
    );

    expect(result.ok).toBe(true);
    expect(paths(result)).toContain("/home/testuser/schreibtisch");
    expect(paths(result)).toContain("/home/testuser/dokumente"); // ${HOME} form too
    expect(paths(result)).toContain("/data/testuser/downloads"); // off the home tree
    expect(paths(result)).toContain("/home/testuser/bilder");
    expect(labelFor(result, "/home/testuser/Dokumente")).toBe("Documents");
    // defaults survive: user-dirs.dirs is advisory and the folders often exist
    expect(paths(result)).toContain("/home/testuser/documents");
  });

  it("prefers an exported XDG variable over the file", () => {
    const result = protectedFolders(
      HOME,
      probe("linux", {
        env: { XDG_DOCUMENTS_DIR: "/srv/papers" },
        xdgUserDirs: () => 'XDG_DOCUMENTS_DIR="$HOME/Dokumente"',
      }),
    );

    expect(paths(result)).toContain("/srv/papers");
  });

  it("falls through to the file when the exported variable is junk", () => {
    // A relative XDG_DOCUMENTS_DIR must not shadow the good entry in the file:
    // taking it and then dropping it would protect neither.
    const result = protectedFolders(
      HOME,
      probe("linux", {
        env: { XDG_DOCUMENTS_DIR: "papers" },
        xdgUserDirs: () => 'XDG_DOCUMENTS_DIR="$HOME/Dokumente"',
      }),
    );

    expect(paths(result)).toContain("/home/testuser/dokumente");
  });

  it("protects the defaults when there is no user-dirs.dirs, and ignores junk in one", () => {
    const missing = protectedFolders(HOME, probe("linux", { xdgUserDirs: () => null }));
    // A missing file is the normal case on a minimal system, not a failure.
    expect(missing.ok).toBe(true);
    expect(paths(missing)).toContain("/home/testuser/documents");

    const junk = protectedFolders(
      HOME,
      probe("linux", { xdgUserDirs: () => 'XDG_DOCUMENTS_DIR="relative/nope"\nnot an assignment' }),
    );
    expect(paths(junk)).not.toContain("relative/nope");
    expect(paths(junk)).toContain("/home/testuser/documents");
  });
});

describe("a folder that is a whole volume or a whole home", () => {
  it("refuses mount-point parents and their children, and nothing deeper", () => {
    expect(volumeRootReason("/Volumes/Work", "darwin")).not.toBeNull();
    expect(volumeRootReason("/Users/someone-else", "darwin")).not.toBeNull();
    expect(volumeRootReason("/Volumes", "darwin")).not.toBeNull();
    expect(volumeRootReason("/Volumes/Work/project", "darwin")).toBeNull();
    expect(volumeRootReason("/home/other", "linux")).not.toBeNull();
    expect(volumeRootReason("/media/testuser", "linux")).not.toBeNull();
    expect(volumeRootReason("/home/other/src", "linux")).toBeNull();
    // Windows drive roots are already caught by parse().root, so there is no
    // mount-point parent to name — and no ordinary folder may be caught here.
    expect(volumeRootReason("C:\\Users\\testuser\\src", "win32")).toBeNull();
  });
});

describe("an ordinary project folder", () => {
  it("is in nobody's protected list, on any platform", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      const home = platform === "win32" ? "C:\\Users\\testuser" : "/home/testuser";
      const result = protectedFolders(
        home,
        probe(platform, {
          env: { USERPROFILE: home },
          windowsUserShellFolders: () => regOutput([["Personal", "%USERPROFILE%\\OneDrive\\Documents"]]),
          xdgUserDirs: () => 'XDG_DOCUMENTS_DIR="$HOME/Dokumente"',
        }),
      );
      const project = platform === "win32" ? "C:\\src\\my-app" : "/srv/src/my-app";
      expect(paths(result)).not.toContain(project.toLowerCase());
      // and a sibling whose name merely starts with a protected one
      const near = platform === "win32" ? `${home}\\Documents-archive` : `${home}/Documents-archive`;
      expect(paths(result)).not.toContain(near.toLowerCase());
    }
  });
});

describe("the process cache", () => {
  it("remembers a successful lookup and refuses to remember a failed one", () => {
    const home = canonicalTemp("murage-pf-home-");

    const first = cachedProtectedFolders(home);
    const second = cachedProtectedFolders(home);
    // darwin/linux need no subprocess and cannot fail, so the answer is kept
    expect(second).toBe(first);

    // Stub a platform whose lookup cannot succeed here (`reg` is not on this
    // box), and the answer must NOT be pinned: a cache that remembered the
    // degraded list would protect less for the rest of the session.
    clearProtectedFolderCache();
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const failedOnce = cachedProtectedFolders(home);
      const failedTwice = cachedProtectedFolders(home);
      expect(failedTwice).not.toBe(failedOnce);
      expect(failedTwice.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
    }
  });
});

describe("refusalReason, end to end through a real lookup", () => {
  // The Linux branch reads a real file, so this exercises discovery, symlink
  // resolution and the refusal message together — the Windows branch is
  // covered above against output captured from a real Windows box.
  it("refuses a localized XDG folder that the English list would have allowed", async () => {
    const realPlatform = process.platform;
    const realHome = process.env.HOME;
    const realConfig = process.env.XDG_CONFIG_HOME;
    const home = canonicalTemp("murage-pf-xdg-home-");
    const config = join(home, ".config");
    mkdirSync(config);
    mkdirSync(join(home, "Dokumente"));
    const project = join(home, "Dokumente-archiv");
    mkdirSync(project);
    writeFileSync(join(config, "user-dirs.dirs"), 'XDG_DOCUMENTS_DIR="$HOME/Dokumente"\n');

    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = config;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    clearProtectedFolderCache();
    try {
      const { refusalReason } = await import("./checkpoints.ts");
      expect(refusalReason(join(home, "Dokumente"))).toBe(
        "checkpoints are not taken in the Documents folder",
      );
      expect(refusalReason(join(home, "Dokumente") + sep)).toBe(
        "checkpoints are not taken in the Documents folder",
      );
      // the user's own project, whose name merely starts the same way, is fine
      expect(refusalReason(project)).toBeNull();
      // and the English default is still refused alongside it, because a
      // user-dirs.dirs entry does not mean the old folder was emptied
      mkdirSync(join(home, "Documents"));
      expect(refusalReason(join(home, "Documents"))).toBe(
        "checkpoints are not taken in the Documents folder",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      if (realConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = realConfig;
      clearProtectedFolderCache();
    }
  });

  // The mount-point rule has to be wired into refusalReason, not just correct
  // in isolation. It can only be exercised against a directory of mount points
  // that actually exists, so this asserts on whichever one the host has — and
  // reports rather than passes silently if it has none.
  it("refuses a whole volume or another user's home on this host", async () => {
    const { refusalReason } = await import("./checkpoints.ts");
    const parents = process.platform === "darwin" ? ["/Volumes", "/Users"] : ["/home", "/media", "/mnt"];
    const present = parents.filter((p) => existsSync(p));
    if (present.length === 0) {
      expect(process.platform).toBe("win32"); // the only platform with no such parent
      return;
    }
    for (const parent of present) {
      expect(refusalReason(parent)).toBe("checkpoints are not taken in a folder of mount points");
      const children = readdirSync(parent).filter((name) => {
        try {
          return statSync(join(parent, name)).isDirectory();
        } catch {
          return false; // an unreadable or vanished mount is not the subject here
        }
      });
      for (const child of children.slice(0, 3)) {
        const full = join(parent, child);
        // $HOME itself answers with the home-folder refusal, which fires first
        expect(refusalReason(full)).not.toBeNull();
      }
    }
  });
});
