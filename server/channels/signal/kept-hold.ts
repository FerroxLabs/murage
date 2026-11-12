import type { ChannelState, SignalService } from './types.ts';
import type { ParkVerdict } from './park.ts';
export class SignalKeptHoldService implements SignalService {
 private readonly verdict:Extract<ParkVerdict,{state:'held'}>;private readonly prepare?:()=>Promise<ChannelState>;
 constructor(verdict:Extract<ParkVerdict,{state:'held'}>,prepare?:()=>Promise<ChannelState>){this.verdict=verdict;this.prepare=prepare;}
 status():ChannelState{
  const v=this.verdict;
  return{state:'blocked',reason:v.reason==='busy'?'kept-busy':'kept-check',path:v.folder,
   preservation:{progress:v.reason==='busy'?'busy':v.reason==='adoption'?'adoption':v.reason==='durability'?'durability':v.pendingReplacement?'pending':'check',canKeepBoth:v.canKeepBoth&&!!this.prepare,canLink:false,dualCopy:v.dualCopy}};
 }
 private deny():never{throw new Error('Signal files are kept');}
 async keepBothAndLinkAgain(){if(!this.verdict.canKeepBoth||!this.prepare)return this.deny();return this.prepare();}
 async link(){return this.deny();}async disconnect(){return this.deny();}async resend(){return this.deny();}async settle(){this.deny();}
 async retryNotes(){this.deny();}async finishRevocation(){return this.deny();}async fixPermissions(){return this.deny();}async stop(){}
}
