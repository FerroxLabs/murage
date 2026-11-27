import {skillSettlementWork} from './skill-settlement-work.ts';
import { decide } from './outside-authority.ts';
import type { Ledger, SettleVerdict, SetupEntry } from './turn-settle.ts';
// Setup ledger/selection owner: decision lane. Skill acceptance owner: skills lane.
interface SetupHooks { open: () => boolean; option: () => boolean; apply: () => boolean | Promise<boolean>; push: () => void }
export class SetupAtSettle {
  private pending = new Map<string, Array<{ entry: SetupEntry; hooks: SetupHooks }>>();
  private ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }
  file(generation: string, input: Omit<SetupEntry, 'origin'>, hooks: SetupHooks): boolean {
    const row = this.ledger.rows.get(generation);
    if (!row || row.settled || !input.option) return false;
    const entry = { ...input, origin: row.origin };
    row.setup.push(entry);
    this.pending.set(generation, [...(this.pending.get(generation) ?? []), { entry, hooks }]);
    return input.push_suppressed;
  }
  private processedSinceYield=0;
  private drain: Promise<void> = Promise.resolve();
  settle(generation: string, verdict: SettleVerdict) {
    const pending = this.pending.get(generation) ?? []; this.pending.delete(generation);
    // Each generation is already indexed by the ledger. Consume its iterator in bounded serial batches.
    const run=async()=>{
      for(const {entry,hooks} of pending){
        const [result,notify]=decide({kind:'setup_at_settle',entry},{verdict,option_now:hooks.option(),card_open:hooks.open()});
        let applied=false;
        if(result==='resolve')try{applied=await hooks.apply();}catch{/* Leave the existing card where policy permits it. */}
        if(!applied&&hooks.open()&&(notify==='push'||result==='resolve'))hooks.push();
        if(++this.processedSinceYield>=16){this.processedSinceYield=0;await new Promise<void>(resolve=>setImmediate(resolve));}
      }
    };
    this.drain=this.drain.then(()=>skillSettlementWork.drain(run),()=>skillSettlementWork.drain(run));
    return this.drain;
  }
}
