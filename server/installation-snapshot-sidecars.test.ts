import { existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach,expect,it,vi } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { snapshotInstallationDatabase,withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationState,stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
const replacement=vi.hoisted(()=>({target:"",sentinel:"",kind:"",seen:0}));
vi.mock("node:fs",async original=>{const fs=await original<typeof import("node:fs")>();return{...fs,lstatSync:(...args:Parameters<typeof fs.lstatSync>)=>{
 if(args[0]===replacement.target&&++replacement.seen===2){fs.renameSync(replacement.target,replacement.target+".retained");if(replacement.kind==="symlink")fs.symlinkSync(replacement.sentinel,replacement.target);else if(replacement.kind==="hardlink")fs.linkSync(replacement.sentinel,replacement.target);else fs.mkdirSync(replacement.target);}
 return fs.lstatSync(...args);
}};});
const roots:string[]=[];
afterEach(()=>{replacement.target="";replacement.seen=0;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const parent=mkdtempSync(join(tmpdir(),"murage-closed-wal-"));roots.push(parent);const data=join(parent,"installation");mkdirSync(data);writeFileSync(join(data,"config.json"),"{}\n");const db=new DatabaseSync(join(data,"messages.db"));db.exec("PRAGMA journal_mode=WAL");initializeMessageTables(db);db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread","message",1,"user","text","fixture",JSON.stringify({id:"message",at:1,role:"user",kind:"text",text:"fixture"}));db.exec("INSERT INTO thread_state VALUES('thread','message')");db.close();return{parent,data,target:join(parent,"snapshot.db")};}
it("captures a genuinely closed WAL database without mistaking SQLite auxiliary creation for external change",async()=>{
 const f=fixture();expect(existsSync(join(f.data,"messages.db-wal"))).toBe(false);const before=readFileSync(join(f.data,"messages.db"));const stage=await stageInstallationState(f.data,f.parent);expect(stage.manifest.database).toMatchObject({status:"copied",messages:1,threads:1});expect(readFileSync(join(f.data,"messages.db"))).toEqual(before);expect(stage.manifest.files.some(file=>file.path.endsWith("-wal")||file.path.endsWith("-shm"))).toBe(false);
});
it("still refuses an unrelated root file added after the database snapshot",async()=>{
 const f=fixture();await expect(withOfflineInstallation(f.data,installation=>stageInstallationStateWhileOwned({...installation,snapshotDatabase:async destination=>{const result=await installation.snapshotDatabase(destination);writeFileSync(join(f.data,"unexpected.json"),"{}\n");return result;}},f.parent))).rejects.toMatchObject({code:"SOURCE_CHANGED"});expect(readFileSync(join(f.data,"unexpected.json"),"utf8")).toBe("{}\n");
});
it.each(["symlink","hardlink","directory"])("refuses a %s auxiliary replacement after SQLite backup before publishing",async kind=>{
 const f=fixture();const sentinel=join(f.parent,"sentinel");writeFileSync(sentinel,"untouched-fixture");Object.assign(replacement,{target:join(realpathSync(f.data),"messages.db-shm"),sentinel,kind,seen:0});
 let failure:unknown;try{await snapshotInstallationDatabase(f.data,f.target);}catch(error){failure=error;}
 expect(replacement.seen).toBe(2);expect(failure).toMatchObject({code:"UNSAFE_DATABASE_FILE"});expect(existsSync(f.target)).toBe(false);expect(readFileSync(sentinel,"utf8")).toBe("untouched-fixture");
});
