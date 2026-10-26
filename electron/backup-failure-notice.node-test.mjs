// W-D7: after a restart that followed a failed backup, the desktop reports it
// (Inbox row every start while it needs review, one notification per failure).
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,readFileSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {announceBackupFailure,announceBackupResult,backupFailureNotice,backupResultNotice} from "./backup-failure-notice.mjs";

const failed={phase:"needs-review",job:{id:"job-1"},captureFailure:{stage:"capture",code:"ENCRYPTED_BACKUP_FAILED"}};

test("only a backup that needs review is reported, with the finite stage and code",()=>{
 assert.deepEqual(backupFailureNotice(failed,null),{body:{action:"report",stage:"capture",code:"ENCRYPTED_BACKUP_FAILED",notify:true},key:"job-1:capture:ENCRYPTED_BACKUP_FAILED"});
 assert.equal(backupFailureNotice(failed,"job-1:capture:ENCRYPTED_BACKUP_FAILED").body.notify,false);
 for(const status of [{phase:"returned"},{phase:"idle"},{phase:"needs-review"},null])assert.deepEqual(backupFailureNotice(status,null).body,{action:"clear"});
 // Anything else in the record never leaves: an unknown code is named as unknown.
 assert.equal(backupFailureNotice({...failed,captureFailure:{stage:"capture",code:"C:\\Users\\Sam Lee"}},null).body.code,"UNKNOWN_CAPTURE_FAILURE");
});

test("one notification per failure, however many times Murage starts",async t=>{
 const userData=mkdtempSync(path.join(tmpdir(),"murage-failure-notice-"));t.after(()=>safeWipeSync(userData));
 const posted=[],shown=[];const post=async body=>{posted.push(body);return body.action==="report"?{reported:true,sentence:"The last backup stopped while copying your workspace."}:{cleared:true};};
 const showNotice=sentence=>shown.push(sentence);
 await announceBackupFailure({status:failed,userData,post,showNotice});
 await announceBackupFailure({status:failed,userData,post,showNotice});
 assert.deepEqual(posted.map(body=>body.notify),[true,false]);
 assert.deepEqual(shown,["The last backup stopped while copying your workspace."]);
 assert.match(readFileSync(path.join(userData,"backup-failure-announced.json"),"utf8"),/job-1:capture:ENCRYPTED_BACKUP_FAILED/);
 // A new failure is news again.
 await announceBackupFailure({status:{...failed,job:{id:"job-2"}},userData,post,showNotice});
 assert.equal(posted.at(-1).notify,true);assert.equal(shown.length,2);
 // Once it is cleared, the Inbox row goes too.
 await announceBackupFailure({status:{phase:"returned"},userData,post});
 assert.deepEqual(posted.at(-1),{action:"clear"});
 // A harness that refuses never breaks startup.
 assert.equal(await announceBackupFailure({status:failed,userData,post:async()=>{throw Error("down");}}),null);
});

test("Windows notifications carry the identity the installer gives Murage's shortcuts (W-D7)",()=>{
 const root=new URL("..",import.meta.url);
 const appId=/^appId:\s*(\S+)/m.exec(readFileSync(new URL("electron-builder.yml",root),"utf8"))?.[1];
 const main=readFileSync(new URL("electron/main.mjs",root),"utf8");
 assert.equal(appId,"com.murage.app");
 assert.match(main,new RegExp(`process\\.platform === "win32" && app\\.isPackaged\\) app\\.setAppUserModelId\\("${appId.replaceAll(".","\\.")}"\\)`));
});

// 0.1.60 audit A-01: the Inbox names the item too, and only one inside the data folder.
test("the report carries the item inside the data folder the refusal named",()=>{
 const status=path=>({phase:"needs-review",job:{id:"job-2"},captureFailure:{stage:"capture",code:"INVALID_INSTALLATION_RECORDS",path}});
 assert.equal(backupFailureNotice(status("routines.json"),null).body.path,"routines.json");
 assert.equal(backupFailureNotice(status("/Users/sam/secret"),null).body.path,undefined);
});

