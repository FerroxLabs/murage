/** Existing host/coordinator own persistence and artifact validation. These
 * joins never infer installation from a void native-updater result. */
export async function prepareBackedUpInstall(candidate,{backup,prepareNormal}) {
  const result=backup?await backup.requestUpgrade(candidate):{status:"continue"};
  if(result?.status==="deferred")return result;
  if(result?.status!=="continue")throw Error("BACKUP_UPGRADE_REVIEW_REQUIRED");
  await prepareNormal();
  return {status:"continue"};
}

export async function resumeBackedUpInstall({backup,updater,currentVersion,cleanup}) {
  const pending=backup.pendingUpgrade();
  if(!pending)return {status:"none"};
  if(pending.phase==="install-requested"){
    if(currentVersion!==pending.candidate.version)throw Error("BACKUP_UPGRADE_REVIEW_REQUIRED");
    await backup.completeUpgrade(currentVersion);
    return {status:"completed"};
  }
  if(pending.phase!=="return-pending")throw Error("BACKUP_UPGRADE_REVIEW_REQUIRED");
  await backup.verifyUpgrade(pending.candidate);
  const result=await updater.resumeInstall(pending.candidate,{beforeInstall:async actual=>{
    await backup.markUpgradeInstallRequested(actual);
    await cleanup();
    return {status:"continue"};
  }});
  if(result?.status!=="install-requested")throw Error("BACKUP_UPGRADE_REVIEW_REQUIRED");
  return result;
}
