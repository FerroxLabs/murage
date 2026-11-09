/** Startup routing uses the durable reconciliation decision, never an error sentence. */
export function backupStartupDispatch({host, backupMode=false, closed=false, publish=()=>{}}) {
  const decision=host?.reconcileStartup()??{blocked:false};
  if(decision.blocked)return {...decision,route:closed?'closed-blocked':'recovery',consumeBackupMode:false};
  try{publish();}catch{/* Health publication cannot change backup authority. */}
  if(closed)return {...decision,route:'closed',consumeBackupMode:false};
  const status=host?.internalStatus();
  if(status?.phase==='handoff-armed')return {...decision,route:'offline',consumeBackupMode:false};
  if(host?.pendingUpgrade())return {...decision,route:'upgrade',consumeBackupMode:false};
  const consumeBackupMode=status?.phase==='waiting'||(status?.phase==='needs-review'&&decision.consumedNonUpgradeHandoff===true);
  return {...decision,route:backupMode&&!consumeBackupMode?'recovery':'workspace',consumeBackupMode};
}
/** User Return may retry failed cleanup; automatic returns never reset it. */
export async function explicitBackupReturn(host,returnToWorkspace){
  host?.noteStop?.();
  if(host?.reconcileStartup?.().blocked)throw Object.assign(Error("BACKUP_STATE_SAVE_FAILED"),{code:"BACKUP_STATE_SAVE_FAILED"});
  // Preparation runs inside the shared attempt, so concurrent Returns prepare once (b9 F6).
  return returnToWorkspace.retry({prepare:()=>{
    host?.prepareWorkspaceReturn();
    if(host?.pendingUpgrade())host.returnUpgradeToWorkspace();
    return {kind:"normal"};
  }});
}
