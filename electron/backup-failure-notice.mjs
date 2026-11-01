// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W-D7 (0.1.60 Windows customer re-test 2): a backup that stopped was not
// announced. The window reopened exactly as before, and only Settings >
// Backups said "Needs attention". After the restart that follows a failed
// backup, the desktop now tells the server (POST /api/backup-failure-notice):
// the Inbox shows what failed and what to do for as long as backups need
// review, and one notification goes out per failure, not per start.
//
// BACKUP-SILENT-STOP (1.0.13): any job in review is reported, recorded reason
// or not, and the row stays up after the review is cleared until a backup
// actually succeeds. Nothing new is stored: the job, the existing failure note
// and the announced key say all of it.
import {readFileSync,writeFileSync,renameSync} from "node:fs";
import path from "node:path";
import {normalizeCaptureFailure} from "../shared/backup-capture-failure.mjs";

const FILE="backup-failure-announced.json";

/** What to tell the server about the last backup, from the coordinator's
 * status and the failure last announced. Only the finite stage and code,
 * and the item inside the data folder it named, leave this function; `key`
 * stays on this computer. */
export function backupFailureNotice(status,announcedKey,folderName){
 const review=status?.phase==="needs-review";
 // With no reason on record this is the unknown failure, never "nothing to say".
 const failure=review?normalizeCaptureFailure(status.captureFailure??{}):normalizeCaptureFailure(status?.retainedFailure);
 if(!failure)return{body:{action:"clear"},key:null};
 const job=typeof status.job?.id==="string"?status.job.id.slice(0,200):"";
 const key=`${job}:${failure.stage}:${failure.code}`;
 // The item inside the data folder, when the refusal names one (audit A-01).
 // The missing folder by its own name, as Settings says it (0.1.60 Windows final L1).
 const folder=failure.code==="BACKUP_FOLDER_MISSING"&&typeof folderName==="string"&&folderName.length<=120?folderName:null;
 const detail={action:"report",stage:failure.stage,code:failure.code,...(failure.path?{path:failure.path}:{}),...(folder?{folder}:{})};
 // Already announced before the owner cleared it: the row stays, no second notification.
 if(!review)return{body:{...detail,notify:false,next:status.enabled?"retry":"off"},key:null};
 return{body:{...detail,notify:key!==announcedKey,...(status.enabled?{next:"paused"}:{})},key};
}

/** True for the commit that stops the schedule, whichever path wrote it. */
export function backupStopCommitted(state){return state?.job?.phase==="needs-review";}

/** One announcement at a time: two overlapping ones would both read "not yet
 * announced" and show the same notification twice. */
export function serialAnnouncer(announce){
 let tail=Promise.resolve();
 return()=>{tail=tail.catch(()=>{}).then(()=>announce());return tail;};
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
export async function announceBackupFailure({status,folderName,userData,post,showNotice=()=>{}}){
 try{
  const {body,key}=backupFailureNotice(status,readAnnouncedFailure(userData),folderName);
  const answer=await post(body);
  if(body.action==="report"&&body.notify&&answer?.reported===true&&typeof answer.sentence==="string"&&answer.sentence.length<=1000){
   writeAnnouncedFailure(userData,key);
   try{showNotice(answer.sentence);}catch{/* the Inbox row still says it */}
  }
  return body;
 }catch{return null;}
}

// 1.0.7: a Back up now that worked said nothing once Murage reopened; only
// Settings > Backups showed it. One notification per such backup, after the
// reopen. Only a manual backup (the person pressed Back up now and watched
// Murage close): daily backups stay quiet, and their page already lists what
// was left out. The words carry the backup folder's label and a count, never a
// file name or a path inside the data folder.
const RESULT_FILE="backup-result-announced.json";
const MANUAL=/^\d+:manual:/;

/** The sentence to show for the backup that just finished, or null. */
export function backupResultNotice(status,announcedKey,folderName){
 const job=status?.job,receipt=status?.lastVerified;
 if(!job||job.phase!=="returned"||typeof job.id!=="string"||typeof job.occurrence!=="string"||!MANUAL.test(job.occurrence))return null;
 if(!receipt||receipt.jobId!==job.id)return null;
 const key=job.id.slice(0,200);
 if(key===announcedKey)return null;
 const folder=typeof folderName==="string"&&folderName.length>0&&folderName.length<=120?folderName:"your backup folder";
 const count=Number.isSafeInteger(status.lastSkipped?.count)&&status.lastSkipped.count>0?status.lastSkipped.count:0;
 const left=count?` ${count} ${count===1?"item was":"items were"} left out. Settings → Backups lists ${count===1?"it":"them"}.`:"";
 return{key,title:"Backup saved and checked",body:`Your workspace is backed up to ${folder}.${left}`};
}

function readKey(userData,file){
 try{const value=JSON.parse(readFileSync(path.join(userData,file),"utf8"));return typeof value?.key==="string"&&value.key.length<=400?value.key:null;}catch{return null;}
}
function writeKey(userData,file,key){
 const target=path.join(userData,file),temporary=`${target}.${process.pid}.tmp`;
 writeFileSync(temporary,JSON.stringify({version:1,key}),{mode:0o600});renameSync(temporary,target);
}

/** Show the result once. Never throws: a notification is never worth a failed start. */
export function announceBackupResult({status,folderName,userData,showNotice=()=>{}}){
 try{
  const notice=backupResultNotice(status,readKey(userData,RESULT_FILE),folderName);
  if(!notice)return null;
  writeKey(userData,RESULT_FILE,notice.key);
  try{showNotice(notice);}catch{/* the Backups page still says it */}
  return notice;
 }catch{return null;}
}
