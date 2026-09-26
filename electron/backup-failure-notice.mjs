// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W-D7 (0.1.60 Windows customer re-test 2): a backup that stopped was not
// announced. The window reopened exactly as before, and only Settings >
// Backups said "Needs attention". After the restart that follows a failed
// backup, the desktop now tells the server (POST /api/backup-failure-notice):
// the Inbox shows what failed and what to do for as long as backups need
// review, and one notification goes out per failure, not per start.
import {readFileSync,writeFileSync,renameSync} from "node:fs";
import path from "node:path";
import {normalizeCaptureFailure} from "../shared/backup-capture-failure.mjs";

const FILE="backup-failure-announced.json";

/** What to tell the server about the last backup, from the coordinator's
 * status and the failure last announced. Only the finite stage and code
 * leave this function; `key` stays on this computer. */
export function backupFailureNotice(status,announcedKey){
 const failure=status?.phase==="needs-review"?normalizeCaptureFailure(status.captureFailure):null;
 if(!failure)return{body:{action:"clear"},key:null};
 const job=typeof status.job?.id==="string"?status.job.id.slice(0,200):"";
 const key=`${job}:${failure.stage}:${failure.code}`;
 return{body:{action:"report",stage:failure.stage,code:failure.code,notify:key!==announcedKey},key};
}

export function readAnnouncedFailure(userData){
 try{const value=JSON.parse(readFileSync(path.join(userData,FILE),"utf8"));return typeof value?.key==="string"&&value.key.length<=400?value.key:null;}catch{return null;}
}
export function writeAnnouncedFailure(userData,key){
 const file=path.join(userData,FILE),temporary=`${file}.${process.pid}.tmp`;
 writeFileSync(temporary,JSON.stringify({version:1,key}),{mode:0o600});renameSync(temporary,file);
}

/** Tell the server once it is up. Never throws: an announcement is never
 * worth a failed start. */
export async function announceBackupFailure({status,userData,post,showNotice=()=>{}}){
 try{
  const {body,key}=backupFailureNotice(status,readAnnouncedFailure(userData));
  const answer=await post(body);
  if(body.action==="report"&&body.notify&&answer?.reported===true&&typeof answer.sentence==="string"&&answer.sentence.length<=1000){
   writeAnnouncedFailure(userData,key);
   try{showNotice(answer.sentence);}catch{/* the Inbox row still says it */}
  }
  return body;
 }catch{return null;}
}
