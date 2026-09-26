// W-D7: after a restart that followed a failed backup, the desktop reports it
// (Inbox row every start while it needs review, one notification per failure).
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {announceBackupFailure,backupFailureNotice} from "./backup-failure-notice.mjs";

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
