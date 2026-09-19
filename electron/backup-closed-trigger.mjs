import {readClosedBackupDescriptor,assertClosedProfileBinding,closedInvocation} from "./backup-closed-profile.mjs";

/** Bundled entry glue supplies registration, the SAME coordinator and launch.
 * No protected-store import or callback belongs in this lightweight trigger. */
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/** Records what happened when the capture itself could not, once per state. */
function recordClosed(coordinator,result){
  try{
    const s=coordinator.status?.();const last=s?.lastClosedResult;
    if(last&&last.status===result.status&&last.reason===result.reason&&last.revision===s.revision)return;
    coordinator.recordClosedResult?.(result);
  }catch{/* Recording never changes what the trigger reports. */}
}
export async function runClosedBackupTrigger({descriptorPath,environment={},platform=process.platform,readDescriptor=readClosedBackupDescriptor,validateBinding=assertClosedProfileBinding,validateRegistration,createCoordinator,launch}){
  try{
    const descriptor=readDescriptor(descriptorPath);await validateBinding(descriptor);
    if(await validateRegistration(descriptor,descriptorPath)!==true)return{status:"unavailable"};
    const coordinator=await createCoordinator(descriptor);
    const eligibility=coordinator.closedEligibility();
    if(!eligibility||typeof eligibility!=="object"||Object.keys(eligibility).join()!=="status"||!["disabled","not-due","due","needs-review"].includes(eligibility.status))return{status:"needs-review"};
    if(eligibility.status!=="due")return{status:eligibility.status};
    // On Linux the capture is the desktop app, which needs the owner's desktop
    // session: with no display it cannot start, so wait and say why.
    if(platform==="linux"&&!environment.DISPLAY&&!environment.WAYLAND_DISPLAY){recordClosed(coordinator,{status:"unavailable",reason:"capability-unavailable"});return{status:"unavailable"};}
    const before=coordinator.status?.()?.lastClosedResult;
    // Final main/host admission rechecks actual lease, registration and due state.
    const result=await launch(closedInvocation(descriptor,descriptorPath,{environment}));
    // A capture that died before reporting recorded nothing; unless it did,
    // record that it needs review so the app does not show a silent success.
    if(result?.confirmed===false&&same(coordinator.status?.()?.lastClosedResult,before))recordClosed(coordinator,{status:"needs-review",reason:"capture-unconfirmed"});
    return{status:["not-due","busy","verified","needs-review","unavailable"].includes(result?.status)?result.status:"needs-review"};
  }catch{return{status:"unavailable"};}
}
