// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Disposable Windows tool protocol fixture. Runs as an actual child so spawn,
 * framing, timeout and exact-child cleanup tests exercise the production bridge. */
export const SIGNAL_SECURITY_HELPER=String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
function answer(request){
 const env=request.env;
 if(env.SIGNAL_HELPER_MODE==='hang')return;
 if(env.SIGNAL_HELPER_MODE==='exit'){process.exit(3);return;}
 if(env.SIGNAL_HELPER_MODE==='malformed'){console.log(request.token+'{bad');return;}
 if(env.SIGNAL_HELPER_MODE==='partial'){console.log(request.token+JSON.stringify({ok:false,output:'partial'}));return;}
 if(env.SIGNAL_HELPER_MODE==='echo'){console.log(request.token+JSON.stringify({ok:true,output:request.input}));return;}
 const sid='S-1-5-21-1-2-3-1001',sddl='O:'+sid+'D:P(A;OICI;FA;;;'+sid+')(A;OICI;FA;;;SY)';
 let output='';
 if(env.MURAGE_SIGNAL_NEW)output='MURAGE_SIGNAL_PROTECTED';
 else {
  const rows=[],seen=new Set(),trees=JSON.parse(env.MURAGE_SIGNAL_TREES||'[]');
  const visit=(p,recurse)=>{
   if(seen.has(p))return;seen.add(p);const stat=fs.lstatSync(p);
   rows.push({path:p,attributes:(stat.isDirectory()?16:0)|(stat.isSymbolicLink()?1024:0),sddl});
   if(recurse&&stat.isDirectory()&&!stat.isSymbolicLink())for(const name of fs.readdirSync(p))visit(path.join(p,name),true);
  };
  for(const p of JSON.parse(env.MURAGE_SIGNAL_ROOTS||'[]'))visit(p,env.MURAGE_SIGNAL_TREE===p||trees.includes(p));
  output=rows.map(row=>JSON.stringify(row)).join('\n');
 }
 console.log(request.token+JSON.stringify({ok:true,output}));
}
const lines=readline.createInterface({input:process.stdin});
if(process.argv.includes('--powershell-protocol')){
 let script=[],token;
 lines.on('line',line=>{
  script.push(line);
  const marker=/^'(MURAGE_SECURITY_[a-f0-9]+:)' [+] /.exec(line);
  if(marker){token=marker[1];return;}
  if(token&&line==='}'){
   const env={};
   for(const statement of script){
    const assignment=/^[$]env:([A-Z_]+) = (.*)$/.exec(statement);if(!assignment)continue;
    if(assignment[2]==='$null')continue;
    const literal=/^[(]'((?:[^']|'')*)' [|] ConvertFrom-Json[)]$/.exec(assignment[2]);
    if(!literal||/[^\x00-\x7f]/.test(statement))throw Error('Unsafe/non-ASCII data assignment');
    env[assignment[1]]=JSON.parse(literal[1].replaceAll("''","'"));
   }
   const input=script.join('\n');
   if(process.argv.includes('--echo-data'))console.log(token+JSON.stringify({ok:true,output:env.MURAGE_SIGNAL_ROOTS||''}));
   else answer({env,input,token});
   script=[];token=undefined;
  }
 });
}else lines.on('line',line=>answer(JSON.parse(line)));
`;
