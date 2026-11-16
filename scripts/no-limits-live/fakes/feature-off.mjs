import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {requireGatedHandle} from '../gated-handle.mjs';
export function recordFeatureOff(step,names,stateDir){
 if(!names.length)throw Error('Feature-off tool inventory was not observed');
 const denied=step.feature==='browser'?/(?:^|__)browser_|agent_browser_/i:step.feature==='host-computer'?/computer_(?:screenshot|click|type)|local_computer/i:/composio|GMAIL_SEND_EMAIL/i;
 if(names.some(name=>denied.test(name)))throw Error('Disabled capability remains in native tool inventory');
 appendFileSync(join(stateDir,'gnl-off-witness.ndjson'),JSON.stringify({token:step.token,feature:step.feature,toolsAbsent:true,listed:names.length})+'\n');
 return `${step.feature} is off. Turn it on in Settings.`;
}
export async function proveFeatureOff(step,mounts,gatedHandle){const {createMountedTools}=requireGatedHandle(gatedHandle);return recordFeatureOff(step,await createMountedTools(mounts).list(),process.env.S3_STATE_DIR);}
