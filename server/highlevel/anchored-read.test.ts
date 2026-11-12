import { removeTempDirSync } from "../testing/cleanup.ts";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
const modulePath = "./anchored-read.ts";
const helper = await import(/* @vite-ignore */ modulePath).catch(() => ({})) as Partial<typeof import("./anchored-read.ts")>;
const roots: string[] = [];
function fixture() {
  const base = fs.mkdtempSync(join(tmpdir(), "anchored-fixture-")); roots.push(base);
  const root = join(base, "workspace"); fs.mkdirSync(root);
  fs.mkdirSync(join(root, "dir")); fs.writeFileSync(join(root, "dir", "file"), "inside");
  fs.mkdirSync(join(root, "..", "outside")); fs.writeFileSync(join(root, "..", "outside", "file"), "SECRET");
  return root;
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) removeTempDirSync(root); });
function read(root: string, parts = ["dir", "file"], max = 100, hooks?: import("./anchored-read.ts").AnchoredReadHooks) {
  expect(helper.readAnchoredFile).toBeTypeOf("function");
  return helper.readAnchoredFile!(root, parts, max, hooks);
}
function refused(fn: () => unknown, code?: string) { let thrown = false; try { fn(); } catch (e) { thrown = true; if (code) expect(e).toMatchObject({ code }); } expect(thrown).toBe(true); }
it("anchored.readsFixtureAndReportsIdentity", () => {
  const result = read(fixture()); expect(Buffer.from(result.bytes).toString()).toBe("inside");
  expect(result.size).toBe(6); expect(result.volume).toMatch(/^\d+$/); expect(result.fileId).toBeTruthy();
});
it("T-A1 anchored.parentSwapRefused: held parent cannot redirect to outside", () => {
  const root = fixture(); const result = read(root, undefined, undefined, { afterStep(step) {
    if (step.kind === "dir") { fs.renameSync(join(root, "dir"), join(root, "held")); fs.symlinkSync(join(root, "..", "outside"), join(root, "dir"), process.platform === "win32" ? "junction" : "dir"); }
  } }); expect(Buffer.from(result.bytes).toString()).toBe("inside");
});
it("T-A2 anchored.finalSwapRefused", () => {
  const root = fixture(); refused(() => read(root, undefined, undefined, { afterStep(step) {
    if (step.kind === "dir") { fs.unlinkSync(join(root, "dir", "file")); fs.symlinkSync(join(root, "..", "outside", "file"), join(root, "dir", "file"), "file"); }
  } }));
});
it("T-A4 anchored.hardLinkRefused", () => {
  const root = fixture(); fs.linkSync(join(root, "dir", "file"), join(root, "alias")); refused(() => read(root), "hard_link");
});
it("anchored.junctionRefused", () => {
  const root = fixture(); fs.symlinkSync(join(root, "..", "outside"), join(root, "junction"), process.platform === "win32" ? "junction" : "dir");
  refused(() => read(root, ["junction", "file"]));
});
it("T-A3/T-A5 anchored.finalLinkRefused", () => {
  const root = fixture(); fs.symlinkSync(join(root, "..", "outside", "file"), join(root, "link"), "file"); refused(() => read(root, ["link"]), "link");
});
it.skipIf(process.platform !== "linux" || process.env.ANCHORED_MOUNT_PROOF !== "1")("T-A6 anchored.otherVolumeRefused: actual tmpfs in isolated mount namespace", () => {
  // The container gate invokes this file under unshare -Urnm; no host mount is touched.
  const root = fixture(); const mount = join(root, "dir");
  execFileSync("mount", ["-t", "tmpfs", "tmpfs", mount]);
  try { fs.writeFileSync(join(mount, "file"), "FOREIGN"); refused(() => read(root), "other_volume"); }
  finally { execFileSync("umount", [mount]); }
});
it.skipIf(process.platform === "win32")("T-A7 anchored.fifoNeverBlocks", () => {
  const root = fixture(); execFileSync("mkfifo", [join(root, "fifo")]); refused(() => read(root, ["fifo"]), "not_regular");
}, 2000);
it("T-A8 anchored.growthDuringReadRefused", () => {
  const root = fixture();
  if (process.platform === "win32") {
    const result = read(root, undefined, undefined, { afterStep(step) { if (step.kind === "file") expect(() => fs.appendFileSync(join(root, "dir", "file"), "growth")).toThrow(); } });
    expect(Buffer.from(result.bytes).toString()).toBe("inside");
  } else refused(() => read(root, undefined, undefined, { afterStep(step) { if (step.kind === "file") fs.appendFileSync(join(root, "dir", "file"), "growth"); } }), "changed");
});
for (const name of ["..", "a:b", "CON.txt", "NUL", "lpt9.doc", "trailing.", "space ", "nul\0", "a/b", "a\\b", "x\r", "x\n", "", "x".repeat(256)]) it(`T-A9 anchored.invalidNames ${JSON.stringify(name)}`, () => refused(() => read(fixture(), [name]), "invalid_name"));
it("anchored.invalidPartsAndLimit", () => { const root = fixture(); for (const parts of [[], Array(33).fill("x")]) refused(() => read(root, parts), "invalid_name"); refused(() => read(root, undefined, -1)); refused(() => read(root, undefined, 2), "too_large"); });
it.skipIf(process.platform !== "linux")("T-A10 anchored.procfsMissingUnsupported", async () => {
  vi.resetModules(); vi.doMock("node:fs", async () => ({ ...await vi.importActual("node:fs"), statfsSync: () => ({ type: 0 }) }));
  try { const fresh = await import("./anchored-read.ts"); refused(() => fresh.readAnchoredFile(fixture(), ["dir", "file"], 100), "unsupported"); }
  finally { vi.doUnmock("node:fs"); }
});
it("anchored.hookFailureClosesHandles", () => {
  const root = fixture(); for (const kind of ["root", "dir", "file", "read"]) expect(() => read(root, undefined, undefined, { afterStep(step) { if (step.kind === kind) throw Error("hook failure"); } })).toThrow("hook failure");
  expect(Buffer.from(read(root).bytes).toString()).toBe("inside");
});

