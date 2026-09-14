import {readClosedBackupDescriptor,assertClosedProfileBinding,closedInvocation} from "./backup-closed-profile.mjs";

/** Bundled entry glue supplies registration, the SAME coordinator and launch.
 * No protected-store import or callback belongs in this lightweight trigger. */
export async function runClosedBackupTrigger({descriptorPath,environment={},readDescriptor=readClosedBackupDescriptor,validateBinding=assertClosedProfileBinding,validateRegistration,createCoordinator,launch}){
  try{
    const descriptor=readDescriptor(descriptorPath);await validateBinding(descriptor);
    if(await validateRegistration(descriptor,descriptorPath)!==true)return{status:"unavailable"};
    const coordinator=await createCoordinator(descriptor);
    const eligibility=coordinator.closedEligibility();
    if(!eligibility||typeof eligibility!=="object"||Object.keys(eligibility).join()!=="status"||!["disabled","not-due","due","needs-review"].includes(eligibility.status))return{status:"needs-review"};
    if(eligibility.status!=="due")return{status:eligibility.status};
    // Final main/host admission rechecks actual lease, registration and due state.
    const result=await launch(closedInvocation(descriptor,descriptorPath,{environment}));
    return{status:["not-due","busy","verified","needs-review","unavailable"].includes(result?.status)?result.status:"needs-review"};
  }catch{return{status:"unavailable"};}
}
