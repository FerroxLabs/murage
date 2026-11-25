// q1022-disk restore lease (Astra 57a91517c8 High): restore awaits a keep-out scan (git ls-tree) between its lease check and
// `git restore`. A project folder replaced at the same path during that scan must not be written: the restore route's
// folder lease (ProjectFolderLeases.assertCurrent, as index.ts passes it to checkpoints.restore) is asked again right
// before the restore writes, and a file saved in the folder during the scan (in no safety point) is not overwritten.
// Real git, real lease registry; the folder is swapped, or a file saved, while the scan's git runs.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