for (const point of ["root", "dir", "file", "read"] as const) it(`T-A1 anchored.dirSwappedToLinkAfterEveryStep/${point}`, () => {
  const root = fixture();
  const run = () => read(root, undefined, undefined, { afterStep(step) {
    if (step.kind !== point) return;
    try { fs.renameSync(join(root, "dir"), join(root, "held")); }
    catch (error) { if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code!)) throw error; return; }
    fs.symlinkSync(join(root, "..", "outside"), join(root, "dir"), process.platform === "win32" ? "junction" : "dir");
  } });
  if (point === "root") refused(run); else expect(Buffer.from(run().bytes).toString()).toBe("inside");
});
for (const point of ["root", "dir", "file"] as const) it(`T-A2 anchored.swapAndRestoreBetweenSteps/${point}`, () => {
  const root = fixture(); let swapped = false;
  const run = () => read(root, undefined, undefined, { afterStep(step) {
    if (swapped) { fs.unlinkSync(join(root, "dir")); fs.renameSync(join(root, "held"), join(root, "dir")); swapped = false; }
    if (step.kind !== point) return;
    try { fs.renameSync(join(root, "dir"), join(root, "held")); }
    catch (error) { if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code!)) throw error; return; }
    fs.symlinkSync(join(root, "..", "outside"), join(root, "dir"), process.platform === "win32" ? "junction" : "dir"); swapped = true;
  } });
  if (point === "root") refused(run); else expect(Buffer.from(run().bytes).toString()).toBe("inside");
});
it.skipIf(process.platform !== "linux")("T-A6 anchored.otherVolumeRefused on the opened handle", async () => {
  vi.resetModules(); let stats = 0;
  vi.doMock("node:fs", async () => { const actual = await vi.importActual<typeof fs>("node:fs"); return { ...actual, fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
    const stat = actual.fstatSync(...args); if (++stats > 1) Object.defineProperty(stat, "dev", {value: BigInt(stat.dev) + 1n}); return stat;
  } }; });
  try { const fresh = await import("./anchored-read.ts"); refused(() => fresh.readAnchoredFile(fixture(), ["dir", "file"], 100), "other_volume"); }
  finally { vi.doUnmock("node:fs"); }
});
it.skipIf(process.platform === "linux")("T-A6 anchored.otherVolumeRefused native result cannot become bytes", async () => {
  vi.resetModules(); vi.doMock("node:module", () => ({createRequire: () => () => ({version: () => 1, read: () => { throw Object.assign(Error("native volume refusal"), {code:"other_volume"}); }})}));
  try { const fresh = await import("./anchored-read.ts"); refused(() => fresh.readAnchoredFile(fixture(), ["dir", "file"], 100), "other_volume"); }
  finally { vi.doUnmock("node:module"); }
});
it.skipIf(process.platform === "linux")("anchored.missingAddonFailsClosed", async () => {
  vi.resetModules(); vi.doMock("node:module", () => ({createRequire: () => () => { throw Error("missing addon"); }}));
  try { const fresh = await import("./anchored-read.ts"); expect(fresh.anchoredReadAvailable()).toBe(false); expect(() => fresh.readAnchoredFile(fixture(), ["dir", "file"], 100)).toThrow("Murage's file helper is missing. Reinstall Murage."); }
  finally { vi.doUnmock("node:module"); }
});
it.skipIf(process.platform !== "linux")("anchored.noDescriptorLeakOnHookExceptions", () => {
  const root = fixture(), before = fs.readdirSync("/proc/self/fd").length;
  for (let i = 0; i < 8; i++) for (const point of ["root", "dir", "file", "read"]) expect(() => read(root, undefined, undefined, {afterStep(step) { if (step.kind === point) throw Error("hook failure"); }})).toThrow("hook failure");
  expect(fs.readdirSync("/proc/self/fd")).toHaveLength(before);
});
it.skipIf(process.platform === "win32")("anchored.sameSizeMtimeChangeRefused", () => {
  const root = fixture(); refused(() => read(root, undefined, undefined, { afterStep(step) {
    if (step.kind === "read") fs.utimesSync(join(root, "dir", "file"), 1, 1);
  } }), "changed");
});
