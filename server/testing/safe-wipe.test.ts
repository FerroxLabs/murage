// The one recursive delete tests may use, and what it refuses. Every refusal
// case here is a path the 2026-09-11 21:05 incident class could have produced:
// a data dir computed from an unset env var, a faked HOME, a path that
// contains the real installation, a directory another Murage is using.
import { spawn, type ChildProcess } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dataDirLeasePaths } from "../../electron/data-dir-lease.mjs";
import { waitForExit } from "./cleanup.ts";
import { assertNotProtected, assertSafeToWipe, canonicalPath, installSafeWipeGuard, SafeWipeRefused, safeWipe, safeWipeSync, wipeTargetPath } from "./safe-wipe.mjs";

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

  // The real home is refused as a home directory, or — on a runner whose
  // checkout sits inside $HOME (GitHub Actions: /home/runner/work/...) — by
  // the working-directory rule, which is checked first. Either way nothing
  // is deleted; the pin accepts both reasons so the test is not tied to
  // where the checkout lives.
  const REAL_HOME_REASON = /home directory|working directory/;

  it("the account's real data dir even when HOME is faked (vitest fakes HOME)", () => {
    const real = userInfo().homedir;
    expect(process.env.HOME).not.toBe(real);
    refuses(join(real, ".murage"), /Murage data directory|home directory|working directory/, {});
    refuses(real, REAL_HOME_REASON, {});
    refuses(dirname(real), REAL_HOME_REASON, {});
  });

  it("the account's data dir when TMPDIR is misconfigured to cover the home (never disposable)", () => {
    const real = userInfo().homedir;
    const probe = join(real, ".murage", "safe-wipe-probe-does-not-exist");
    for (const tmp of [real, dirname(real), join(real, ".murage")]) {
      refuses(join(real, ".murage"), /Murage data directory|home directory|working directory/, { tmpdir: tmp });
      refuses(probe, /Murage data directory|home directory|working directory/, { tmpdir: tmp });
      refuses(real, REAL_HOME_REASON, { tmpdir: tmp });
      refuses(dirname(real), REAL_HOME_REASON, { tmpdir: tmp });
    }
  });

  it("a faked HOME that equals the temp dir, while a HOME strictly inside the temp dir stays disposable", () => {
    // HOME == TMPDIR is not a throwaway home (TMPDIR=$HOME misconfiguration).
    refuses(join(FAKE_HOME, ".murage"), /Murage data directory/, { homedir: FAKE_HOME, tmpdir: FAKE_HOME });
    refuses(FAKE_HOME, /home directory/, { homedir: FAKE_HOME, tmpdir: FAKE_HOME });
    // HOME strictly inside TMPDIR is the vitest shape: its data dir is disposable.
    expect(assertSafeToWipe(join(FAKE_HOME, ".murage"), { homedir: FAKE_HOME, tmpdir: dirname(FAKE_HOME) }).admitted).toBe("tmpdir");
    // vitest's own faked HOME (mkdtemp under the OS temp dir) is admitted as-is.
    expect(process.env.HOME).not.toBe(userInfo().homedir);
    expect(assertSafeToWipe(join(process.env.HOME!, ".murage")).admitted).toBe("tmpdir");
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
    // The real installation itself is checked assert-only: no fs call ever
    // names it, so a regression in the guard cannot turn this test into the
    // 21:05 incident on a developer's machine.
    const realDataDir = join(userInfo().homedir, ".murage");
    // Reason may be the working-directory rule on a runner whose checkout sits inside $HOME.
    expect(() => assertNotProtected(realDataDir)).toThrow(/Murage data directory|home directory|working directory/);
    expect(() => assertNotProtected(userInfo().homedir)).toThrow(/home directory|working directory/);
    // The live-fire probes name a child of the real data dir that does not
    // exist: the same "lies inside the Murage data directory" rule refuses it,
    // and with force:true a guard that failed to refuse would be a no-op.
    const target = join(realDataDir, `safe-wipe-guard-probe-does-not-exist-${process.pid}-${Date.now().toString(36)}`);
    expect(existsSync(target)).toBe(false);
    expect(() => assertNotProtected(target)).toThrow(/lies inside the Murage data directory/);
    expect(() => rmSync(target, { recursive: true, force: true })).toThrow(SafeWipeRefused);
    expect(() => fs.rmSync(target, { recursive: true, force: true })).toThrow(SafeWipeRefused);
    await expect(rm(target, { recursive: true, force: true })).rejects.toBeInstanceOf(SafeWipeRefused);
    await expect(fs.promises.rm(target, { recursive: true, force: true })).rejects.toBeInstanceOf(SafeWipeRefused);
    await expect(new Promise((resolve, reject) => fs.rm(target, { recursive: true, force: true }, (e) => e ? reject(e) : resolve(null)))).rejects.toBeInstanceOf(SafeWipeRefused);
    // The throwaway HOME vitest fakes (mkdtemp under the OS temp dir) stays
    // disposable under the guard; the probe is a nonexistent child, a no-op.
    expect(process.env.HOME).not.toBe(userInfo().homedir);
    expect(() => rmSync(join(process.env.HOME!, ".murage", "safe-wipe-guard-probe-does-not-exist"), { recursive: true, force: true })).not.toThrow();
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

  it("judges a URL or Buffer target by the path it names, not by String(target) (FOLLOW7)", () => {
    // fs accepts file: URLs and Buffers. String(url) is "file:///..." which
    // resolves to a nonexistent path under the checkout and is judged
    // unprotected, so a URL used to walk straight past the guard. The probe
    // is a nonexistent child of the fake home's data dir: never the real one.
    const probe = join(FAKE_HOME, ".murage", "safe-wipe-url-probe-does-not-exist");
    expect(wipeTargetPath(pathToFileURL(probe))).toBe(probe);
    expect(wipeTargetPath(Buffer.from(probe))).toBe(probe);
    expect(wipeTargetPath(probe)).toBe(probe);
    expect(() => assertNotProtected(wipeTargetPath(pathToFileURL(probe)), opts)).toThrow(/lies inside the Murage data directory/);
    expect(() => assertNotProtected(wipeTargetPath(Buffer.from(probe)), opts)).toThrow(/lies inside the Murage data directory/);
    expect(() => assertNotProtected(String(pathToFileURL(probe)), opts)).not.toThrow();
  });

  it("judges a URL-like object the way node:fs does: by its pathname, not String(target) (FOLLOW7)", () => {
    // fs does not require `instanceof URL`: toPathIfFileURL duck-types any
    // object with a truthy href and protocol (and no legacy url.parse
    // `auth`/`path`), then fileURLToPath reads its hostname and pathname.
    // So a cross-realm URL or a hand-rolled object reaches the original
    // rmSync while a guard that only knew `instanceof URL` judged
    // String(obj) = "[object Object]" under cwd and let it through. The
    // probe is a nonexistent child of the fake home's data dir, never the
    // real one.
    const probe = join(FAKE_HOME, ".murage", "safe-wipe-ducktype-probe-does-not-exist");
    const real = pathToFileURL(probe);
    const duck = { href: real.href, protocol: "file:", hostname: "", pathname: real.pathname };
    expect(duck instanceof URL).toBe(false);
    expect(wipeTargetPath(duck)).toBe(probe);
    expect(() => assertNotProtected(wipeTargetPath(duck), opts)).toThrow(/lies inside the Murage data directory/);
    // Node deletes the object's pathname, so an href that names a scratch
    // path must not launder a protected pathname.
    const decoy = { ...duck, href: pathToFileURL(join(scratch, "decoy")).href };
    expect(wipeTargetPath(decoy)).toBe(probe);
    expect(() => assertNotProtected(wipeTargetPath(decoy), opts)).toThrow(/lies inside the Murage data directory/);
    // fs's test is `href && protocol` (truthy, any type), not "string href":
    // fileURLToPath reads only hostname and pathname, so a numeric, boolean,
    // object or Buffer href over a protected pathname is still deleted by
    // raw fs and must be judged by that pathname, not "[object Object]".
    for (const href of [1, true, {}, Buffer.from("x")]) {
      const oddHref = { href, protocol: "file:", hostname: "", pathname: real.pathname };
      expect(wipeTargetPath(oddHref)).toBe(probe);
      expect(() => assertNotProtected(wipeTargetPath(oddHref), opts)).toThrow(/lies inside the Murage data directory/);
    }
    // fs applies no type gate at all: getValidatedPath hands the raw
    // argument to toPathIfFileURL, whose isURL is only `self?.href &&
    // self.protocol && auth === undefined && path === undefined`. A function
    // carrying those properties is therefore a URL to fs, and raw rmSync
    // deletes its pathname, while a guard that also required `typeof target
    // === "object"` judged String(fn) ("function decoy() {}"), a nonexistent
    // path under cwd, and let it through (LOCALE1 verifier, shape probe).
    const fn = Object.assign(function decoy() {}, { href: real.href, protocol: "file:", hostname: "", pathname: real.pathname });
    expect(typeof fn).toBe("function");
    expect(wipeTargetPath(fn)).toBe(probe);
    expect(() => assertNotProtected(wipeTargetPath(fn), opts)).toThrow(/lies inside the Murage data directory/);
    const oddHrefFn = Object.assign(function decoy() {}, { href: 1, protocol: "file:", hostname: "", pathname: real.pathname });
    expect(wipeTargetPath(oddHrefFn)).toBe(probe);
    // Shapes node:fs does not treat as URLs keep the string fallback: a
    // legacy url.parse object (`auth` or `path` defined), a falsy href or
    // protocol, and a non-file scheme (fs itself then throws
    // ERR_INVALID_URL_SCHEME before deleting anything).
    expect(wipeTargetPath({ ...duck, path: real.pathname })).toBe("[object Object]");
    expect(wipeTargetPath({ ...duck, auth: null })).toBe("[object Object]");
    expect(wipeTargetPath({ ...duck, href: "" })).toBe("[object Object]");
    expect(wipeTargetPath({ ...duck, href: 0 })).toBe("[object Object]");
    expect(wipeTargetPath({ ...duck, protocol: "" })).toBe("[object Object]");
    expect(wipeTargetPath({ href: "https://example.com/x", protocol: "https:" })).toBe("https://example.com/x");
  });

  it("refuses a recursive delete aimed by a URL-like object at a directory another process leases (FOLLOW7)", async () => {
    // Live fire through the installed guard, at a temp fixture (never a real
    // location) that a real child process leases. A guard that only knew
    // `instanceof URL` judged "[object Object]" and let the original rmSync
    // delete the fixture and the marker.
    const held = join(scratch, "held-duck", "data"); mkdirSync(held, { recursive: true });
    const marker = join(held, "messages.db"); writeFileSync(marker, "marker");
    const lease = writeLease(held, leaseHolder!.pid!);
    const free = join(scratch, "held-duck", "free"); mkdirSync(free, { recursive: true });
    const heldUrl = pathToFileURL(held);
    const freeUrl = pathToFileURL(free);
    // PathLike is typed string | Buffer | URL; the runtime accepts this
    // shape anyway, which is the whole point.
    const duckLike = (fields: Partial<URL>) => ({ href: heldUrl.href, protocol: "file:", hostname: "", pathname: heldUrl.pathname, ...fields }) as unknown as URL;
    const duck = duckLike({});
    expect(() => fs.rmSync(duck, { recursive: true, force: true })).toThrow(SafeWipeRefused);
    await expect(fs.promises.rm(duck, { recursive: true, force: true })).rejects.toBeInstanceOf(SafeWipeRefused);
    await expect(new Promise((resolve, reject) => fs.rm(duck, { recursive: true, force: true }, (e) => e ? reject(e) : resolve(null)))).rejects.toBeInstanceOf(SafeWipeRefused);
    // fs deletes the pathname, so a scratch href cannot launder a leased pathname...
    expect(() => fs.rmSync(duckLike({ href: freeUrl.href }), { recursive: true, force: true })).toThrow(SafeWipeRefused);
    expect(existsSync(marker)).toBe(true);
    // ...nor can a truthy non-string href, which fs accepts just the same
    // (its test is `href && protocol`, and fileURLToPath never reads href).
    for (const href of [1, true, {}, Buffer.from("x")] as unknown[] as string[]) {
      expect(() => fs.rmSync(duckLike({ href }), { recursive: true, force: true })).toThrow(SafeWipeRefused);
      await expect(fs.promises.rm(duckLike({ href }), { recursive: true, force: true })).rejects.toBeInstanceOf(SafeWipeRefused);
      expect(existsSync(marker)).toBe(true);
    }
    // ...nor can the shape be a function: fs's isURL has no type gate, so a
    // function with href/protocol/pathname reaches the real delete just like
    // an object does, and a guard that only knew `typeof === "object"`
    // judged String(fn) and let it delete the leased fixture.
    const fnLike = (fields: Partial<URL>) => Object.assign(function decoy() {}, { href: heldUrl.href, protocol: "file:", hostname: "", pathname: heldUrl.pathname, ...fields }) as unknown as URL;
    expect(() => fs.rmSync(fnLike({}), { recursive: true, force: true })).toThrow(SafeWipeRefused);
    expect(() => fs.rmSync(fnLike({ href: freeUrl.href }), { recursive: true, force: true })).toThrow(SafeWipeRefused);
    await expect(fs.promises.rm(fnLike({}), { recursive: true, force: true })).rejects.toBeInstanceOf(SafeWipeRefused);
    await expect(new Promise((resolve, reject) => fs.rm(fnLike({}), { recursive: true, force: true }, (e) => e ? reject(e) : resolve(null)))).rejects.toBeInstanceOf(SafeWipeRefused);
    expect(existsSync(marker)).toBe(true);
    // ...and a leased href over a free pathname is the ordinary temp delete
    // fs would perform: judged by the pathname, admitted, and only `free` goes.
    fs.rmSync(duckLike({ pathname: freeUrl.pathname }), { recursive: true, force: true });
    expect(existsSync(free)).toBe(false);
    expect(existsSync(marker)).toBe(true);
    // The same for the function shape (fs deletes `fnFree`, and nothing else).
    const fnFree = join(scratch, "held-duck", "fn-free"); mkdirSync(fnFree, { recursive: true });
    fs.rmSync(fnLike({ pathname: pathToFileURL(fnFree).pathname }), { recursive: true, force: true });
    expect(existsSync(fnFree)).toBe(false);
    expect(existsSync(marker)).toBe(true);
    rmSync(lease);
    fs.rmSync(duck, { recursive: true, force: true });
    expect(existsSync(held)).toBe(false);
  });

  it("refuses a recursive delete aimed by URL or Buffer at a directory another process leases (FOLLOW7)", async () => {
    // Live fire through the installed guard, at a temp fixture (never a real
    // location): the lease names the real child process spawned above, so
    // the deny rules refuse it however the path is spelled. A guard that
    // still judged String(url) would delete the fixture and the marker.
    const held = join(scratch, "held-url", "data"); mkdirSync(held, { recursive: true });
    const marker = join(held, "messages.db"); writeFileSync(marker, "marker");
    const lease = writeLease(held, leaseHolder!.pid!);
    const url = pathToFileURL(held);
    expect(() => fs.rmSync(url, { recursive: true, force: true })).toThrow(SafeWipeRefused);
    expect(() => fs.rmSync(Buffer.from(held), { recursive: true, force: true })).toThrow(SafeWipeRefused);
    await expect(fs.promises.rm(url, { recursive: true, force: true })).rejects.toBeInstanceOf(SafeWipeRefused);
    await expect(new Promise((resolve, reject) => fs.rm(url, { recursive: true, force: true }, (e) => e ? reject(e) : resolve(null)))).rejects.toBeInstanceOf(SafeWipeRefused);
    expect(existsSync(marker)).toBe(true);
    rmSync(lease);
    // Once the lease is gone the same URL is an ordinary temp delete.
    fs.rmSync(url, { recursive: true, force: true });
    expect(existsSync(held)).toBe(false);
  });
});
