// SPDX-License-Identifier: AGPL-3.0-or-later
// Exact code API adapter. Raw Python/JavaScript never enters a shell parser.
import { PyReader, readPython } from './no-limits-python.ts';
import { readJavascript } from './no-limits-javascript.ts';
import { ReaderBudget } from './no-limits-budget.ts';
import { InspectionOverflow } from './no-limits-authority.ts';
import { type Twin } from './no-limits-shell.ts';
import { combineNoLimitsInspections, inspectNoLimits, type OwnerInspection, type OwnerFsContext } from './no-limits-taint.ts';
import { pythonCodeEffects, javascriptCodeEffects } from './no-limits-code-effects.ts';
import { resolveNoLimitsPath, lexicalPath, anchoredPath, type InspectedOperation, type Dialect } from './no-limits-fs.ts';

export type CodeOperation=Readonly<{kind:'code';lang:'py'|'js';text:string;cwd?:string;cwdInvalid:boolean}>;
export type OwnerOperation=InspectedOperation|CodeOperation;
export function inspectOwnerOperation(operation:OwnerOperation,context:OwnerFsContext={}):OwnerInspection {
 if(operation.kind==='native')return inspectNoLimits(operation,context);
 const ctx={...context,cwd:operation.cwd??context.cwd,cwdInvalid:operation.cwdInvalid||context.cwdInvalid};
 const budget=Object.assign(new ReaderBudget(),{left:9*operation.text.length+1});
 const work:Array<{lang:'py'|'js'|Dialect;text:string;depth:number;cwd?:string;cwdInvalid:boolean;id:string;windows?:boolean}>=[{id:'root',windows:context.windows,lang:operation.kind==='code'?operation.lang:operation.dialect,text:operation.text,cwd:operation.cwd,cwdInvalid:operation.cwdInvalid,depth:0}];
 const inspections:OwnerInspection[]=[],namespaces:string[]=[],codeBodies:NonNullable<OwnerInspection['codeBodies']>[number][]=[];
 let bytes=9*operation.text.length+1;
 for(let index=0;index<work.length;index++){
  const body=work[index]!;
  if(body.depth>8||body.text.length>bytes)throw new InspectionOverflow('code inspection overflow');
  bytes-=body.text.length;budget.tick(body.text.length);
  let twinIndex=0;
  const enqueue=([lang,text]:Twin)=>{if(lang==='sh'||lang==='py'||lang==='js')work.push({id:`${body.id}/twin${twinIndex++}`,windows:body.windows,lang,text,depth:body.depth+1,cwd:body.cwd,cwdInvalid:body.cwdInvalid});};
  if(body.lang==='sh'||body.lang==='cmd'||body.lang==='pwsh'){
   const inspected=inspectNoLimits({kind:'exec',dialect:body.lang,text:body.text,cwd:body.cwd,cwdInvalid:body.cwdInvalid},{...ctx,cwdInvalid:body.cwdInvalid});
   inspections.push(inspected);namespaces.push(body.id);
   for(const code of inspected.codeBodies??[])work.push({...code,id:`${body.id}/${code.id}`,depth:body.depth+1});
  }else{
   const pendingStart=work.length;
   const read=body.lang==='py'?readPython(body.text,budget,enqueue):readJavascript(body.text,budget,enqueue);
   if(read.cut||budget.left<0)throw new InspectionOverflow('code inspection overflow');
   const native=body.lang==='py'?pythonCodeEffects(read as PyReader):javascriptCodeEffects(read as ReturnType<typeof readJavascript>);
   // Retain observed lexical/physical alternatives, without execution-order
   // simulation. Opaque calls and relative chains also retain Unknown.
   const cwds=[{cwd:body.cwd,cwdInvalid:body.cwdInvalid}];
   if(native.cwdInvalid){
    let unknown=false;
    for(const value of native.cwdValues){
     const local={...ctx,cwd:body.cwd,cwdInvalid:body.cwdInvalid,windows:body.windows};
     const resolved=resolveNoLimitsPath(value,local);
     if(resolved.kind==='known'&&resolved.directory){
      cwds.push({cwd:lexicalPath(value,local),cwdInvalid:false},{cwd:resolved.physical,cwdInvalid:false});
     }else unknown=true;
     if(!anchoredPath(value))unknown=true;
    }
    const alternatives=[...new Map(cwds.map(cwd=>[JSON.stringify(cwd),cwd])).values()];
    const pendingEnd=work.length;
    for(let pending=pendingStart;pending<pendingEnd;pending++){
     const child=work[pending]!;
     for(const candidate of alternatives.slice(1))work.push({...child,...candidate});
     if(unknown){work.push({...child,cwdInvalid:true});}
    }
    cwds.splice(0,cwds.length,...alternatives);
    if(unknown){body.cwdInvalid=true;cwds.push({cwd:body.cwd,cwdInvalid:true});}
   }
   if(native.complete)codeBodies.push({id:body.id,lang:body.lang,text:body.text,cwd:body.cwd,cwdInvalid:body.cwdInvalid,windows:body.windows});
   const effects=native.effects;
   if(read.cut||budget.left<0)throw new InspectionOverflow('code inspection overflow');
   if(effects.length)for(const cwd of cwds){inspections.push(inspectNoLimits({kind:'native',effects,...cwd},{...ctx,cwdInvalid:cwd.cwdInvalid,windows:body.windows??ctx.windows}));namespaces.push(body.id+':api');}
  }
 }
 return Object.freeze({...combineNoLimitsInspections(inspections,ctx,namespaces),codeBodies:Object.freeze(codeBodies)});
}
