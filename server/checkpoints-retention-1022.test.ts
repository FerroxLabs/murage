// q1022-disk item 2: per-turn workspace checkpoints are bounded. Through the module the turn path calls
// (snapshot, index.ts:17762; listCheckpoints/restore for the routes), against real git in temp folders:
// the newest 50 (or 14 days) are kept with their hashes, older history is pruned by a background gc, and a file over
// 20 MB is never copied into the shadow repo and never deleted or overwritten by a restore.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";

const DATA_ROOT = mkdtempSync(join(tmpdir(), "murage-ckpt1022-"));
process.env.MURAGE_DATA_DIR = join(DATA_ROOT, "data");
const { CHECKPOINTS_DIR, listCheckpoints, restore, snapshot } = await import("./checkpoints.ts");
const scratch: string[] = [DATA_ROOT];
afterAll(async () => { for (const dir of scratch) await removeTempDir(dir); });
afterEach(() => { vi.useRealTimers(); });

let seq = 0;
function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "murage-ckpt1022-ws-"));
  scratch.push(cwd);
  return { bot: `ckpt1022-bot-${++seq}`, cwd };
}
const shadowGit = (bot: string, args: string[]) => {
  const root = join(CHECKPOINTS_DIR, bot);
  const shadow = join(root, readdirSync(root)[0]!);
  return execFileSync("git", args, { env: { PATH: process.env.PATH, GIT_DIR: join(shadow, ".git"), GIT_CONFIG_NOSYSTEM: "1", HOME: DATA_ROOT }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
};
/** The shadow repo's own view of a commit's files (read-only). */
const shadowFiles = (bot: string, rev: string): string[] => shadowGit(bot, ["ls-tree", "-r", "-z", "--name-only", rev]).split("\0").filter(Boolean);
/** Whether the shadow repo still holds an object (a pruned checkpoint must be gone from disk, not only from the list). */
const shadowHas = (bot: string, hash: string) => { try { shadowGit(bot, ["cat-file", "-e", `${hash}^{commit}`]); return true; } catch { return false; } };
const MB = 1024 * 1024;
const sizeOf = (path: string) => existsSync(path) ? statSync(path).size : -1;

it("Q22DISK-CKPT keeps the newest 50 checkpoints (hashes unchanged) once the rest are past 14 days, and prunes the rest", async () => {
  const { bot, cwd } = workspace();
  for (let i = 0; i < 70; i++) { writeFileSync(join(cwd, "notes.md"), `turn ${i}\n`); expect(await snapshot(bot, cwd, `turn ${i}`)).toMatch(/^[0-9a-f]{40}$/); }
  const young = await listCheckpoints(bot, cwd);
  expect(young.length).toBe(70); // all younger than 14 days: every one is kept
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
  writeFileSync(join(cwd, "notes.md"), "turn 70\n");
  const newest = await snapshot(bot, cwd, "turn 70");
  const after = await listCheckpoints(bot, cwd); // queued behind the background prune
  // one assertion, so the pre-fix tree (no prune, no gc) is RED here, and so is a collection that repacks (shadowPacks)
  expect({ left: after.length, onDisk: [shadowHas(bot, young[49]!.hash), shadowHas(bot, young[60]!.hash)], packs: shadowPacks(bot) },
    "Q22DISK-CKPT checkpoints left after a month, pruned objects collected, and no repack").toEqual({ left: 50, onDisk: [true, false], packs: [] });
  expect(after[0]!.hash).toBe(newest);
  expect(after.slice(1).map(c => c.hash)).toEqual(young.slice(0, 49).map(c => c.hash));
  expect(await restore(bot, cwd, young[60]!.hash)).toEqual({ ok: false, error: "no such checkpoint" });
  expect(await restore(bot, cwd, young[10]!.hash)).toEqual({ ok: true });
  expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("turn 59\n");
}, 120_000);

it("Q22DISK-CKPT a gc that failed is not retried by every later prune for a day, then collects", async () => {
  const { bot, cwd } = workspace();
  const turns = async (from: number, count: number) => { for (let i = from; i < from + count; i++) { writeFileSync(join(cwd, "notes.md"), `turn ${i}\n`); await snapshot(bot, cwd, `turn ${i}`); } };
  await turns(0, 70);
  const young = await listCheckpoints(bot, cwd);
  const root = join(CHECKPOINTS_DIR, bot), gitDir = join(root, readdirSync(root)[0]!, ".git");
  const t = Date.now() + 30 * 24 * 60 * 60 * 1000;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t);
  const broken = join(gitDir, "refs", "heads", "q22-broken");
  writeFileSync(broken, `${"0".repeat(39)}1\n`); // a ref to a missing object: this collection fails
  await turns(70, 1); await listCheckpoints(bot, cwd);
  rmSync(broken, { force: true });
  vi.setSystemTime(t + 60 * 60 * 1000);
  await turns(71, 12); await listCheckpoints(bot, cwd); // a prune is due again within the day: it moves the boundary, no gc
  const withinADay = shadowHas(bot, young[60]!.hash);
  vi.setSystemTime(t + 25 * 60 * 60 * 1000);
  await turns(83, 12); await listCheckpoints(bot, cwd);
  expect({ withinADay, afterADay: shadowHas(bot, young[60]!.hash) }, "Q22DISK-CKPT pruned objects on disk after a failed gc")
    .toEqual({ withinADay: true, afterADay: false });
}, 120_000);

it("Q22DISK-CKPT a pruned checkpoint whose objects are still on disk is refused, not restored", async () => {
  const { bot, cwd } = workspace();
  for (let i = 0; i < 70; i++) { writeFileSync(join(cwd, "notes.md"), `turn ${i}\n`); await snapshot(bot, cwd, `turn ${i}`); }
  const all = await listCheckpoints(bot, cwd);
  // an interrupted prune: the boundary is written, gc never ran
  const root = join(CHECKPOINTS_DIR, bot), gitDir = join(root, readdirSync(root)[0]!, ".git");
  writeFileSync(join(gitDir, "shallow"), `${all[40]!.hash}\n`);
  expect(await restore(bot, cwd, all[60]!.hash), "Q22DISK-CKPT restore behind the boundary").toEqual({ ok: false, error: "no such checkpoint" });
  expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("turn 69\n");
}, 120_000);

/** A folder with a small file, then large files (one grown from a tracked small file, one with a line break in its name),
 * an excluded secret and a .gitignore that tries to re-include the large ones; returns the first and second checkpoint. */
async function largeFolder() {
  const { bot, cwd } = workspace();
  writeFileSync(join(cwd, "small.md"), "one\n");
  writeFileSync(join(cwd, "grows.dat"), "small at first\n");
  const first = (await snapshot(bot, cwd, "one"))!;
  writeFileSync(join(cwd, "small.md"), "two\n");
  writeFileSync(join(cwd, "video.raw"), "");
  truncateSync(join(cwd, "video.raw"), 21 * MB);
  truncateSync(join(cwd, "grows.dat"), 25 * MB);
  const odd = join(cwd, "odd\nname.raw"); // a line break in a name must neither escape the cap nor add an ignore line
  writeFileSync(odd, ""); truncateSync(odd, 21 * MB);
  mkdirSync(join(cwd, "clips")); writeFileSync(join(cwd, "clips", "big.raw"), ""); truncateSync(join(cwd, "clips", "big.raw"), 21 * MB); // alone in an untracked folder
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  writeFileSync(join(cwd, ".gitignore"), "!*.raw\n!grows.dat\n"); // the folder's own rules cannot re-include a large file
  const second = (await snapshot(bot, cwd, "two"))!;
  return { bot, cwd, odd, first, second };
}

it("Q22DISK-CKPT a file over 20 MB is not copied into a checkpoint", async () => {
  const { bot, second } = await largeFolder();
  expect(shadowFiles(bot, second), "Q22DISK-CKPT files copied into the checkpoint").toEqual([".gitignore", "small.md"]);
}, 120_000);

it("Q22DISK-CKPT a restore neither deletes nor overwrites a file over 20 MB", async () => {
  const { bot, cwd, odd, first } = await largeFolder();
  expect(await restore(bot, cwd, first)).toEqual({ ok: true });
  expect([sizeOf(join(cwd, "video.raw")), sizeOf(join(cwd, "grows.dat")), sizeOf(odd), sizeOf(join(cwd, "clips", "big.raw")), sizeOf(join(cwd, ".env"))],
    "Q22DISK-CKPT large files (and the excluded secret) after restore").toEqual([21 * MB, 25 * MB, 21 * MB, 21 * MB, 9]);
  expect(readFileSync(join(cwd, "small.md"), "utf8")).toBe("one\n");
}, 120_000);

it("Q22DISK-CKPT a grown file the folder ignores later is still not overwritten by a restore (Astra 48618e0c2f)", async () => {
  const { bot, cwd, first } = await largeFolder();
  // grows.dat left the index when it passed the cap; now the folder ignores it, so it drops out of the folder listing too
  writeFileSync(join(cwd, ".gitignore"), "grows.dat\n");
  await snapshot(bot, cwd, "three");
  expect(await restore(bot, cwd, first)).toEqual({ ok: true });
  expect(sizeOf(join(cwd, "grows.dat")), "Q22DISK-CKPT ignored grown file after restore").toBe(25 * MB);
}, 120_000);

it("Q22DISK-CKPT a restore across a file/folder swap keeps a file over 20 MB on either side", async () => {
  const { bot, cwd } = workspace();
  writeFileSync(join(cwd, "out"), "a file first\n");
  mkdirSync(join(cwd, "logs")); writeFileSync(join(cwd, "logs", "x.txt"), "x\n");
  const first = (await snapshot(bot, cwd, "one"))!;
  // out: the file became a folder holding a large file; logs: the folder became a large file the folder ignores (out/ and
  // logs/ folders are also on the checkpoint excludes, so neither side is listed; the restore removes that .gitignore)
  rmSync(join(cwd, "out")); mkdirSync(join(cwd, "out")); writeFileSync(join(cwd, "out", "big.bin"), ""); truncateSync(join(cwd, "out", "big.bin"), 21 * MB);
  rmSync(join(cwd, "logs"), { recursive: true }); writeFileSync(join(cwd, "logs"), ""); truncateSync(join(cwd, "logs"), 22 * MB);
  writeFileSync(join(cwd, ".gitignore"), "logs\n");
  await snapshot(bot, cwd, "two");
  const result = await restore(bot, cwd, first);
  expect({ result, sizes: [sizeOf(join(cwd, "out", "big.bin")), sizeOf(join(cwd, "logs"))] }, "Q22DISK-CKPT large files after a restore across a file/folder swap")
    .toEqual({ result: { ok: true }, sizes: [21 * MB, 22 * MB] });
}, 120_000);

it("Q22DISK-CKPT the same file/folder swap under names the checkpoint excludes do not cover", async () => {
  const { bot, cwd } = workspace();
  writeFileSync(join(cwd, "media"), "a file first\n");
  mkdirSync(join(cwd, "notes")); writeFileSync(join(cwd, "notes", "x.txt"), "x\n");
  const first = (await snapshot(bot, cwd, "one"))!;
  rmSync(join(cwd, "media")); mkdirSync(join(cwd, "media")); writeFileSync(join(cwd, "media", "big.bin"), ""); truncateSync(join(cwd, "media", "big.bin"), 21 * MB);
  rmSync(join(cwd, "notes"), { recursive: true }); writeFileSync(join(cwd, "notes"), ""); truncateSync(join(cwd, "notes"), 22 * MB);
  writeFileSync(join(cwd, ".gitignore"), "notes\n");
  await snapshot(bot, cwd, "two");
  const result = await restore(bot, cwd, first);
  expect({ result, sizes: [sizeOf(join(cwd, "media", "big.bin")), sizeOf(join(cwd, "notes"))] }, "Q22DISK-CKPT large files after a swap the excludes do not cover")
    .toEqual({ result: { ok: true }, sizes: [21 * MB, 22 * MB] });
}, 120_000);

it("Q22DISK-CKPT a tracked file that grew past 20 MB and is ignored since: the next restore goes through and keeps it (Fable 48618e0c2f)", async () => {
  const { bot, cwd } = workspace();
  writeFileSync(join(cwd, "small.md"), "one\n");
  writeFileSync(join(cwd, "grows.dat"), "small at first\n");
  const first = (await snapshot(bot, cwd, "one"))!;
  truncateSync(join(cwd, "grows.dat"), 25 * MB);
  writeFileSync(join(cwd, ".gitignore"), "grows.dat\n");
  writeFileSync(join(cwd, "small.md"), "two\n");
  const result = await restore(bot, cwd, first); // its safety point is the first snapshot that sees the file large
  expect({ result, size: sizeOf(join(cwd, "grows.dat")), small: readFileSync(join(cwd, "small.md"), "utf8") }, "Q22DISK-CKPT restore with a tracked, grown, ignored file")
    .toEqual({ result: { ok: true }, size: 25 * MB, small: "one\n" });
}, 120_000);

it("Q22DISK-CKPT a file dropped at the cap, ignored and shrunk since, is not overwritten by a restore (Astra 49e82fb258)", async () => {
  const { bot, cwd } = workspace();
  writeFileSync(join(cwd, "small.md"), "one\n");
  writeFileSync(join(cwd, "grows.dat"), "small at first\n");
  const first = (await snapshot(bot, cwd, "one"))!;
  truncateSync(join(cwd, "grows.dat"), 25 * MB);
  await snapshot(bot, cwd, "two"); // over the cap: it leaves the index
  writeFileSync(join(cwd, ".gitignore"), "grows.dat\n");
  writeFileSync(join(cwd, "grows.dat"), "new bytes, in no checkpoint\n");
  const result = await restore(bot, cwd, first);
  expect({ result, grows: readFileSync(join(cwd, "grows.dat"), "utf8"), small: readFileSync(join(cwd, "small.md"), "utf8") }, "Q22DISK-CKPT dropped, ignored, shrunk file after restore")
    .toEqual({ result: { ok: true }, grows: "new bytes, in no checkpoint\n", small: "one\n" });
}, 120_000);

it("Q22DISK-CKPT a file dropped at the cap, ignored and shrunk since, that the target lacks is not deleted by a restore (Astra e40607932a)", async () => {
  const { bot, cwd } = workspace();
  writeFileSync(join(cwd, "small.md"), "one\n");
  const first = (await snapshot(bot, cwd, "one"))!; // before draft.dat exists
  writeFileSync(join(cwd, "draft.dat"), "tracked first\n");
  await snapshot(bot, cwd, "two");
  truncateSync(join(cwd, "draft.dat"), 25 * MB);
  await snapshot(bot, cwd, "three"); // over the cap: it leaves the index
  writeFileSync(join(cwd, ".gitignore"), "draft.dat\n"); // the target has no .gitignore: the restore removes it
  writeFileSync(join(cwd, "draft.dat"), "new bytes, in no checkpoint\n");
  writeFileSync(join(cwd, "small.md"), "two\n");
  const result = await restore(bot, cwd, first);
  const draft = existsSync(join(cwd, "draft.dat")) ? readFileSync(join(cwd, "draft.dat"), "utf8") : null;
  expect({ result, draft, small: readFileSync(join(cwd, "small.md"), "utf8") }, "Q22DISK-CKPT dropped, ignored, shrunk file the target lacks, after restore")
    .toEqual({ result: { ok: true }, draft: "new bytes, in no checkpoint\n", small: "one\n" });
}, 120_000);

/** Pack files in the shadow repo. It is never packed, so collection stays a prune of loose objects: a full gc would
 * rewrite every kept object into a pack while the next turn's snapshot waits behind it on the shadow's queue. */
function shadowPacks(bot: string): string[] {
  const root = join(CHECKPOINTS_DIR, bot), pack = join(root, readdirSync(root)[0]!, ".git", "objects", "pack");
  return existsSync(pack) ? readdirSync(pack).filter(name => name.endsWith(".pack")) : [];
}
