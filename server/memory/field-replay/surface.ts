// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Kept local so this replay can be copied unchanged onto pre-contract TB.
// This is the complete shared/permission-card.ts PERMISSION_CARD_KEYS inventory.
const PERMISSION_CARD_KEYS=['requestId','publish','mcpEnable','emailSend','browserSetup','routineRequest','skillRequest','folderTrust','approvalScope'] as const;
import { openSse, type SseRecorder } from '../../testing/sse.ts';

export type Call = (method: string, path: string, body?: unknown, owner?: boolean) => Promise<{status:number;body:any}>;
export const permissionCard = (message:any):boolean => message?.kind === 'options' && message.card && PERMISSION_CARD_KEYS.some(key => Object.hasOwn(message.card,key));
export function journal(path:string):any[] {
  if(!existsSync(path))return [];
  const text=readFileSync(path,'utf8');
  // A concurrently appended final line is not an acknowledged journal row yet.
  return text.slice(0,text.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
export class BehavioralRed extends Error {
  constructor(message:string,public readonly facts:unknown){super(message);this.name='BehavioralRed';}
}
export function requireFact(condition:unknown,message:string,facts:unknown):asserts condition {
  if(!condition)throw new BehavioralRed(message,facts);
}
export class Surface {
  private assertions:Array<{threads:string[];expected:number;why?:'deny'|'base'|'wipe'}>=[];
  private constructor(readonly sse:SseRecorder,private call:Call,private data:string){}
  static async open(base:string,headers:Record<string,string>,call:Call,data:string){
    return new Surface(await openSse(`${base}/api/events`,headers),call,data);
  }
  async counts(threads:string[]) {
    // Drain frames emitted with the completed HTTP response. Keep the subscription
    // open until this snapshot is taken; patches of an already seen card count once.
    await new Promise(resolve=>setTimeout(resolve,200));
    const transcripts=await Promise.all(threads.map(async thread=>({thread,messages:(await this.call('GET',`/api/threads/${thread}/messages?limit=500`)).body.messages??[]})));
    const frames=this.sse.frames.filter(f=>threads.includes(f.threadId)&&['message','message.patch'].includes(f.kind));
    const seen=new Set(frames.filter(f=>permissionCard(f.message)).map(f=>`${f.threadId}:${f.message.id}`));
    const messages=transcripts.flatMap(t=>t.messages.filter(permissionCard).map((message:any)=>({threadId:t.thread,...message})));
    const decisions=journal(join(this.data,'decisions.ndjson')).filter(r=>threads.includes(r.threadId));
    const shown=decisions.filter(r=>r.decision==='card-shown');
    return {sse:seen.size,transcript:messages.length,decision:shown.length,
      sseEvents:frames.filter(f=>permissionCard(f.message)).map(f=>({kind:f.kind,threadId:f.threadId,id:f.message.id})),
      cards:messages,decisions,threads};
  }
  async assert(threads:string[],expected:number,why?:'deny'|'base'|'wipe') {
    const counts=await this.counts(threads);
    assertSurfaceCounts(counts,expected,why);
    this.assertions.push({threads,expected,why});
    return counts;
  }
  async recheck(){for(const a of this.assertions)assertSurfaceCounts(await this.counts(a.threads),a.expected,a.why);}
  async nextPhase(){
    // Finish the current phase before its next action can change these totals.
    // The next phase still asserts exact cumulative counts through settlement.
    await this.recheck();
    this.assertions=[];
  }
  close(){this.sse.close();}
}

export function assertSurfaceCounts(counts:Awaited<ReturnType<Surface['counts']>>,expected:number,why?:'deny'|'base'|'wipe'){
    requireFact(counts.sse===counts.transcript&&counts.transcript===counts.decision,'R7 surface counters disagree',counts);
    requireFact(counts.sse===expected,`expected ${expected} permission cards`,counts);
    if(why)requireFact(counts.cards.some((m:any)=>m.card?.why===why||m.card?.reason===why)||counts.decisions.some((d:any)=>d.why===why||d.reason===why||d.source===why||d.rule===why),`control must retain ${why}`,counts);
}
