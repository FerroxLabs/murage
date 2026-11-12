// Approved corpus stays on its read-only private mount. Never serialize a row,
// label, identifier, tool, reason, input or exception to an output or diagnostic.
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const PRIVATE_CORPUS='/root/fuigo-builds/swarm-b/_private/nolim-cards';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const jsonl=path=>readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
const requireThat=value=>{if(!value)throw Error('Approved private corpus admission failed');};
export function readPrivateCorpus(path,pin){
 const input=realpathSync(path),root=realpathSync(PRIVATE_CORPUS);
 requireThat([root,join(root,'mac-select-v2.jsonl'),join(root,'display-corpus-bld5'),join(root,'display-corpus-bld5/cards.jsonl')].includes(input));
 const labelBytes=readFileSync(join(root,'labels-v1.json'));
 const seal=readFileSync(join(root,'labels-v1.sha256'),'utf8').trim().split(/\s+/)[0];
 if(pin&&statSyncSafe(pin))pin=readFileSync(pin,'utf8').trim().split(/\s+/)[0];
 requireThat(/^[a-f0-9]{64}$/.test(pin??'')&&pin===seal&&digest(labelBytes)===seal);
 const labels=JSON.parse(labelBytes),raw=jsonl(join(root,'mac-select-v2.jsonl'));
 const rows=jsonl(join(root,'display-corpus-bld5/cards.jsonl'));
 const manifest=JSON.parse(readFileSync(join(root,'display-corpus-bld5/manifest.json'),'utf8'));
 requireThat(Array.isArray(labels)&&rows.length===140&&labels.length===rows.length&&raw.length===rows.length+1);
 requireThat(manifest.inputSha256===digest(readFileSync(join(root,'mac-select-v2.jsonl'))));
 requireThat(manifest.files?.['cards.jsonl']?.sha256===digest(readFileSync(join(root,'display-corpus-bld5/cards.jsonl'))));
 const byId=new Map(labels.map(l=>[l.id,l]));
 requireThat(byId.size===rows.length&&new Set(rows.map(r=>r.id)).size===rows.length);
 requireThat(raw[0].emitted===rows.length&&raw[0].total===rows.length);
 for(const row of rows){
  const label=byId.get(row.id);
  requireThat(label&&typeof label.verdict==='string'&&/none/i.test(label.verdict));
  requireThat(raw.some(r=>r.id===row.id&&r.thread_id===row.thread_id&&r.requestId===row.requestId));
 }
 // Fable is an additional review, not a substitute for the pinned labels.
 const review=jsonl(join(root,'labels-fable-v1.jsonl'));
 requireThat(review.length>=rows.length);
 return {rows,labels:byId};
}
function statSyncSafe(path){try{return statSync(path).isFile();}catch{return false;}}

export async function replayPrivateCorpus({corpus,corpusSha,decide}){
 const {rows,labels}=readPrivateCorpus(corpus,corpusSha);
 let pass=0,nonwipe_cards=0,refusals=0,unavailable=0,failed=0;
 for(const row of rows){
  const label=labels.get(row.id);
  const unread=/unavailable/i.test(label.verdict)||row.boundedToolInput==null||Boolean(row.toolInputTruncated);
  if(unread)unavailable++;
  try{
   let input;try{input=JSON.parse(row.boundedToolInput);}catch{if(!unread)throw Error('Input unavailable');}
   const got=await decide(row,input);
   const cards=got.approve===null?1:0;
   nonwipe_cards+=cards;
   if(got.refused)refusals++;
   if(!cards&&!got.refused)pass++;else failed++;
  }catch{failed++;}
 }
 return {verdict:failed?'FAIL':'PASS',rows:rows.length,pass,nonwipe_cards,refusals,skipped:0,unavailable,failed,seals_verified:3,harness_errors:0,
  // Unreadable inputs exercise the No limits failed-reader ruling in place;
  // no original executable input or runtime provenance is reconstructed.
  original_input_proven:0};
}
