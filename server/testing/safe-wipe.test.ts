// The one recursive delete tests may use, and what it refuses. Every refusal
// case here is a path the 2026-09-11 21:05 incident class could have produced:
// a data dir computed from an unset env var, a faked HOME, a path that
// contains the real installation, a directory another Murage is using.
import { spawn, type ChildProcess } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dataDirLeasePaths } from "../../electron/data-dir-lease.mjs";
import { waitForExit } from "./cleanup.ts";
import { assertNotProtected, assertSafeToWipe, canonicalPath, installSafeWipeGuard, SafeWipeRefused, safeWipe, safeWipeSync } from "./safe-wipe.mjs";

// A home that is NOT under the OS temp dir, so the data-dir rules apply to
// it the way they apply to a real account. It never has to exist.
const FAKE_HOME = "/nonexistent-safe-wipe-7f3a/home";
const opts = { homedir: FAKE_HOME };

let scratch: string;
let leaseHolder: ChildProcess | undefined;

const writeLease = (dataDir: string, pid: number) => {
  const { leasePath } = dataDirLeasePaths(dataDir);
  writeFileSync(leasePath, `${JSON.stringify({ version: 1, pid, host: hostname(), token: "00000000-0000-4000-8000-000000000000", createdAt: Date.now() })}\n`, { mode: 0o600 });
  return leasePath;
};

const refuses = (target: string, reason: RegExp, options: Parameters<typeof assertSafeToWipe>[1] = opts) => {
  let error: unknown;
  try { assertSafeToWipe(target, options); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(SafeWipeRefused);
  expect((error as SafeWipeRefused).message).toMatch(reason);
  expect((error as SafeWipeRefused).message).toContain("Nothing was deleted");
};

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-safe-wipe-")));
  // A live foreign lease owner: a real process that is not this one.
  leaseHolder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
});

afterAll(async () => {
  await waitForExit(leaseHolder, { signal: "SIGTERM" });
  rmSync(scratch, { recursive: true, force: true });
});

describe("assertSafeToWipe admits", () => {
  it("a directory under the OS temp dir, existing or not", () => {
    const dir = join(scratch, "fixture"); mkdirSync(dir);
    expect(assertSafeToWipe(dir, opts)).toEqual({ path: dir, admitted: "tmpdir" });
    expect(assertSafeToWipe(join(scratch, "never-created"), opts).admitted).toBe("tmpdir");
  });

  it("a path marked scratch, evidence or .e2e by a segment", () => {
    for (const p of ["/Volumes/Work/lanes/.e2e/LANE1", "/srv/ci/murage-scratch/e2e", "/srv/ci/run/evidence-CLAC1/data"]) {
      expect(assertSafeToWipe(p, opts).admitted).toBe("scratch-segment");
    }
  });

  it("a build output strictly inside a caller-named root, and nothing else there", () => {
    const repo = join(scratch, "repo"); mkdirSync(join(repo, "dist"), { recursive: true });
    expect(assertSafeToWipe(join(repo, "dist"), { ...opts, within: repo, tmpdir: "/nonexistent-tmp" }).admitted).toBe("within");
    refuses(repo, /not strictly inside/, { ...opts, within: repo, tmpdir: "/nonexistent-tmp" });
    refuses("/srv/elsewhere/dist", /not strictly inside/, { ...opts, within: repo, tmpdir: "/nonexistent-tmp" });
    refuses(join(FAKE_HOME, "dist"), /home directory/, { ...opts, within: FAKE_HOME, tmpdir: "/nonexistent-tmp" });
  });

  it("a directory whose only lease is dead or the caller's own", () => {
    const dead = join(scratch, "dead-owner", "data"); mkdirSync(dead, { recursive: true });
    writeLease(dead, 2_147_483_000);
    expect(assertSafeToWipe(dead, opts).admitted).toBe("tmpdir");
    const own = join(scratch, "own-owner", "data"); mkdirSync(own, { recursive: true });
    writeLease(own, process.pid);
    expect(assertSafeToWipe(own, opts).admitted).toBe("tmpdir");
    expect(assertSafeToWipe(dirname(own), opts).admitted).toBe("tmpdir");
  });
});

