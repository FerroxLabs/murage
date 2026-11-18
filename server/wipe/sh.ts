// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Node, Script, Word, WordPart, Redirect, SimpleCommand } from './types.ts';
const command = (): SimpleCommand => ({assigns:[],words:[],redirects:[]});
/** A syntax reader only: no filesystem, environment, or execution. */
// A script that redefines true, false or `:`, or runs eval, alias, source or `.`, keeps no certainty about its own and/or lists.
// Only an executable definition or command counts: the same words as arguments, quoted text or comments are inert.
const shadowsBoolean=/(?:^|[\s;&|({])(?:true|false|:)\s*\(\s*\)|\bfunction\s+(?:true|false|:)(?=[\s({]|$)|(?:^|[\s;&|({])(?:eval|alias|source|\.)(?=[\s;&|)]|$)/;
const booleanName=/^(?:true|false|:)$/,shadowCommand=/^(?:eval|alias|source|\.)$/,passThrough=/^(?:command|builtin|-.*)$/;
const plain=(w:Word)=>w.parts.every(p=>p.k==='lit')?w.parts.map(p=>p.k==='lit'?p.s:'').join(''):'';
/** `uncertain` is set by a caller whose shell state already redefines a Boolean (an inherited or earlier function). */
export function parseSh(text: string, depth = 0, uncertain = false): Script {
 const first=readSh(text,depth,uncertain);
 return first.shadow&&!uncertain?readSh(text,depth,true).script:first.script;
}
function readSh(text: string, depth: number, noCertainty: boolean): {script:Script;shadow:boolean} {
 if (depth > 16) return {script:{nodes:[{k:'residual',text,dialect:'sh',span:[0,text.length]}],incompleteTail:false},shadow:shadowsBoolean.test(text)};
 let shadow=false,negated=false;
 // A nested body shares this reading's certainty and reports any shadow it holds to the whole script.
 const sub=(inner:string):Script=>{const read=readSh(inner,depth+1,noCertainty);shadow ||= read.shadow;return read.script;};
 let i=0, incompleteTail=false,start=0,conditional=0;let pendingConditional=false,pendingNever=false,chainOk=false;
 const nodes: Node[]=[], pipeline: Node[]=[];
 let c=command();const controlStarts:number[]=[];let redirectReceiver:Node[]=[];
 const documents: {c:SimpleCommand;r:Redirect;delimiter:string;tabs:boolean}[]=[];
 const finishCommand=()=>{
  if(!c.words.length&&!c.assigns.length&&c.redirects.length&&(pipeline.at(-1)?.k==='group'||pipeline.at(-1)?.k==='subshell'||redirectReceiver.length)){
   const queue=redirectReceiver.length?redirectReceiver.slice():[pipeline.at(-1)!];while(queue.length){const node=queue.pop()!;if(node.k==='cmd')node.c.redirects.push(...c.redirects);else if(node.k==='group'||node.k==='subshell')queue.push(...node.body.nodes);else if(node.k==='pipe')queue.push(...node.stages);else if(node.k==='list')queue.push(...node.items);}redirectReceiver=[];
  }else if(c.words.length||c.assigns.length||c.redirects.length)pipeline.push({k:'cmd',c,span:[start,i],cond:conditional>0||pendingConditional});
  c=command();start=i;
 };
 const finish=(join=';')=>{finishCommand();const had=pipeline.length===1,pushed=pipeline.length>0;if(pipeline.length)nodes.push(pipeline.length===1?pipeline[0]!: {k:'pipe',stages:pipeline.slice(),span:[pipeline[0]!.span[0],pipeline.at(-1)!.span[1]]});pipeline.length=0;if(nodes.length)nodes.at(-1)!.join=join;
  // Item 4(f): an and/or list is read left to right. `true`, `:` and a plain assignment always succeed, so what
  // follows their `&&` is as certain as they are, and what follows their `||` never runs and leaves the status alone.
  const last=had?nodes.at(-1):undefined,wasNever=pendingNever,wasCond=pendingConditional||conditional>0;
  if(pushed&&!wasNever)chainOk=!!(!noCertainty&&!negated&&!wasCond&&last?.k==='cmd'&&!last.c.redirects.length&&(last.c.words.length===1&&!last.c.assigns.length&&(last.c.words[0]!.raw==='true'||last.c.words[0]!.raw===':')||!last.c.words.length&&last.c.assigns.length>0&&last.c.assigns.every(a=>a.value.parts.every(p=>p.k==='lit'||p.k==='var'&&!p.op))));
  if(join==='&&'){pendingNever=false;pendingConditional=!chainOk;}
  else if(join==='||'){pendingNever=chainOk;pendingConditional=true;}
  else{pendingNever=false;pendingConditional=false;chainOk=false;}
  negated=false;start=i;};
 const nested=(end:string):Script=>{
  const start=i;let level=1,quote='';const heredocs:string[]=[];
  while(i<text.length){
   const ch=text[i++]!;
   if(ch==='\\'&&quote!=="'"){i++;continue;}
   if(quote){if(ch===quote)quote='';continue;}
   // A here-document body inside a substitution is data: its quotes and parentheses close nothing.
   if(ch==='<'&&text[i]==='<'&&text[i+1]!=='<'&&text[i-2]!=='<'&&end!=='`'){const m=/^<-?[ \t]*(['"]?)([\w.-]+)\1/.exec(text.slice(i));if(m){heredocs.push(m[2]!);i+=m[0].length;continue;}}
   if(ch==='\n'&&heredocs.length){for(const name of heredocs.splice(0)){const stop=new RegExp('(?:^|\\n)\\t*'+name.replace(/[.\-]/g,'\\$&')+'(?=\\n|$)').exec(text.slice(i));if(stop)i+=stop.index+stop[0].length;}continue;}
   if(ch==='"'||ch==="'"||ch==='`'&&end!=='`'){quote=ch;continue;}
   if(end===')'&&ch==='(')level++;
   if(ch===end){level--;if(level===0)break;}
  }
  // The explicit loop below does not consume any source outside this body.
  const closed=text[i-1]===end;
  if(!closed)incompleteTail=true;
  const body=sub(text.slice(start,closed?i-1:i));
  incompleteTail ||= body.incompleteTail;return body;
 };
 const word=():Word=>{
  const start=i,parts:WordPart[]=[];let quote='',lit='',litQuoted=false,hadQuote=false;
  const flush=()=>{if(lit){parts.push({k:'lit',s:lit,quoted:litQuoted});lit='';}};
  const add=(s:string,quoted:boolean)=>{if(lit&&litQuoted!==quoted)flush();litQuoted=quoted;lit+=s;};
  const substitution=(end:string)=>{flush();parts.push({k:'subst',body:nested(end),quoted:!!quote});};
  while(i<text.length){
   // Consume literal runs together; a long executable word remains linear.
   if(!quote){const chunk=/^[^\s;|&()<>'"\\$`~*?\[]+/.exec(text.slice(i));if(chunk){add(chunk[0],false);i+=chunk[0].length;continue;}}
   if(quote==="'"){const end=text.indexOf("'",i);const stop=end<0?text.length:end;if(stop>i){add(text.slice(i,stop),true);i=stop;if(i===text.length)break;}}
   const ch=text[i]!;
   if(!quote&&(/[\s;|&()<>]/.test(ch))&&!(ch==='<'&&text[i+1]==='(')&&!(ch==='>'&&text[i+1]==='('))break;
   if(ch==='\\'&&quote!=="'"){
    const next=text[i+1];
    if(next==='\n'){i+=2;continue;}
    // Keep literal Windows separators when a drive/UNC word is supplied.
    if(!quote&&/^(?:[a-z]:|\\\\)/i.test(text.slice(start).replace(/^\w+=/,''))){add(ch,false);i++;continue;}
    if(next!==undefined&&(!quote||/[$`"\\\n]/.test(next))){add(next,true);i+=2;continue;}
    add(ch,!!quote);i++;continue;
   }
   if(ch==="'"&&quote!=='"'){if(quote==="'")quote='';else{flush();hadQuote=true;quote="'";}i++;continue;}
   if(ch==='"'&&quote!=="'"){if(quote==='"')quote='';else{flush();hadQuote=true;quote='"';}i++;continue;}
   if(quote==="'"){add(ch,true);i++;continue;}
   if(ch==='$'&&text[i+1]==="'"&&!quote){
    flush();i+=2;let ansi='';let closed=false;
    while(i<text.length){const a=text[i++]!;if(a==="'"){closed=true;break;}if(a!=='\\'){ansi+=a;continue;}
     const tail=text.slice(i),m=/^(?:x([0-9a-fA-F]{1,2})|([0-7]{1,3})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8}))/.exec(tail);
     if(m){ansi+=String.fromCodePoint(Math.min(0x10ffff,parseInt(m[1]??m[2]??m[3]??m[4]!,m[2]?8:16)));i+=m[0].length;}
     else{const e=text[i++]??'';ansi+=e==='c'?String.fromCharCode((text[i++]??'@').toUpperCase().charCodeAt(0)&31):({"a": "\u0007", "b": "\b", "e": "\u001b", "E": "\u001b", "f": "\f", "n": "\n", "t": "\t", "r": "\r", "v": "\u000b", "\\": "\\", "'": "'", "\"": "\"", "?": "?"} as Record<string,string>)[e]??'\\'+e;}}
    if(!closed)incompleteTail=true;parts.push({k:'lit',s:ansi.split('\0')[0]!,quoted:true});continue;
   }
   if(ch==='$'&&text[i+1]==='\"'&&!quote){i++;continue;}
   if((ch==='$'||ch==='<'||ch==='>')&&text[i+1]==='('){i+=2;substitution(')');continue;}
   if(ch==='`'){i++;substitution('`');continue;}
   if(ch==='$'){
    flush();i++;
    if(text[i]==='{'){
     i++;const at=i;let balance=1;
     while(i<text.length&&balance){if(text[i]==='{')balance++;else if(text[i]==='}')balance--;if(balance)i++;}
     const inner=text.slice(at,i);if(balance)incompleteTail=true;else i++;
     const m=/^(#?)([\w@*#]+(?:\[(?:@|\*|\d+)\])?)(?:(:-|:\?|:=|:\+|##|%%|-|\?|=|\+|#|%|:)([\s\S]*))?$/.exec(inner);
     if(m){const arg=m[4]===undefined?undefined:sub('x '+m[4]).nodes[0];parts.push({k:'var',name:m[2]!,op:(m[1]?'length':m[3]) as any,arg:arg?.k==='cmd'?arg.c.words[1]:undefined,quoted:!!quote});}
     else{
      // MAIN RULING 2026-11-13 / 1114 item 4(c): a substitution inside any parameter expansion still executes.
      // Every substitution is kept. Past a parsing budget the rest of the text is read for wipe evidence instead.
      const subs:WordPart[]=[];let work=0;
      for(let k=0;k<inner.length;k++){
       if(inner[k]==='\\'){k++;continue;}
       if(inner[k]==="'"&&!quote){const close=inner.indexOf("'",k+1);if(close<0)break;k=close;continue;}
       if(inner[k]==='$'&&inner[k+1]==='('||inner[k]==='`'){if((work+=inner.length-k)>262144){subs.push({k:'subst',body:{nodes:[{k:'residual',text:inner.slice(k),dialect:'sh',span:[0,0]}],incompleteTail:false}});break;}const row=sub('x '+inner.slice(k)).nodes[0],cmd=row?.k==='pipe'?row.stages[0]:row,part=cmd?.k==='cmd'?cmd.c.words[1]?.parts[0]:undefined;if(part?.k==='subst')subs.push(part);}
      }
      parts.push({k:'var',name:inner,op:'other',...(subs.length?{arg:{raw:inner,parts:subs}}:{}),quoted:!!quote});
     }
    }else{const m=/^(?:[0-9@*#]|[a-zA-Z_]\w*)/.exec(text.slice(i));if(m){parts.push({k:'var',name:m[0],quoted:!!quote});i+=m[0].length;}else add('$',!!quote);}
    continue;
   }
   if(ch==='~'&&!quote&&(!parts.length&&!lit&&!hadQuote||/^\w+=.*(?:^|:)$|^\w+=$/.test(text.slice(start,i).replace(/\\\n/g,'')))){flush();i++;const m=/^[^\s/;|&\"']*/.exec(text.slice(i))![0];if(/[\"']/.test(text[i+m.length]??'')){add('~',false);continue;}i+=m.length;parts.push({k:'tilde',...(m?{user:m}:{})});continue;}
   if(!quote&&ch==='['&&(/\s/.test(text[i+1]??'')||text[i+1]==='['&&/\s/.test(text[i+2]??''))){const token=text[i+1]==='['?'[[':'[';add(token,true);i+=token.length;continue;}
   if(!quote&&'*?['.includes(ch)){
    flush();let glob=ch;i++;
    if(ch==='['){while(i<text.length){const a=text[i++]!;glob+=a;if(a===']')break;}}
    parts.push({k:'glob',s:glob});continue;
   }
   add(ch,!!quote);i++;
  }
  flush();if(quote)incompleteTail=true;
  if(!parts.length)parts.push({k:'lit',s:'',quoted:true});
  return {raw:text.slice(start,i),parts};
 };
 let header: 'for'|'case'|undefined;
 while(i<text.length){
  if(text[i]===' '||text[i]==='\t'||text[i]==='\r'){i++;continue;}
  if(text[i]==='#'){while(i<text.length&&text[i]!=='\n')i++;continue;}
  const ch=text[i]!;
  if(ch==='\n'){
   finish();i++;
   for(const d of documents.splice(0)){
    const lines:string[]=[];let closed=false;
    while(i<text.length){const end=text.indexOf('\n',i),stop=end<0?text.length:end;let line=text.slice(i,stop);i=end<0?text.length:end+1;if(d.tabs)line=line.replace(/^\t+/,'');if(line===d.delimiter){closed=true;break;}lines.push(line);}
    if(!closed)incompleteTail=true;d.r.heredoc=lines.join('\n');d.c.stdinHeredoc=d.r.heredoc;
   }
   header=undefined;continue;
  }
  if(!c.words.length&&!c.assigns.length){
   const definition=/^(?:(?:function\s+)([\w:.-]+)(?:\s*\(\s*\))?|([\w:.-]+)\s*\(\s*\))\s*([({])/.exec(text.slice(i));
   if(/^(?:true|false|:)\s*\(\s*\)/.test(text.slice(i,i+64)))shadow=true;
   if(definition){
    if(booleanName.test(definition[1]??definition[2]!))shadow=true;
    // A definition behind an and/or list may be skipped: the earlier body of that name stays callable.
    const maybe=conditional>0||pendingConditional;
    finish();const begin=i;i+=definition[0].length;const at=i,open=definition[3]!,end=open==='('?')':'}';let balance=1,q='';
    while(i<text.length){const a=text[i++]!;if(a==='\\'&&q!=="'"){i++;continue;}if(q){if(a===q)q='';continue;}if(a==='"'||a==="'"){q=a;continue;}if(a===open)balance++;if(a===end&&--balance===0)break;}
    nodes.push({k:'func',name:definition[1]??definition[2]!,body:sub(text.slice(at,balance?i:i-1)),span:[begin,i],cond:maybe});start=i;continue;
   }
  }
  // Process substitutions are word syntax, not redirects.
  const redirect=/^(?:(\d+)?(<<<|<<-|<<|&>>|&>|>>|>&|<&|<>|>\||>|<))/.exec(text.slice(i));
  if(redirect&&!(text[i+redirect[0].length]==='('&&/^[<>]$/.test(redirect[2]!))){
   i+=redirect[0].length;while(text[i]===' '||text[i]==='\t')i++;
   const target=word(),r:Redirect={op:redirect[2] as Redirect['op'],target,...(redirect[1]?{fd:Number(redirect[1])}:{})};r.expanding=!target.parts.some(p=>p.k==='lit'&&p.quoted);c.redirects.push(r);
   if(r.op==='<<'||r.op==='<<-')documents.push({c,r,delimiter:target.parts.map(p=>p.k==='lit'?p.s:p.k==='var'?'$'+p.name:'').join(''),tabs:r.op==='<<-'});
   continue;
  }
  if(ch==='|'&&text[i+1]!=='|'){finishCommand();i+=text[i+1]==='&'?2:1;continue;}
  if(';|&'.includes(ch)){finish(text[i+1]===ch?ch+ch:ch);i+=text[i+1]===ch?2:1;if(header==='for')header=undefined;continue;}
  if(ch==='('||ch==='{'&&/\s/.test(text[i+1]??'')){
   finishCommand();i++;const at=i,end=ch==='('?')':'}';let level=1,q='';
   while(i<text.length){const a=text[i++]!;if(a==='\\'&&q!=="'"){i++;continue;}if(q){if(a===q)q='';continue;}if(a==='"'||a==="'"){q=a;continue;}if(a===ch)level++;if(a===end&&--level===0)break;}
   const closed=level===0;if(!closed)incompleteTail=true;
   // A group behind an and/or list may be skipped, exactly like a simple command there: its assignments only add alternatives.
   const script=sub(text.slice(at,closed?i-1:i));pipeline.push({k:ch==='('? 'subshell':'group',body:script,span:[at-1,i],cond:conditional>0||pendingConditional});start=i;continue;
  }
  if(ch===')'||ch==='}') {if(header==='case')header=undefined;finish();i++;continue;}
  const w=word();if(i===0&&w.raw==='')i++;
  if(!c.words.length&&['while','until'].includes(w.raw)){
   const begin=i;let cursor=i,q='',level=1,bodyAt=-1,bodyEnd=-1,end=-1;
   while(cursor<text.length){const ch=text[cursor]!;if(ch==='\\'&&q!=="'"){cursor+=2;continue;}if(q){if(ch===q)q='';cursor++;continue;}if(ch==='"'||ch==="'"){q=ch;cursor++;continue;}
    const token=/^[a-zA-Z_]+/.exec(text.slice(cursor));if(!token){cursor++;continue;}const name=token[0],at=cursor;cursor+=name.length;
    if(['for','while','until','select'].includes(name))level++;if(name==='do'&&bodyAt<0){bodyAt=cursor;bodyEnd=at;}if(name==='done'&&--level===0){end=at;break;}
   }
   if(bodyAt>=0&&end>=0){const condition=text.slice(begin,bodyEnd).replace(/[;\s]+$/,''),body=text.slice(bodyAt,end);pipeline.push({k:'group',body:sub(condition+';'+body),cond:true,span:[start,cursor]});i=cursor;start=i;continue;}
  }
  if(!c.words.length&&/^(?:if|then|elif|else|fi|for|in|do|done|while|until|case|esac|function|select|!|coproc)$/.test(w.raw)){
   if(w.raw==='!')negated=true;
   if(w.raw==='if')controlStarts.push(nodes.length);if(w.raw==='fi')redirectReceiver=nodes.slice(controlStarts.pop()??nodes.length);
   if(['if','case','for','while','until','select'].includes(w.raw))conditional++;
   if(['fi','esac','done'].includes(w.raw))conditional=Math.max(0,conditional-1);
   if(w.raw==='for'||w.raw==='select'){
    while(text[i]===' '||text[i]==='\t')i++;const variable=word(),values:Word[]=[];
    while(text[i]===' '||text[i]==='\t')i++;
    if(text.slice(i,i+2)==='in'){i+=2;while(i<text.length&&!/[;\n]/.test(text[i]!)){if(/\s/.test(text[i]!)){i++;continue;}const at=i,value=word();if(i===at){i++;continue;}values.push(value);}}
    c.assigns.push({name:variable.raw,value:{raw:'',parts:[{k:'array',words:values,loop:true}]}});finish();header=undefined;
   }else if(w.raw==='case'){header='case';}
   else if(w.raw==='do'||w.raw==='then'||w.raw==='esac')header=undefined;
   continue;
  }
  if(header){if(header==='case'&&text[i]===')'){i++;header=undefined;}continue;}
  const assignment=!c.words.length?/^([a-zA-Z_]\w*)=/.exec(w.raw):null;
  if(assignment&&text[i]==='('){i++;const values:Word[]=[];while(i<text.length&&text[i]!==')'){if(/\s/.test(text[i]!)){i++;continue;}const at=i,value=word();if(i===at){i++;continue;}values.push(value);}if(text[i]===')')i++;c.assigns.push({name:assignment[1]!,value:{raw:w.raw,parts:[{k:'array',words:values}]}});continue;}
  if(assignment){const prefix=assignment[0].length;const first=w.parts[0];const parts=w.parts.slice();if(first?.k==='lit')parts[0]={...first,s:first.s.slice(prefix)};c.assigns.push({name:assignment[1]!,value:{raw:w.raw.slice(prefix),parts}});}
  else{if(shadowCommand.test(plain(w))&&c.words.every(head=>passThrough.test(plain(head))))shadow=true;c.words.push(w);}
 }
 finish();if(documents.length)incompleteTail=true;
 return {script:{nodes,incompleteTail,source:text},shadow};
}
