// q1022-disk restore lease (Astra 57a91517c8 High): restore awaits a keep-out scan (git ls-tree) between its lease check and
// `git restore`. A project folder replaced at the same path during that scan must not be written: the restore route's
// folder lease (ProjectFolderLeases.assertCurrent, as index.ts passes it to checkpoints.restore) is asked again right
// before the restore writes, and a file saved in the folder during the scan (in no safety point) is not overwritten.
// Real git, real lease registry; the folder is swapped, or a file saved, while the scan's git runs.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { ProjectFolderLeases } from "./project-folder-leases.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const DATA_ROOT = mkdtempSync(join(tmpdir(), "murage-ckptswap1022-"));
process.env.MURAGE_DATA_DIR = join(DATA_ROOT, "data");
const { restore, snapshot } = await import("./checkpoints.ts");
afterAll(async () => { await removeTempDir(DATA_ROOT); });

it("Q22DISK-SWAP a folder replaced during the restore's keep-out scan is left as it is", async () => {
  const cwd = join(DATA_ROOT, "Project"); mkdirSync(cwd);
  writeFileSync(join(cwd, "notes.md"), "checkpoint one\n");
  writeFileSync(join(cwd, "plan.md"), "plan one\n");
  const first = (await snapshot("ckptswap-bot", cwd, "one"))!;
  writeFileSync(join(cwd, "notes.md"), "edited later\n");
  await snapshot("ckptswap-bot", cwd, "two");
  const leases = new ProjectFolderLeases(); const owner = "restore:swap";
  leases.acquireRestore(owner, cwd);
  let checks = 0;
  const result = await restore("ckptswap-bot", cwd, first, {
    assertCurrent: () => {
      leases.assertCurrent(owner);
      // the check before the keep-out scan: replace the folder while the scan's git runs
      if (++checks === 2) setImmediate(() => {
        renameSync(cwd, join(DATA_ROOT, "Project-moved"));
        mkdirSync(cwd); writeFileSync(join(cwd, "notes.md"), "the replacement's own notes\n");
      });
    },
  });
  expect(result.ok, "Q22DISK-SWAP restore into a replaced folder is refused").toBe(false);
  expect({ files: readdirSync(cwd).sort(), notes: readFileSync(join(cwd, "notes.md"), "utf8") },
    "Q22DISK-SWAP the replacement folder after the refused restore").toEqual({ files: ["notes.md"], notes: "the replacement's own notes\n" });
}, 120_000);

it("Q22DISK-EDIT a file saved during the restore's keep-out scan is not overwritten", async () => {
  const cwd = join(DATA_ROOT, "Edited"); mkdirSync(cwd);
  writeFileSync(join(cwd, "notes.md"), "checkpoint one\n");
  const first = (await snapshot("ckptedit-bot", cwd, "one"))!;
  writeFileSync(join(cwd, "notes.md"), "edited later\n");
  await snapshot("ckptedit-bot", cwd, "two");
  const leases = new ProjectFolderLeases(); const owner = "restore:edit";
  leases.acquireRestore(owner, cwd);
  let checks = 0;
  const result = await restore("ckptedit-bot", cwd, first, {
    assertCurrent: () => {
      leases.assertCurrent(owner);
      // the check before the keep-out scan (after the safety point): an editor saves while the scan's git runs
      if (++checks === 2) setImmediate(() => { writeFileSync(join(cwd, "notes.md"), "saved during the restore\n"); });
    },
  });
  expect({ ok: result.ok, notes: readFileSync(join(cwd, "notes.md"), "utf8") },
    "Q22DISK-EDIT the file saved during the restore").toEqual({ ok: false, notes: "saved during the restore\n" });
}, 120_000);