describe("assertSafeToWipe refuses", () => {
  it("the default data dir, anything inside it, and any parent of it", () => {
    refuses(join(FAKE_HOME, ".murage"), /Murage data directory/);
    refuses(join(FAKE_HOME, ".murage", "workspaces", "bot"), /Murage data directory/);
    refuses(FAKE_HOME, /home directory/);
    refuses(dirname(FAKE_HOME), /home directory/);
    refuses(join(FAKE_HOME, ".opengrokbot"), /Murage data directory/);
    refuses(join(FAKE_HOME, ".murage-companion"), /Murage data directory/);
  });

  it("the account's real data dir even when HOME is faked (vitest fakes HOME)", () => {
    const real = userInfo().homedir;
    expect(process.env.HOME).not.toBe(real);
    refuses(join(real, ".murage"), /Murage data directory|home directory/, {});
    refuses(real, /home directory/, {});
    refuses(dirname(real), /home directory/, {});
  });

  it("a MURAGE_DATA_DIR inherited from the environment that is not scratch", () => {
    const env = { MURAGE_DATA_DIR: "/srv/murage/live-data" };
    refuses("/srv/murage/live-data", /MURAGE_DATA_DIR/, { ...opts, env });
    refuses("/srv/murage", /MURAGE_DATA_DIR/, { ...opts, env });
    refuses("/srv/murage/live-data/events", /MURAGE_DATA_DIR/, { ...opts, env });
    // ...but a scratch MURAGE_DATA_DIR is the thing the caller is allowed to wipe.
    expect(assertSafeToWipe("/srv/lanes/.e2e/L1", { ...opts, env: { MURAGE_DATA_DIR: "/srv/lanes/.e2e/L1" } }).admitted).toBe("scratch-segment");
  });

  it("the working directory, its parents, and filesystem roots", () => {
    refuses(process.cwd(), /working directory/);
    refuses(dirname(process.cwd()), /working directory/);
    refuses("/", /filesystem root/);
    refuses("", /empty/);
    refuses("evil\npath", /control characters/);
  });

  it("a directory another live process holds an installation lease on", () => {
    const pid = leaseHolder!.pid!;
    const held = join(scratch, "held", "data"); mkdirSync(held, { recursive: true });
    const lease = writeLease(held, pid);
    refuses(held, new RegExp(`live process ${pid}`));
    // The parent contains the lease file itself: still refused.
    refuses(dirname(held), new RegExp(`live process ${pid}`));
    // Two levels up as well (the scan looks three directories deep).
    refuses(scratch, new RegExp(`live process ${pid}`));
    expect(existsSync(lease)).toBe(true);
    rmSync(lease);
  });

  it("an unreadable or foreign-host lease record outside the temp dir, because a dead owner cannot be proven", () => {
    // Pretend the OS temp dir is elsewhere, so this fixture counts as a real
    // location; a scratch segment still admits it up to the lease rule.
    const outside = { ...opts, tmpdir: "/nonexistent-tmp" };
    const odd = join(scratch, "scratch-odd", "data"); mkdirSync(odd, { recursive: true });
    writeFileSync(dataDirLeasePaths(odd).leasePath, "not json");
    refuses(odd, /unreadable lease record/, outside);
    const foreign = join(scratch, "scratch-foreign", "data"); mkdirSync(foreign, { recursive: true });
    writeFileSync(dataDirLeasePaths(foreign).leasePath, JSON.stringify({ version: 1, pid: 1, host: "elsewhere.invalid" }));
    refuses(foreign, /another host/, outside);
    // Under the real temp dir the same records do not block: fixtures plant
    // them on purpose, and only a live local owner proves an installation.
    expect(assertSafeToWipe(odd, opts).admitted).toBe("tmpdir");
    expect(assertSafeToWipe(foreign, opts).admitted).toBe("tmpdir");
  });

  it("a scratch-looking symlink that points at a protected directory, existing or not", () => {
    const link = join(scratch, "link-scratch");
    symlinkSync(join(userInfo().homedir, ".murage"), link);
    expect(canonicalPath(link)).toBe(canonicalPath(join(userInfo().homedir, ".murage")));
    refuses(link, /Murage data directory|home directory/, {});
    // Dangling: the target does not exist (CI has no ~/.murage), and a link
    // to a path under a fake home outside tmp is still judged by its target.
    const dangling = join(scratch, "link-dangling");
    symlinkSync(join(FAKE_HOME, ".murage", "workspaces"), dangling);
    expect(canonicalPath(dangling)).toBe(join(FAKE_HOME, ".murage", "workspaces"));
    refuses(dangling, /Murage data directory/);
    // A link to a link, and a relative link, resolve the same way.
    const hop = join(scratch, "link-hop"); symlinkSync("link-dangling", hop);
    refuses(hop, /Murage data directory/);
  });

  it("does not delete on refusal", () => {
    const marker = join(scratch, "held2", "data", "messages.db"); mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "marker");
    const lease = writeLease(dirname(marker), leaseHolder!.pid!);
    expect(() => safeWipeSync(dirname(marker), opts)).toThrow(SafeWipeRefused);
    expect(existsSync(marker)).toBe(true);
    rmSync(lease);
  });
});

