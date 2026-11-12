// Isolated test host: setup.ts supplies an ephemeral data root; no real engine.
import { vi, beforeEach } from 'vitest';
import { Store } from '../store.ts';
import { database, closeDatabase } from '../database.ts';
import * as d from './index.ts';
import type { RequestOpenedEvent, TurnProvenance, Registration, ServiceCall } from './index.ts';
import { DATA_DIR } from '../config.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { mkdirSync } from 'node:fs';
beforeEach(() => {closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
export const baseCard = () => ({ approve: null, source: 'always-ask' as const });
export const baseRun = () => ({ approve: 'BASE', source: 'auto-mode' as const });
export function fixture(level: Registration['level'] = 'unlimited', initiator: TurnProvenance['initiator'] = { k: 'owner-typed' }) {
  const store = new Store();
  const listeners: Array<(event: any) => void> = [];
  let generation = 'g';
  let turnId = 'turn';
  let owner = true;
  let revision = '1';
  let targets: d.Evidence[] = [];
  const respond = vi.fn<d.DecisionTransport['respond']>(async () => ({state:'accepted' as const}));
  const interrupt = vi.fn(async () => {});
  const provenance = (): TurnProvenance => ({ generation, threadId:'t', botId:'b', principal:'owner', roomOwnerOnly:true, at:1, initiator });
  d.installDecisionHost({store,view:() => ({title:'Action',subtitle:'Fixture'})});
  d.installEngineApprovalBuilder(r=>({options:r.snapshot?.event.choices??['Allow','Deny']}));
  d.installProvenanceReader({turnGenerationFor:() => generation,provenance:() => provenance(),live:() => ({botId:'b',turnId,providerInstanceId:'p',principal:'owner',owner,level})});
  d.installDenySources({revision:() => [revision],resolve:() => targets});
  d.installDecisionTransport({respond,interrupt});
  const dispose = d.installRequestIngress({subscribe: fn => { listeners.push(fn); return () => { listeners.splice(listeners.indexOf(fn),1); }; }});
  const claim = d.installClaimVerifier(proof => proof === 'trusted' ? {threadId:'t',botId:'b',generation} : undefined)('trusted')!;
  const publish = (event: any) => listeners.forEach(fn => fn(event));
  const event = (id = 'r', input: unknown = {command:'echo x'}, extra: object = {}): RequestOpenedEvent => ({type:'request.opened',threadId:'t',requestId:id,turnId,providerInstanceId:'p',tool:'Bash',summary:'Fixture',requestType:'permission',toolCall:{name:'Bash',input},...extra} as RequestOpenedEvent);
  const open = (id='r',input: unknown={command:'echo x'},extra: object={}) => {publish(event(id,input,extra));return d.openRequest({kind:'engine',threadId:'t',requestId:id});};
  const serviceCall = (input: unknown = {command:'rm -rf ~'}, epoch='e'): ServiceCall => ({tool:'Bash',input,approval:{queueRef:'q',epoch,action:{requestId:'q',emailSend:{sendId:'q'},options:['Allow','Deny']}}});
  return { store, db:database(), respond, interrupt, publish, event, open, claim, serviceCall, dispose, setLevel:(l:typeof level) => {level=l;}, setOwner:(v:boolean) => {owner=v;}, setTurn:(v:string)=>{turnId=v;}, setGeneration:(v:string) => {generation=v;}, deny:(e:d.Evidence[]) => {targets=e;revision=String(+revision+1);} };
}
export function card(outcome: d.Outcome): d.ApprovalRef { if(outcome.kind!=='card' && outcome.kind!=='question') throw new Error(JSON.stringify(outcome)); return outcome.ref; }
export { d, database, closeDatabase };
