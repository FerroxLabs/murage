// SPDX-License-Identifier: AGPL-3.0-or-later
import {posix,win32} from 'node:path';
import {known,opaque,type Invocation,type Value,type WipeEffect,type EffectRecord,type ShellState} from './types.ts';
import {operand} from './expand.ts';
import {peel} from './invocation.ts';
import {effectRecord} from './effect-records.ts';
import {effectRecordsOf} from './programs.ts';
type Expr={op:'test';name:string;value?:string;command?:Value[]}|{op:'!'|'&'|'|'|',';left:Expr;right?:Expr};
type Flow={restricted:boolean;root:boolean};
const str=(v:Value|undefined)=>v?.k==='known'?v.s:'';
const uniq=(flows:Flow[])=>[...new Map(flows.map(f=>[`${+f.restricted}${+f.root}`,f])).values()];
const consuming=/^-(?:i?(?:name|path|wholename|regex|lname)|newer\w*|[mac](?:time|min)|size|user|group|uid|gid|perm|links|inum|samefile|type|xtype|mindepth|maxdepth|printf|fprintf|fprint\w*)$/;
const restrictive=/^-(?:i?(?:name|path|wholename|regex|lname)|newer\w*|[mac](?:time|min)|size|empty|links|inum|samefile)$/;
function patternMatches(name:string,pattern:string,start:string):boolean {
 const path=start.includes('\\')?win32:posix,candidate=/name$/.test(name)&&!/wholename$/.test(name)?path.basename(start.replace(/[\\/]$/,'')):start;
 try{const source=/regex$/.test(name)?pattern:pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*').replaceAll('?','.');return new RegExp('^(?:'+source+')$',/^-i/.test(name)?'i':'').test(candidate);}catch{return false;}
}
/** Boolean evaluation respects action order and caps the abstract guard domain at four states. */
export function findRecords(inv:Invocation,produceOnly=false):EffectRecord[] {
 // The external find replacement token remains a token even when a host parser
 // represented its empty braces as a script-block value.
 const args=inv.argv.map((value,i)=>inv.rawArgv[i]?.raw==='{}'?known('{}'):value),words=args.map(str);let at=0;while(at<args.length&&/^-[LHP]$/.test(words[at]!))at++;
 const roots:Value[]=[];while(at<args.length&&!/^[-!(,]/.test(words[at]!))roots.push(operand(args[at++]!,inv.cwd,inv));if(!roots.length)roots.push(operand(known('.'),inv.cwd,inv));
 const expr:Expr[]=[],ops:string[]=[],precedence:Record<string,number>={'!':4,'&':3,'|':2,',':1};let prior=false;
 const apply=()=>{const op=ops.pop() as '!'|'&'|'|'|',',right=expr.pop();if(!right)return;if(op==='!')expr.push({op,left:right});else {const left=expr.pop();if(left)expr.push({op,left,right});}};
 const operator=(op:string)=>{while(ops.length&&ops.at(-1)!=='('&&(precedence[ops.at(-1)!]??0)>=(precedence[op]??0))apply();ops.push(op);};
 const units:Expr[]=[];let minDepth=0;
 for(let i=at;i<args.length;i++){
  const name=words[i]!;
  if(['-a','-and','-o','-or',','].includes(name)){operator(name===','?',':name==='-a'||name==='-and'?'&':'|');prior=false;continue;}
  if(name===')'){while(ops.length&&ops.at(-1)!=='(')apply();if(ops.at(-1)==='(')ops.pop();prior=true;continue;}
  if(prior)operator('&');
  if(name==='('){ops.push('(');prior=false;continue;}
  if(name==='!'||name==='-not'){ops.push('!');prior=false;continue;}
  const unit:Extract<Expr,{op:'test'}>={op:'test',name};
  if(/^-(?:exec|execdir|ok|okdir)$/.test(name)){const begin=++i;while(i<args.length&&![';','+'].includes(words[i]!))i++;unit.command=args.slice(begin,i);}
  else if(consuming.test(name)){unit.value=words[++i]??'';if(name==='-mindepth')minDepth=Math.max(minDepth,Number(unit.value)||0);}
  expr.push(unit);units.push(unit);prior=true;
 }
 while(ops.length){if(ops.at(-1)==='(')ops.pop();else apply();}
 let tree=expr.at(-1)??{op:'test',name:'-true'} as Expr;if(!units.some(unit=>unit.op==='test'&&(unit.command||/^-(?:delete|print.*|fprint.*|prune)$/.test(unit.name))))tree={op:'&',left:tree,right:{op:'test',name:'-print'}};const effects:EffectRecord[]=[],printed:Value[]=[];
 for(const root of roots){
  const results=new Map<Expr,{t:Flow[];f:Flow[]}>(),frames:{node:Expr;flows:Flow[];phase:number}[]=[{node:tree,flows:[{restricted:false,root:minDepth<1}],phase:0}];
  while(frames.length){const frame=frames.at(-1)!,node=frame.node;
   if(node.op!=='test'){
    if(frame.phase===0){frame.phase=1;frames.push({node:node.left,flows:frame.flows,phase:0});continue;}
    const left=results.get(node.left)!;
    if(node.op==='!'){results.set(node,{t:left.f,f:left.t});frames.pop();continue;}
    if(frame.phase===1){frame.phase=2;frames.push({node:node.right!,flows:node.op==='&'?left.t:node.op==='|'?left.f:uniq([...left.t,...left.f]),phase:0});continue;}
    const right=results.get(node.right!)!;results.set(node,node.op==='&'?{t:right.t,f:uniq([...left.f,...right.f])}:node.op==='|'?{t:uniq([...left.t,...right.t]),f:right.f}:right);frames.pop();continue;
   }
   const name=node.name,flows=frame.flows;let t=flows,f=flows;
   if(name==='-false'){t=[];}
   else if(name==='-true'||name==='-prune'||/^-print\w*$/.test(name)||name==='-delete'||node.command)f=[];
   const matchAll=/regex$/.test(name)?/^(?:\.\*)+$/.test(node.value??''):['*','**','*/*'].includes(node.value??'');
   if(restrictive.test(name)&&!matchAll)t=flows.map(flow=>({restricted:true,root:flow.root&&/name|path|regex/.test(name)&&root.k==='known'&&patternMatches(name,node.value??'',root.s)}));
   if(flows.length&&(name==='-delete'||node.command||/^-print0?$/.test(name))){
    const wholeTree=flows.some(flow=>!flow.restricted),rootSelf=flows.some(flow=>flow.root);
    const entry:Value=root.k==='known'?{...opaque('find-entry'),entryOf:{start:root.s,wholeTree,rootSelf}}:opaque('find-entry');
    if(!produceOnly&&name==='-delete'&&wholeTree)effects.push(effectRecord({k:'delete',target:root,recursive:true,follow:inv.argv.some(v=>v.k==='known'&&/^-[LH]$/.test(v.s))},inv));
    if(/^-print0?$/.test(name))printed.push(entry);
    if(node.command&&!produceOnly){
     const argv=node.command.map(value=>value.k==='known'&&value.s==='{}'?entry:value);
     // find executes an argv directly; PowerShell aliases never apply inside -exec.
     const state:ShellState={home:inv.home??'',env:new Map(inv.env),cwd:/dir$/.test(name)?opaque('find-entry-dir'):inv.cwd,dialect:'sh',depth:0,platform:inv.platform,drive:inv.drive,links:inv.links};
     effects.push(...peel(argv,state).flatMap(effectRecordsOf));
    }
   }
   results.set(node,{t:uniq(t),f:uniq(f)});frames.pop();
  }
 }
 // Item 4(d): an absolute payload does not depend on where find starts; with an unknown start, read every -exec argv once.
 if(!produceOnly&&roots.some(root=>root.k==='opaque'))for(const unit of units)if(unit.op==='test'&&unit.command){
  const argv=unit.command.map(value=>value.k==='known'&&value.s==='{}'?opaque('find-entry'):value);
  const state:ShellState={home:inv.home??'',env:new Map(inv.env),cwd:opaque('find-entry-dir'),dialect:'sh',depth:0,platform:inv.platform,drive:inv.drive,links:inv.links};
  effects.push(...peel(argv,state).flatMap(effectRecordsOf));
 }
 if(printed.length)inv.stdout=printed;
 return effects;
}

export function findEffects(inv:Invocation,produceOnly=false):WipeEffect[] {return findRecords(inv,produceOnly).map(record=>record.effect);}