// ASTRA/OPUS 95dac87ccb H2: a file CREATED during the restore (after the keep-out check of its path) at a path the checkpoint holds
// but the safety point lacks is untracked, so the safety diff misses it. Created at the lease check right after the scan (3) and at
// the one after the safety diff (4): restore must refuse and leave it, never write the checkpoint's copy over it.
for (const at of [3, 4]) it(`Q22DISK-CREATE a file created at lease check ${at} of the restore is not overwritten`, async () => {
  const cwd = join(DATA_ROOT, `Created${at}`); mkdirSync(cwd);
  writeFileSync(join(cwd, "notes.md"), "checkpoint one\n"); writeFileSync(join(cwd, "old.md"), "old in checkpoint one\n");
  const first = (await snapshot(`ckptcreate${at}-bot`, cwd, "one"))!;
  rmSync(join(cwd, "old.md"));
  await snapshot(`ckptcreate${at}-bot`, cwd, "two");
  const leases = new ProjectFolderLeases(); const owner = `restore:create${at}`;
  leases.acquireRestore(owner, cwd);
  let checks = 0;
  const result = await restore(`ckptcreate${at}-bot`, cwd, first, {
    assertCurrent: () => { leases.assertCurrent(owner); if (++checks === at) writeFileSync(join(cwd, "old.md"), "created during the restore\n"); },
  });
  expect({ ok: result.ok, old: readFileSync(join(cwd, "old.md"), "utf8") },
    "Q22DISK-CREATE the file created during the restore").toEqual({ ok: false, old: "created during the restore\n" });
}, 120_000);

// FABLE/OPUS 95dac87ccb H1: a folder holding a nested repo with an uncommitted tracked edit (supported, checkpoints.test.ts dirty
// nested repo) must still restore; the safety diff ignores the nested repo's own dirty tree as hasStagedChanges does.
it("Q22DISK-NESTED a folder with a dirty nested repo still restores", async () => {
  const cwd = join(DATA_ROOT, "Nested"); mkdirSync(cwd);
  const sub = join(cwd, "lib"); mkdirSync(sub);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: sub, stdio: "pipe" });
  git("init", "-q"); writeFileSync(join(sub, "lib.txt"), "committed\n"); git("add", "lib.txt"); git("commit", "-q", "-m", "one");
  writeFileSync(join(cwd, "notes.md"), "checkpoint one\n");
  const first = (await snapshot("ckptnested-bot", cwd, "one"))!;
  writeFileSync(join(cwd, "notes.md"), "edited later\n");
  writeFileSync(join(sub, "lib.txt"), "uncommitted edit in the nested repo\n");
  await snapshot("ckptnested-bot", cwd, "two");
  const result = await restore("ckptnested-bot", cwd, first);
  expect({ ok: result.ok, notes: readFileSync(join(cwd, "notes.md"), "utf8"), lib: readFileSync(join(sub, "lib.txt"), "utf8") },
    "Q22DISK-NESTED restore with a dirty nested repo").toEqual({ ok: true, notes: "checkpoint one\n", lib: "uncommitted edit in the nested repo\n" });
}, 120_000);

// ASTRA 8d18ad5701 High: listing the paths the restore adds is an awaited git; a tracked file saved while it runs must still be
// caught (the safety diff runs after it), never overwritten. A `git` on PATH saves the file while that listing runs, then runs git.
it.skipIf(process.platform === "win32")("Q22DISK-EDIT-ADDS a file saved while the restore lists its added paths is not overwritten", async () => {
  const cwd = join(DATA_ROOT, "EditAdds"); mkdirSync(cwd);
  writeFileSync(join(cwd, "notes.md"), "checkpoint one\n");
  const first = (await snapshot("ckpteditadds-bot", cwd, "one"))!;
  writeFileSync(join(cwd, "notes.md"), "edited later\n");
  await snapshot("ckpteditadds-bot", cwd, "two");
  const bin = join(DATA_ROOT, "editadds-bin"); mkdirSync(bin);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --name-only "*"--diff-filter=A"*) printf 'saved during the restore\\n' > ${JSON.stringify(join(cwd, "notes.md"))};; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  let result;
  try { result = await restore("ckpteditadds-bot", cwd, first); } finally { process.env.PATH = path; }
  expect({ ok: result.ok, notes: readFileSync(join(cwd, "notes.md"), "utf8") },
    "Q22DISK-EDIT-ADDS the file saved during the restore").toEqual({ ok: false, notes: "saved during the restore\n" });
}, 120_000);
