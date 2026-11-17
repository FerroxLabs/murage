import {proveFeatureOff} from './feature-off.mjs';
import {begin,holdReleased,recordReleasedEffect,resolveReleaseStep,rememberReleaseResult} from './common.mjs';
import {requireGatedHandle} from '../gated-handle.mjs';
export async function nativePlay(value,{mounts,allow,started,completed,text=()=>{},beforeMounted,gatedHandle}){
 const {createMountedTools,executeReleased}=requireGatedHandle(gatedHandle);
 const plan=await begin(value),pageState={};
 for(let [i,original] of plan.steps.entries()){
  original=resolveReleaseStep(original,pageState);
  const step=original.kind==='question'?{...original,input:{questions:[{question:original.input.question,options:original.input.choices.map(label=>({label}))}]}}:original;
  if(step.kind==='off'){text(await proveFeatureOff(step,mounts,gatedHandle));continue;}
  if(step.kind==='delay'){await holdReleased(step,text);continue;}
  if(step.kind==='text'){text(step.text);continue;}
  started(step,i);
  let ok=false;
  if((['Bash','Write'].includes(step.tool)))ok=executeReleased(step,await allow(step,i));
  else {try{const reply=await createMountedTools(mounts,beforeMounted?(detail=>beforeMounted(detail,step,i)):undefined).call(step.tool,step.input);rememberReleaseResult(step,reply,pageState);recordReleasedEffect(step);ok=true;}catch(error){text(`GNL_FIXTURE_ERROR ${error.message}`);completed(step,i,false);throw error;}}
  completed(step,i,ok);
 }
 if(!plan.steps.some(step=>step.kind==='off'))text('Release fixture complete');
}
