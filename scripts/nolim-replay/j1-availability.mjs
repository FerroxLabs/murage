import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {availability} from './replay-decide.mjs';
import {scenarios} from '../no-limits-live/scenarios.mjs';
// Full-input J3 counterparts for the exported corpus shapes. This is a static
// binding inventory, not a claim that the integrated/live witness has passed.
export const CORPUS_SHAPE_ROWS = {
 'Bash/missing-input':'unavailable-shell-missing-input',
 'Edit/truncated':'file-edit',
 'Write/long-heredoc':'heredoc-data',
 'Write/truncated':'file-edit',
 'mcp__tvcontrol__pine_set_source/truncated':'sable-mcp-after-outside',
};
export const CORPUS='_private/nolim-cards/mac-select-v2.jsonl';
export function checkAvailability(path=CORPUS){
 if(!existsSync(path))return {status:'MISSING',message:`missing corpus: ${CORPUS}`,rows:0,counts:{},requiredLiveRows:[],verdictsClaimed:false};
 const rows=readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.schema!=='murage.nolim-cards-count.v2');
 const counts={},ids=new Set(scenarios.map(x=>x.id)),missing=new Set(),required=new Set(),shapes=new Map();
 for(const row of rows){
  const a=availability(row),reason=a.reason??a.status;counts[reason]=(counts[reason]??0)+1;
  if(a.status==='unavailable'){
   const shape=`${a.shape}/${a.inputShape}`,rowId=CORPUS_SHAPE_ROWS[shape]??a.requiredLiveRow;
   required.add(rowId);if(!ids.has(rowId))missing.add(rowId);
   const entry=shapes.get(shape)??{tool:a.shape,shape:a.inputShape,rowId,count:0};entry.count++;shapes.set(shape,entry);
  }
 }
 return {status:missing.size?'FAIL':'PASS',rows:rows.length,counts,shapeRows:[...shapes.values()].sort((a,b)=>`${a.tool}/${a.shape}`.localeCompare(`${b.tool}/${b.shape}`)),requiredLiveRows:[...required].sort(),missingJ3Rows:[...missing].sort(),verdictsClaimed:false};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const report=checkAvailability(process.argv[2]??CORPUS);if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(report.status==='FAIL')process.exitCode=1;}
