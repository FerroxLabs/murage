// S5-DATADIR-PATHS r4.1 C10 (D5l): a package import commits under a linked workspaces root's canonical target, and a
// recovery with the root changed writes and rolls back nothing until the root is ok again.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { commitPackageImportFiles, recoverPackageImportTransaction } from "./package-import-transaction.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "s5-package-")));
  cleanup.push(() => removeTempDirSync(base));
  const root = join(base, "data"), T = join(base, "volume-t"), U = join(base, "volume-u");
  for (const dir of [root, T, U]) mkdirSync(dir);
  symlinkSync(T, join(root, "workspaces"), "dir");
  const lease = acquireDataDirLease(root); cleanup.push(() => { lease.release(); });
  const assertOwned = () => { lease.utilityServerLeaseEnvironment(); };
  const botId = randomUUID();
  const originals = new Map([["bots.json", Buffer.from('[{"id":"existing"}]')], ["groups.json", Buffer.from("[]")], ["routines.json", Buffer.from('{"version":1,"routines":[],"runs":[]}')]]);
  for (const [path, bytes] of originals) writeFileSync(join(root, path), bytes);
  const replacements = new Map([...originals].map(([path]) => [path, Buffer.from(`new ${path}`)]));
  replacements.set(`workspaces/${botId}/SOUL.md`, Buffer.from("Safe imported instructions"));
  replacements.set(`workspaces/${botId}/skills/research/SKILL.md`, Buffer.from("Check facts"));
  replacements.set(`skill-state/${botId}/skills.json`, Buffer.from('{"research":{"enabled":false}}'));
  const expected = new Map([...replacements].map(([path]) => [path, originals.has(path) ? sha(originals.get(path)!) : null]));
  return { root, T, U, botId, replacements, expected, options: { allowedNewBotIds: [botId], assertOwned } };
}
const retarget = (root: string, to: string) => { rmSync(join(root, "workspaces")); symlinkSync(to, join(root, "workspaces"), "dir"); };

it("D5l: with workspaces linked, an import commits SOUL.md and a skill under T", () => {
  const f = fixture();
  expect(commitPackageImportFiles(f.root, f.replacements, f.expected, f.options).status).toBe("committed");
  expect(readFileSync(join(f.T, f.botId, "SOUL.md"), "utf8")).toBe("Safe imported instructions");
  expect(readFileSync(join(f.T, f.botId, "skills", "research", "SKILL.md"), "utf8")).toBe("Check facts");
});

it("D5l: interrupted after the journal, then the root changed -> recovery writes and rolls back nothing; root back -> recovery completes under T", () => {
  const f = fixture();
  expect(() => commitPackageImportFiles(f.root, f.replacements, f.expected, { ...f.options, checkpoint: phase => { if (phase === "replaced:4") throw new Error("stop"); } })).toThrow("stop");
  const journal = join(f.root, ".package-import-transaction");
  expect(existsSync(journal)).toBe(true);
  const bots = readFileSync(join(f.root, "bots.json"));
  retarget(f.root, f.U);
  expect(() => recoverPackageImportTransaction(f.root, f.options)).toThrow("PACKAGE_IMPORT_RECOVERY_REQUIRED");
  expect(existsSync(journal)).toBe(true);
  expect(readFileSync(join(f.root, "bots.json")).equals(bots)).toBe(true);
  expect(readdirSync(f.U)).toEqual([]);
  retarget(f.root, f.T);
  expect(recoverPackageImportTransaction(f.root, f.options).status).toBe("rolled-back");
  expect(existsSync(journal)).toBe(false);
  expect(existsSync(join(f.T, f.botId, "SOUL.md"))).toBe(false);
  expect(readdirSync(f.U)).toEqual([]);
});
