// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Script, Node, Word, WordPart, SimpleCommand, Redirect } from './types.ts';
export function parsePwsh(text:string, depth=0):Script {
 // PowerShell line endings normalize here; POSIX heredoc delimiters retain their CR bytes.
 text=text.replace(/\r\n?/g,'\n');
 if(depth>16)return {nodes:[{k:'residual',text,dialect:'pwsh',span:[0,text.length]}],incompleteTail:false};
 let i=0,incompleteTail=false,start=0;
 const nodes:Node[]=[],stages:Node[]=[];
 const command=():SimpleCommand=>({assigns:[],words:[],redirects:[]});let c=command();
 const flush=()=>{const part=c.words[0]?.parts[0];if(c.words.length===1&&c.words[0]?.parts.length===1&&part?.k==='block'&&!c.assigns.length&&!c.redirects.length)stages.push({k:'block',body:part.body,span:[start,i]});else if(c.words.length||c.assigns.length||c.redirects.length)stages.push({k:'cmd',c,span:[start,i]});c=command();start=i;};
 const end=()=>{flush();if(stages.length)nodes.push(stages.length===1?stages[0]!: {k:'pipe',stages:stages.slice(),span:[stages[0]!.span[0],stages.at(-1)!.span[1]]});stages.length=0;};
 const read=():Word=>{
  const start=i,parts:WordPart[]=[];let quote='',lit='',array=false,here=false;
  const put=()=>{if(lit){parts.push({k:'lit',s:lit,quoted:!!quote});lit='';}};
  while(i<text.length){const ch=text[i]!;
   // Here-strings are quoted operands. Their framing newlines are not value bytes.
   if(!quote&&i===start&&ch==='@'&&(text[i+1]==='"'||text[i+1]==="'")&&text[i+2]==='\n'){
    quote=text[i+1]!;here=true;i+=3;continue;
   }
   if(here&&(ch==='\n'&&text.startsWith(quote+'@',i+1)||text[i-1]==='\n'&&text.startsWith(quote+'@',i))){
    put();i+=ch==='\n'?3:2;quote='';here=false;continue;
   }
   if((i===start||quote&&i===start+1)&&text.startsWith('\\\\?\\',i)){i+=4;continue;}
   if(!quote&&array&&/\s/.test(ch)){i++;continue;}
   if(!quote&&text.startsWith('@(',i)){put();array=true;i+=2;continue;}
   if(!quote&&array&&ch===')'){i++;array=false;continue;}
   if(!quote&&ch==='{'){
    put();i++;const at=i;let level=1,q='';while(i<text.length){const a=text[i++]!;if(a==='`'){i++;continue;}if(q){if(a===q)q='';continue;}if(a==='"'||a==="'"){q=a;continue;}if(a==='{')level++;if(a==='}'&&--level===0)break;}
    parts.push({k:'block',body:parsePwsh(text.slice(at,level?i:i-1),depth+1)});continue;
   }
   if(!quote&&/[\s;|&<>]/.test(ch))break;
   if(!quote&&ch===','){put();parts.push({k:'lit',s:'\u0000,',quoted:false});i++;while(/\s/.test(text[i]??'')&&i<text.length)i++;continue;}
   if(ch==='`'&&quote!=="'"&&text[i+1]==='\n'){i+=2;continue;}
   if(ch==='`'&&quote!=="'"){put();i++;parts.push({k:'lit',s:text[i++]??'',quoted:true});continue;}
   if(!here&&(ch==="'"||ch==='"')&&(!quote||ch===quote)){
    if(ch==="'"&&quote==="'"&&text[i+1]==="'"){lit+="'";i+=2;continue;}
    put();quote=quote?'':ch;i++;continue;
   }
   if(ch==='$'&&quote!=="'"){
    put();i++;
    if(text[i]==='('){i++;const at=i;let balance=1,q='';while(i<text.length){const a=text[i++]!;if(a==='`'){i++;continue;}if(q){if(a===q)q='';continue;}if(a==='"'||a==="'"){q=a;continue;}if(a==='(')balance++;if(a===')'&&--balance===0)break;}
     if(balance)incompleteTail=true;parts.push({k:'subst',body:parsePwsh(text.slice(at,balance?i:i-1),depth+1)});continue;}
    const variable=/^(?:\{[^}]+\}|[\w:]+)/i.exec(text.slice(i));
    if(variable){parts.push({k:'var',name:variable[0].replace(/^\{|\}$/g,'').replace(/^(?:env|global|script|local|private):/i,''),quoted:!!quote});i+=variable[0].length;const member=/^\.(?:FullName|PSPath|ProviderPath|Path)\b(?!\()/i.exec(text.slice(i));if(member)i+=member[0].length;}else lit+='$';continue;
   }
   if(ch==='~'&&i===start){parts.push({k:'tilde'});i++;continue;}
   if(!quote&&'*?['.includes(ch)){put();parts.push({k:'glob',s:ch});i++;continue;}
   lit+=ch;i++;
  }
  put();if(quote)incompleteTail=true;
  return {raw:text.slice(start,i),parts:parts.length?parts:[{k:'lit',s:'',quoted:true}]};
 };
 while(i<text.length){const ch=text[i]!;
  if(/[ \t\r\f\v]/.test(ch)){i++;continue;}
  if(ch==='#'){while(i<text.length&&text[i]!=='\n')i++;continue;}
  if(text.startsWith('<#',i)){const e=text.indexOf('#>',i+2);if(e<0){incompleteTail=true;break;}i=e+2;continue;}
  if(ch==='|'&&text[i+1]!=='|'){flush();i++;/* a pipeline continues on the next line after its pipe */while(i<text.length&&/\s/.test(text[i]!))i++;continue;}
  if(';\n|'.includes(ch)||ch==='&'&&text[i+1]==='&'){end();i+=text[i+1]===ch?2:1;continue;}
  if(ch==='&'||!c.words.length&&ch==='.'&&/\s/.test(text[i+1]??'')){c.words.push({raw:ch,parts:[{k:'lit',s:ch,quoted:false}]});i++;continue;}
  if(!c.words.length&&!c.assigns.length){
   const definition=/^(?:function|filter)\s+([\w:-]+)\s*/i.exec(text.slice(i));
   if(definition){i+=definition[0].length;const body=read().parts.find(p=>p.k==='block');if(body?.k==='block')nodes.push({k:'func',name:definition[1]!,body:body.body,span:[start,i]});start=i;continue;}
   const control=stages.length?null:/^(?:if|elseif|else|foreach|for|while|do|switch|try|catch|finally)(?![\w-])/i.exec(text.slice(i));
   if(control){const head=i;let q='';while(i<text.length){const a=text[i]!;if(q){if(a===q)q='';}else if(a==='"'||a==="'")q=a;else if(a==='{')break;i++;}
    // foreach ($x in <producer>) { body } is the producer piped into the body with $x bound.
    const each=/^foreach\s*\(\s*\$([\w:]+)\s+in\s+([\s\S]*)\)\s*$/i.exec(text.slice(head,i));
    if(i<text.length){const block=read(),body=block.parts.find(p=>p.k==='block');if(body?.k==='block'){const producer=each?parsePwsh((/^\(([\s\S]*)\)\s*$/.exec(each[2]!)?.[1]??each[2]!)+' | x',depth+1).nodes[0]:undefined;
      if(each&&producer?.k==='pipe'&&depth<16){const word=(raw:string):Word=>({raw,parts:[{k:'lit',s:raw,quoted:false}]});nodes.push({k:'pipe',stages:[...producer.stages.slice(0,-1),{k:'cmd',c:{assigns:[],words:[word('foreach-object'),word('\0var:'+each[1]!.replace(/^(?:env|global|script|local|private):/i,'')),block],redirects:[]},span:[start,i]}],span:[start,i],cond:true});}
      else nodes.push({k:'group',body:body.body,span:[start,i],cond:true});}}start=i;continue;}
   const assignment=/^(?:\[[^\]]+\]\s*)?\$(\{[^}]+\}|[\w:]+)(?:\.\w+|\[[^\]]+\])?\s*(\?\?=|[+*\/%-]?=)\s*/.exec(text.slice(i));
   if(assignment){
    i+=assignment[0].length;const name=assignment[1]!.replace(/^\{|\}$/g,'').replace(/^(?:env|global|script|local|private):/i,'');
    if(/[a-z_]/i.test(text[i]??'')){c.assigns.push({name,value:{raw:'',parts:[{k:'var',name:'command-result',op:'other',quoted:false}]}});}
    else {const value=read();if(assignment[2]!== '='&&assignment[2]!=='??=')value.parts.unshift({k:'var',name,quoted:true});c.assigns.push({name,value});continue;}
   }
  }
  const red=/^(\d+)?(>>|>&|>|<)/.exec(text.slice(i));
  if(red){i+=red[0].length;while(/\s/.test(text[i]??'')&&i<text.length)i++;c.redirects.push({fd:red[1]?Number(red[1]):undefined,op:red[2] as Redirect['op'],target:read()});continue;}
  const w=read();
  const assign=!c.words.length?/^\$(?:env:)?(\w+)=(.*)$/is.exec(w.raw):null;
  if(assign){const prefix=assign[0].length-assign[2]!.length;const value=parsePwsh('x '+w.raw.slice(prefix),depth+1).nodes[0];c.assigns.push({name:assign[1]!,value:value?.k==='cmd'?value.c.words[1]!:w});}
  else c.words.push(w);
 }
 end();return {nodes,incompleteTail,source:text};
}
