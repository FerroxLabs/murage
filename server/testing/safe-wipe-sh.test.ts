// scripts/safe-wipe.sh is the shell twin of safe-wipe.mjs. This test drives
// it the way a script would (source, then safe_wipe <path>) so the shell
// policy cannot drift from the JavaScript one. Every refusal probe that names
// a real location names a child of it that does not exist, so a regression in
// the script would make the underlying `rm -rf` a no-op, never a wipe.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dataDirLeasePaths } from "../../electron/data-dir-lease.mjs";
import { safeWipeSync } from "./safe-wipe.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "safe-wipe.sh");
// A home outside every temp root. It never exists, so an `rm -rf` of it or
// of anything below it would be a no-op even if the script admitted it.
const FAKE_HOME = "/nonexistent-safe-wipe-sh-4c1d/home";
const REAL_HOME = userInfo().homedir;
const REAL_PROBE = join(REAL_HOME, ".murage", `safe-wipe-sh-probe-does-not-exist-${process.pid}`);

let scratch: string;

type Run = { status: number | null; stderr: string; stdout: string };
/** `safe_wipe <target>` in a fresh bash with the given environment. */
const wipe = (target: string, env: Record<string, string | undefined> = {}, cwd = scratch): Run => {
  const { HOME = FAKE_HOME, ...rest } = env;
  const result = spawnSync("bash", ["-c", 'source "$0" && safe_wipe "$1"', SCRIPT, target], {
    cwd,
    env: { PATH: process.env.PATH, HOME, TMPDIR: tmpdir(), ...rest },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
};
const refuses = (target: string, reason: RegExp, env: Record<string, string | undefined> = {}, cwd?: string) => {
  const run = wipe(target, env, cwd);
  expect(run.status, run.stderr).toBe(2);
  expect(run.stderr).toMatch(/^safe-wipe REFUSED to delete /);
  expect(run.stderr).toMatch(reason);
};

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-safe-wipe-sh-")));
  expect(existsSync(FAKE_HOME)).toBe(false);
  expect(existsSync(REAL_PROBE)).toBe(false);
});
afterAll(() => { safeWipeSync(scratch); });

describe("scripts/safe-wipe.sh refuses", () => {
  it("the faked home's data dirs, the home, and its parents", () => {
    refuses(join(FAKE_HOME, ".murage"), /Murage data directory/);
    refuses(join(FAKE_HOME, ".murage", "workspaces", "bot"), /Murage data directory/);
    refuses(join(FAKE_HOME, ".opengrokbot"), /Murage data directory/);
    refuses(join(FAKE_HOME, ".murage-companion"), /Murage data directory/);
    refuses(FAKE_HOME, /home directory/);
    refuses(dirname(FAKE_HOME), /home directory/);
  });

  it("the account's real data dir even when HOME is faked (assert on a nonexistent child)", () => {
    refuses(REAL_PROBE, /Murage data directory/);
    refuses(REAL_HOME, /home directory/);
    refuses(dirname(REAL_HOME), /home directory/);
  });

  it("the account's data dir when TMPDIR is misconfigured to cover the home", () => {
    for (const TMPDIR of [REAL_HOME, dirname(REAL_HOME), join(REAL_HOME, ".murage")]) {
      refuses(REAL_PROBE, /Murage data directory|home directory/, { TMPDIR });
      refuses(REAL_HOME, /home directory/, { TMPDIR });
    }
    // HOME == TMPDIR is not a throwaway home either.
    refuses(join(FAKE_HOME, ".murage"), /Murage data directory/, { TMPDIR: FAKE_HOME });
  });

  it("the working directory, its parents, filesystem roots and an unmarked path", () => {
    refuses(scratch, /working directory/);
    refuses(dirname(scratch), /working directory/);
    refuses("/", /filesystem root/);
    refuses("/srv/x-does-not-exist", /not under the OS temp directory/);
    const run = wipe("");
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/empty path/);
  });

  it("a MURAGE_DATA_DIR inherited from the environment that is not scratch, and its parents", () => {
    const MURAGE_DATA_DIR = "/srv/murage-does-not-exist/live-data";
    refuses(MURAGE_DATA_DIR, /MURAGE_DATA_DIR/, { MURAGE_DATA_DIR });
    refuses(dirname(MURAGE_DATA_DIR), /MURAGE_DATA_DIR/, { MURAGE_DATA_DIR });
    refuses(join(MURAGE_DATA_DIR, "workspaces"), /MURAGE_DATA_DIR/, { MURAGE_DATA_DIR });
  });

  it("a directory another live process holds an installation lease on, beside or inside it", () => {
    const held = join(scratch, "held"); mkdirSync(join(held, "data", "inner"), { recursive: true });
    const marker = join(held, "data", "messages.db"); writeFileSync(marker, "marker");
    // This vitest worker is the live foreign owner from bash's point of view.
    const { leasePath } = dataDirLeasePaths(join(held, "data"));
    writeFileSync(leasePath, `${JSON.stringify({ version: 1, pid: process.pid, host: hostname(), token: "0".repeat(64), createdAt: Date.now() })}\n`);
    refuses(join(held, "data"), /live installation lease/);
    refuses(held, /live installation lease/);
    expect(existsSync(marker)).toBe(true);
    // A lease naming a dead pid admits the wipe.
    writeFileSync(leasePath, `${JSON.stringify({ version: 1, pid: 2 ** 31 - 7, host: hostname(), token: "0".repeat(64), createdAt: Date.now() })}\n`);
    const run = wipe(join(held, "data"));
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("a symlink under scratch that points at a protected directory", () => {
    const link = join(scratch, "link-scratch");
    spawnSync("ln", ["-s", join(FAKE_HOME, ".murage"), link]);
    refuses(link, /Murage data directory/);
  });

  it("SAFE_WIPE_WITHIN that names a root or a home, or a target outside it", () => {
    refuses("/srv/builds-does-not-exist/out", /filesystem root/, { SAFE_WIPE_WITHIN: "/" });
    refuses(join(FAKE_HOME, "dist"), /home directory/, { SAFE_WIPE_WITHIN: FAKE_HOME });
    refuses("/srv/other-does-not-exist/out", /not strictly inside/, { SAFE_WIPE_WITHIN: "/srv/builds-does-not-exist" });
  });
});

describe("scripts/safe-wipe.sh admits", () => {
  it("a directory under the OS temp dir and deletes it, tolerating a missing one", () => {
    const dir = join(scratch, "ok"); mkdirSync(join(dir, "deep"), { recursive: true }); writeFileSync(join(dir, "deep", "f"), "x");
    expect(wipe(dir).status).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(wipe(dir).status).toBe(0);
  });

  it("a nonexistent build output strictly inside SAFE_WIPE_WITHIN", () => {
    const out = "/srv/builds-does-not-exist/out";
    expect(existsSync(out)).toBe(false);
    const run = wipe(out, { SAFE_WIPE_WITHIN: "/srv/builds-does-not-exist" });
    expect(run.status, run.stderr).toBe(0);
  });

  it("a faked HOME strictly inside the temp dir (a test runner's throwaway home)", () => {
    const home = join(scratch, "home"); mkdirSync(join(home, ".murage"), { recursive: true });
    const run = wipe(join(home, ".murage"), { HOME: home });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(home, ".murage"))).toBe(false);
  });
});