// 0.1.60 Windows final L1: the Inbox said "couldn't find your backup folder."
// while Settings named it ("Murage Backups").
test("a missing backup folder is reported with the folder's own name, and no other failure carries it",()=>{
 const missing={phase:"needs-review",job:{id:"job-3"},captureFailure:{stage:"references",code:"BACKUP_FOLDER_MISSING"}};
 assert.equal(backupFailureNotice(missing,null,"Murage Backups").body.folder,"Murage Backups");
 const other={phase:"needs-review",job:{id:"job-3"},captureFailure:{stage:"capture",code:"BACKUP_FILE_IN_USE"}};
 assert.equal(backupFailureNotice(other,null,"Murage Backups").body.folder,undefined);
 assert.equal(backupFailureNotice(missing,null,"x".repeat(121)).body.folder,undefined);
});
test("main.mjs hands the folder's name to the announcement",()=>{
 const main=readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
 assert.match(main,/folderName=await backupScheduleHost\.destinationLabel\(\)/);
 assert.match(main,/announceBackupFailure\(\{status:backupScheduleHost\.internalStatus\(\),folderName,/);
});

// 1.0.7: a Back up now that worked says so once Murage reopens.
const J="a".repeat(64);
const done=(over={})=>({phase:"returned",job:{id:J,occurrence:"3:manual:x",phase:"returned"},lastVerified:{jobId:J},...over});

test("a manual backup that returned is announced once, with the folder label and a count only",()=>{
 assert.deepEqual(backupResultNotice(done(),null,"Backups"),{key:J,title:"Backup saved and checked",body:"Your workspace is backed up to Backups."});
 const skipped=done({lastSkipped:{jobId:J,count:2,items:[{path:"config.json.bak-20260918-openaicompat",reason:"unrecognised"},{path:"config.json.bak-xxx",reason:"unrecognised"}],bots:{}}});
 const notice=backupResultNotice(skipped,null,"Backups");
 assert.equal(notice.body,"Your workspace is backed up to Backups. 2 items were left out. Settings → Backups lists them.");
 assert.ok(!notice.body.includes("config.json"));
 assert.equal(backupResultNotice(done({lastSkipped:{count:1}}),null,null).body,"Your workspace is backed up to your backup folder. 1 item was left out. Settings → Backups lists it.");
 assert.equal(backupResultNotice(done(),J,"Backups"),null,"the same backup is never announced twice");
});

test("daily, update, unverified, failed and other-job states say nothing",()=>{
 assert.equal(backupResultNotice(done({job:{id:J,occurrence:"3:daily:2026-10-26",phase:"returned"}}),null,"B"),null);
 assert.equal(backupResultNotice(done({job:{id:J,occurrence:"3:upgrade:u:h",phase:"returned"}}),null,"B"),null);
 assert.equal(backupResultNotice(done({lastVerified:{jobId:"b".repeat(64)}}),null,"B"),null);
 assert.equal(backupResultNotice(done({lastVerified:undefined}),null,"B"),null);
 assert.equal(backupResultNotice({...failed,job:{id:J,occurrence:"3:manual:x",phase:"needs-review"}},null,"B"),null);
 assert.equal(backupResultNotice(null,null,"B"),null);
 assert.equal(backupResultNotice(done(),null,"x".repeat(121)).body,"Your workspace is backed up to your backup folder.");
});

test("announceBackupResult shows once per backup and keeps only the job id, owner-only",()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"backup-result-"));
 try{
  const shown=[];
  assert.ok(announceBackupResult({status:done(),folderName:"Backups",userData:dir,showNotice:n=>shown.push(n)}));
  assert.equal(announceBackupResult({status:done(),folderName:"Backups",userData:dir,showNotice:n=>shown.push(n)}),null);
  assert.equal(shown.length,1);
  const file=path.join(dir,"backup-result-announced.json");
  assert.deepEqual(JSON.parse(readFileSync(file,"utf8")),{version:1,key:J});
  if(process.platform!=="win32")assert.equal(statSync(file).mode&0o777,0o600);
  assert.equal(announceBackupResult({status:done({job:{id:"c".repeat(64),occurrence:"3:manual:y",phase:"returned"},lastVerified:{jobId:"c".repeat(64)}}),userData:dir,showNotice:()=>{throw Error("no notifications");}}).key,"c".repeat(64),"a failed notification never throws");
  assert.equal(announceBackupResult({status:done(),userData:path.join(dir,"missing","deeper")}),null,"an unwritable profile never throws");
 }finally{safeWipeSync(dir);}
});
