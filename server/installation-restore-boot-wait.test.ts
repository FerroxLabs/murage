import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database, closeDatabase } from "./database.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation, rollbackInstallationRestore } from "./installation-restore.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
import { InstallationSnapshotError } from "./installation-snapshot-error.ts";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { RESTORE_REVIEW_FILE } from "../electron/restore-review.mjs";
import { captureFailurePath } from "../shared/backup-capture-failure.mjs";
import { RestoreJobStore } from "./email/restore-job.ts";
import * as publication from "./email/restore-job-effects.ts";
import { sqliteRestoreEffects } from "./email/restore-job-effects.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(async () => { closeDatabase(); await stopWalMaintenance(); for (const r of roots.splice(0)) removeTempDirSync(r); });
const identity = (p: string) => { const s = statSync(p, { bigint: true }); return [String(s.dev), String(s.ino)]; };
const count = (db: DatabaseSync, table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table) ? Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) : 0;
const DDL = "CREATE TABLE IF NOT EXISTS restore_boot_wait (id INTEGER PRIMARY KEY CHECK (id = 1), job_id TEXT NOT NULL, cause TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL, boot_id TEXT NOT NULL, up_ms INTEGER NOT NULL, db_dev TEXT NOT NULL, db_ino TEXT NOT NULL)";
const W = 1_800_000_000_000;
function store(dir: string) { return new RestoreJobStore({ dir, isLocalArchive: () => true, captureCarry: () => ({}), effects: sqliteRestoreEffects({ liveDb: join(dir, "messages.db"), archivesDir: dir }), now: () => W, bootId: () => "boot-A", bootTime: () => 1000 } as any); }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "j4d3-undo-")); roots.push(root);
  const target = join(root, "A"), source = join(root, "B"), archive = join(root, "B.zip");
  mkdirSync(target); mkdirSync(source);
  mkdirSync(DATA_DIR, {recursive:true}); database(); closeDatabase(); await stopWalMaintenance();
  copyFileSync(join(DATA_DIR, "messages.db"), join(target, "messages.db"));
  for (const dir of [source, target]) { writeFileSync(join(dir, "bots.json"), "[]"); writeFileSync(join(dir, "groups.json"), "[]"); }
  const file=join(target,"messages.db"),archives=join(root,"archives");mkdirSync(join(archives,"arc"),{recursive:true});copyFileSync(file,join(archives,"arc","messages.db"));
  const fx=sqliteRestoreEffects({liveDb:file,archivesDir:archives}),job={version:1 as const,id:"A",archiveId:"arc",source:"owner",phase:"swapped" as const,at:W};
  fx.stage(job);fx.install(job);writeFileSync(join(target,"restore-job.json"),JSON.stringify(job));let tries=0,mono=0;
  const recovery:any=new RestoreJobStore({dir:target,isLocalArchive:()=>true,captureCarry:()=>({}),effects:fx,now:()=>W,mono:()=>mono,bootTime:()=>1000,bootId:()=>"boot-A",sleepSync:(ms:number)=>{mono+=ms;},dataOpsLock:{acquire:()=>++tries>12,release:()=>{}},log:()=>{},publish:(req:any)=>{const result=Promise.resolve().then(()=>(publication as any).publishBootWaitRow((p:string,o:any)=>new DatabaseSync(p,o),statSync,req));return {result,terminate:()=>{},exited:result.then(()=>{})};}} as any);
  expect(recovery.recover()).toEqual({action:"prepared"});
  if(recovery.publishSettled)await recovery.publishSettled();
  const id=identity(file),db=new DatabaseSync(file);
  // Base-only adapter: 9b7 has no row publisher. Its owner notice uses the v1 file below.
  if(typeof (publication as any).publishBootWaitRow!=="function"){
   db.exec(DDL);db.prepare("INSERT INTO restore_boot_wait VALUES (1,?,?,?,?,?,?,?,?,?)").run("A","backup",3000,"freed",W,"boot-A",1000,...id);
  }
  expect(count(db,"restore_boot_wait")).toBe(1);expect(count(db,"restore_job_marks")).toBe(2);db.close();
  writeFileSync(join(target, "restore-boot-wait.json"), JSON.stringify({version:1,jobId:"A",cause:"backup",elapsedMs:3000,outcome:"freed",at:W}));
  const backup = await writeInstallationArchive(source, archive);
  return {root,target,archive,sha:backup.sha256,id};
}
function restored(f: Awaited<ReturnType<typeof fixture>>, notice: boolean) {
  expect(identity(join(f.target,"messages.db"))).toEqual(f.id);
  const db = new DatabaseSync(join(f.target,"messages.db"));
  try { expect(count(db,"restore_boot_wait")).toBe(notice ? 1 : 0); expect(db.prepare("SELECT job_id FROM restore_job_marks WHERE kind='prepared'").get()!.job_id).toBe("A"); } finally {db.close();}
  expect(store(f.target).bootWaitLine()).toBe(notice ? "Murage waited 3 seconds for a backup to finish before starting, so your data stays consistent." : null);
  if (!notice) expect(store(f.target).state()).toBe("none");
}
it("P5a completed installation undo drops the old notice", async () => {
  const f = await fixture(); await restoreInstallation(f.target,f.archive,f.sha);
  expect(rollbackInstallationRestore(f.target).status).toBe("rolled-back"); restored(f,false);
});
it("P5b interrupted installation rollback keeps the outgoing notice", async () => {
  const f = await fixture();
  await expect(restoreInstallation(f.target,f.archive,f.sha,{checkpoint: p => {if(p === "candidate-renamed") throw Error("cut");}})).rejects.toThrow();
  expect(rollbackInstallationRestore(f.target).status).toBe("rolled-back"); restored(f,true);
});
it("P5c undo refused, fault removed, retry succeeds without the old notice", async () => {
  const f = await fixture(), r = await restoreInstallation(f.target,f.archive,f.sha);
  const previous = r.previousDataDir!, receipt = r.receipt, journal = `${dataDirLeasePaths(f.target).leasePath}.restore.json`;
  const retained = previous.replace(/\.previous$/, ".retained");
  const before = {receipt: readFileSync(receipt), root: identity(f.target), previous: identity(previous), db:identity(join(previous,"messages.db"))};
  const db = new DatabaseSync(join(previous,"messages.db")); db.exec("BEGIN IMMEDIATE");
  try {
    const counts = [count(db,"restore_boot_wait"),count(db,"restore_job_marks")];
    let error: any; try {await installationRecoveryCommand(["rollback","--data-dir",f.target]);} catch(e) {error=e;}
    expect(error).toBeInstanceOf(InstallationSnapshotError); expect(error.code).toBe("RESTORE_ROLLBACK_FAILED");
    expect(error.path).toBe("messages.db"); expect(captureFailurePath(error.path)).toBe("messages.db");
    const context: any = {}; context.globalThis=context;
    vm.runInNewContext(readFileSync(new URL("../electron/recovery/messages.js",import.meta.url),"utf8"),context);
    const {sentence}=context.murageRecoveryMessages;
    const line=sentence(error.code,{action:"rollback",path:error.path});
    expect(line).toBe("Murage couldn't finish undoing the restore because it couldn't update its conversations file, and nothing was changed. Close every other Murage window and anything else using Murage's data folder, then choose Undo a restore again.");
    expect(line).not.toContain("The item is"); expect(line).toContain("Undo a restore");
    expect(line).not.toMatch(/[A-Z]{2,}_[A-Z_]+|age-keygen|fidelity|\u2013|\u2014|\bsaf(?:e|ely)\b/i);
    expect(sentence("RESTORE_ROLLBACK_FAILED",{action:"rollback"})).toBe("The restore couldn't be undone, and your files were kept as they are. Open the diagnostics folder and contact support.");
    expect(sentence("RESTORE_ROLLBACK_FAILED",{action:"rollback",path:"other.db"})).toBe("The restore couldn't be undone, and your files were kept as they are. Open the diagnostics folder and contact support. The item is other.db in Murage's data folder.");
    expect(existsSync(receipt)).toBe(true);
    expect(readFileSync(receipt)).toEqual(before.receipt);
    for(const p of [journal,`${receipt}.rolled-back`,retained]) expect(existsSync(p),p).toBe(false);
    expect(identity(f.target)).toEqual(before.root); expect(identity(previous)).toEqual(before.previous);
    expect(identity(join(previous,"messages.db"))).toEqual(before.db);
    expect(existsSync(join(f.target,RESTORE_REVIEW_FILE))).toBe(true);
    expect([count(db,"restore_boot_wait"),count(db,"restore_job_marks")]).toEqual(counts);
    expect(store(f.target).bootWaitLine()).toBeNull();
  } finally {db.exec("ROLLBACK");db.close();}
  expect(rollbackInstallationRestore(f.target).status).toBe("rolled-back"); restored(f,false);
});