describe("safeWipeSync and safeWipe", () => {
  it("delete an admitted directory and tolerate a missing one", async () => {
    const a = join(scratch, "a"); mkdirSync(join(a, "deep"), { recursive: true }); writeFileSync(join(a, "deep", "f"), "x");
    expect(safeWipeSync(a, opts)).toBe(a);
    expect(existsSync(a)).toBe(false);
    expect(safeWipeSync(a, opts)).toBe(a);
    const b = join(scratch, "b"); mkdirSync(b);
    expect(await safeWipe(b, opts)).toBe(b);
    expect(existsSync(b)).toBe(false);
  });
});

describe("installSafeWipeGuard", () => {
  it("makes recursive fs deletes refuse protected paths, named imports included, and leaves other deletes alone", async () => {
    // setup.ts already installed the guard for this process; a second install is a no-op.
    expect(installSafeWipeGuard()).toBe(false);
    const target = join(userInfo().homedir, ".murage");
    expect(() => rmSync(target, { recursive: true, force: true })).toThrow(SafeWipeRefused);
    expect(() => fs.rmSync(target, { recursive: true, force: true })).toThrow(SafeWipeRefused);
    await expect(rm(target, { recursive: true, force: true })).rejects.toBeInstanceOf(SafeWipeRefused);
    await expect(fs.promises.rm(target, { recursive: true, force: true })).rejects.toBeInstanceOf(SafeWipeRefused);
    await expect(new Promise((resolve, reject) => fs.rm(target, { recursive: true, force: true }, (e) => e ? reject(e) : resolve(null)))).rejects.toBeInstanceOf(SafeWipeRefused);
    expect(existsSync(target) || true).toBe(true);
    // Non-recursive deletes of ordinary files are untouched.
    const file = join(scratch, "plain.txt"); writeFileSync(file, "x");
    rmSync(file, { force: true });
    expect(existsSync(file)).toBe(false);
    // Recursive deletes of temp fixtures still work.
    const dir = join(scratch, "guarded-ok"); mkdirSync(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
    expect(basename(scratch)).toMatch(/^murage-safe-wipe-/);
  });

  it("assertNotProtected admits an ordinary non-scratch path (deny-only)", () => {
    expect(() => assertNotProtected("/srv/builds/out", opts)).not.toThrow();
    expect(() => assertNotProtected(join(FAKE_HOME, ".murage"), opts)).toThrow(SafeWipeRefused);
  });
});
