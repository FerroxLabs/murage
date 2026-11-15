// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Script, Node, Word, WordPart, SimpleCommand, Redirect } from './types.ts';
export function parseCmd(text:string):Script {
 let i=0,incompleteTail=false,start=0,groups=0;
 const nodes:Node[]=[],command=():SimpleCommand=>({assigns:[],words:[],redirects:[]});let c=command();
 const flush=()=>{if(c.words.length||c.redirects.length)nodes.push({k:'cmd',c,span:[start,i]});c=command();start=i;};
 const read=():Word=>{const start=i,parts:WordPart[]=[];let quote=false,lit='';const put=()=>{if(lit){parts.push({k:'lit',s:lit,quoted:quote});lit='';}};
  while(i<text.length){const ch=text[i]!;if((i===start||quote&&i===start+1)&&text.startsWith('\\\\?\\',i)){i+=4;continue;}if(!quote&&/[\s&|<>]/.test(ch))break;if(!quote&&ch===')'&&groups>0)break;
   if(ch==='^'&&text[i+1]==='\n'){i+=2;continue;}
   if(ch==='^'){put();i++;parts.push({k:'lit',s:text[i++]??'',quoted:true});continue;}
   // A PowerShell host splits its own command line: backslash-quote is a literal quote inside its -Command text.
   if(ch==='\\'&&text[i+1]==='"'&&/^(?:pwsh|powershell)(?:\.exe)?$/i.test(c.words[0]?.raw??'')){put();parts.push({k:'lit',s:'"',quoted:true});i+=2;continue;}
   if(ch==='"'){put();quote=!quote;i++;continue;}
   if(ch==='!'){const end=text.indexOf('!',i+1);if(end>=0){put();parts.push({k:'var',name:text.slice(i+1,end),delayed:true,quoted:quote});i=end+1;continue;}}
   if(ch==='%'){put();if(text[i+1]==='~'){i+=2;while(i<text.length&&/[a-z0-9]/i.test(text[i]!))i++;parts.push({k:'var',name:'cmd-parameter',op:'other',quoted:quote});continue;}const loop=/^%%?([a-z])(?![\w()]*%)/i.exec(text.slice(i));if(loop){parts.push({k:'var',name:'for:'+loop[1],quoted:quote});i+=loop[0].length;continue;}const e=text.indexOf('%',i+1);if(e>=0&&/^[^\s"&|<>^]+$/.test(text.slice(i+1,e))){parts.push({k:'var',name:text.slice(i+1,e),op:text[i+1]==='~'?'other':undefined,quoted:quote});i=e+1;continue;}}
   if('*?'.includes(ch)){put();parts.push({k:'glob',s:ch});i++;continue;}
   lit+=ch;i++;
  }
  put();incompleteTail ||= quote;return {raw:text.slice(start,i),parts:parts.length?parts:[{k:'lit',s:'',quoted:true}]};
 };
 while(i<text.length){const ch=text[i]!;
  if(ch===' '||ch==='\t'||ch==='\r'){i++;continue;}
  if('&|\n'.includes(ch)){flush();i+=text[i+1]===ch?2:1;continue;}
  if(ch==='@'&&!c.words.length){i++;continue;}
  // Parentheses group commands; a FOR set stays inside its own command.
  if(ch==='('){groups++;i++;continue;}
  if(ch===')'&&groups>0){groups--;i++;if(!/^for$/i.test(c.words[0]?.raw??'')||c.words.some(w=>/^do$/i.test(w.raw)))flush();continue;}
  const red=/^(\d+)?(>>|>&|>|<)/.exec(text.slice(i));
  if(red){i+=red[0].length;while(text[i]===' '||text[i]==='\t')i++;c.redirects.push({op:red[2] as Redirect['op'],fd:red[1]?Number(red[1]):undefined,target:read()});continue;}
  c.words.push(read());
 }
 flush();return {nodes,incompleteTail,source:text};
}
