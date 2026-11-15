// SPDX-License-Identifier: AGPL-3.0-or-later
import {known,type WipeEffect,type Value} from './types.ts';
export type InterpreterEffects={effects:WipeEffect[];shells:string[];argv:Value[][]};
/** Literal-call reader: token masking keeps printed source, comments and computed paths inert. */
export function interpreterEffects(source:string,home:string,language=''):InterpreterEffects {
 const literals:string[]=[],code:string[]=[],shellStrings:string[]=[];
 for(let i=0;i<source.length;){
  const ch=source[i]!;
  if(ch==='#'||source.startsWith('//',i)){while(i<source.length&&source[i]!=='\n')i++;code.push('\n');continue;}
  if(source.startsWith('/*',i)){const end=source.indexOf('*/',i+2);i=end<0?source.length:end+2;code.push(' ');continue;}
  const percent=/^(?:%([qQrRwWiIs])|q([qr]?))([({\[<])/.exec(source.slice(i));
  if(percent&&/^(?:ruby|perl)$/.test(language)){
   const opener=percent[3]!,closer=({'(':')','{':'}','[':']','<':'>'} as Record<string,string>)[opener]!,at=i+percent[0].length;let level=1;i=at;
   while(i<source.length&&level){const c=source[i++]!;if(c==='\\'){i++;continue;}if(c===opener)level++;if(c===closer)level--;}
   const value=source.slice(at,level?i:i-1),kind=percent[1]??percent[2];code.push(kind==='q'||kind==='Q'?'@'+literals.push(value)+'@':'opaque');continue;
  }
  if(ch!=="'"&&ch!=='"'&&ch!=='`'){code.push(ch);i++;continue;}
  const quote=ch,at=i++;let value='',valid=source[at-1]!=='f';
  while(i<source.length){const c=source[i++]!;if(c===quote)break;if(c!=='\\'){value+=c;continue;}
   const escape=source[i++]??'';const tail=source.slice(i,i+8),hex=escape==='x'?/^[0-9a-fA-F]{2}/.exec(tail):escape==='u'?/^[0-9a-fA-F]{4}/.exec(tail):undefined;
   if(hex){value+=String.fromCharCode(parseInt(hex[0],16));i+=hex[0].length;}else value+=({n:'\n',r:'\r',t:'\t','\\':'\\',"'":"'",'"':'"'} as Record<string,string>)[escape]??escape;
  }
  if(quote==='`'&&value.includes('${')||value.includes('#{'))valid=false;
  if(quote==='`'&&/^(?:ruby|perl)$/.test(language)&&valid)shellStrings.push(value);
  code.push(valid?'@'+literals.push(value)+'@':'opaque');
 }
 const bindings=new Map<string,string>(),assignments:{at:number;name:string;value:string}[]=[];
 const text=code.join(''),result:InterpreterEffects={effects:[],shells:shellStrings,argv:[]};
 for(const assignment of text.matchAll(/\b(?:const\s+|let\s+|var\s+)?([a-zA-Z_]\w*)\s*([+*\/%-]?=)(?!=|>)\s*([^;\n]*)/g))assignments.push({at:assignment.index!,name:assignment[1]!,value:assignment[2]==='='?assignment[3]!:'opaque'});let assigned=0;
 const literal=(value:string):string|undefined=>{const m=/^@(\d+)@$/.exec(value.trim());return m?literals[Number(m[1])-1]:undefined;};
 const path=(value:string):string|undefined=>{
  value=value.trim().replace(/^(?:path|src|name)\s*=\s*/,'');const direct=literal(value)??bindings.get(value);if(direct!==undefined)return direct;
  const accessor=/^(?:os\.path\.expanduser\((@\d+@)\)|(?:os\.)?homedir\(\)|(?:Path|pathlib\.Path)\.home\(\)|os\.environ\[(@\d+@)\]|process\.env\.HOME|ENV\[(@\d+@)\]|Dir\.home)$/;
  const match=accessor.exec(value);if(match&&match.slice(1).every(token=>token===undefined||['~','HOME'].includes(literal(token)??'')))return home;
 };
 // Pair delimiters and collect argument boundaries once, independently of nesting depth.
 const stack:{at:number;commas:number[]}[]=[],bounds=new Map<number,{end:number;commas:number[]}>();
 for(let i=0;i<text.length;i++){const ch=text[i]!;if('([{'.includes(ch))stack.push({at:i,commas:[]});else if(')]}'.includes(ch)){const entry=stack.pop();if(entry)bounds.set(entry.at,{end:i,commas:entry.commas});}else if(ch===',')stack.at(-1)?.commas.push(i);}
 const calls=/\b(?:shutil\.(?:rmtree|move)|os\.(?:rename|replace|system|popen)|(?:fs(?:\.promises)?|fsExtra|FileUtils|Deno|File::Path(?:::)?|child_process)\s*\.?(?:::)?\s*(?:rmSync|rm|rmdirSync|rmdir|removeSync|remove|emptyDir|rm_rf|rm_r|remove_dir|remove_entry|rmtree|remove_tree|mv|renameSync|rename|execSync|exec|execFile|spawn)|require\(@\d+@\)\.(?:rmSync|rm|rmdirSync|rmdir|removeSync|remove|emptyDir|renameSync|rename|execSync|exec|execFile|spawn)|subprocess\.\w+|rimraf|rmtree|remove_tree|Bun\.spawn|system)\s*\(/g;
 for(const match of text.matchAll(calls)){
  while(assigned<assignments.length&&assignments[assigned]!.at<match.index!){const assignment=assignments[assigned++]!,value=literal(assignment.value);if(value===undefined)bindings.delete(assignment.name);else bindings.set(assignment.name,value);}
  const open=match.index!+match[0].lastIndexOf('('),entry=bounds.get(open);if(!entry)continue;
  const points=[open,...entry.commas,entry.end],args=points.slice(0,-1).map((at,i)=>text.slice(at+1,points[i+1]));
  const name=match[0].slice(0,match[0].lastIndexOf('(')).replace(/\s/g,''),first=args[0]??'',target=path(first);
  if(['rmtree','remove_tree'].includes(name)&&!text.includes('File::Path'))continue;
  const recursive=/rmtree|rm_rf|rm_r|remove_dir|remove_entry|remove_tree|rimraf|(?:remove|removeSync|emptyDir)$/.test(name)&&!name.startsWith('Deno.');
  if(target!==undefined&&(recursive||/(?:rm|rmSync|rmdir|rmdirSync|Deno\.remove)$/.test(name)&&/\brecursive\s*:\s*true\b/.test(args[1]??'')))result.effects.push({k:'delete',target:known(target),recursive:true});
  if(target!==undefined&&/(?:shutil\.move|os\.(?:rename|replace)|renameSync|rename|FileUtils\.mv)$/.test(name))result.effects.push({k:'move-away',source:known(target)});
  if(/(?:os\.(?:system|popen)|execSync|\.exec|^system)$/.test(name)||name.startsWith('subprocess.')&&/\bshell\s*=\s*True\b/.test(args.slice(1).join(','))){const body=literal(first);if(body!==undefined)result.shells.push(body);}
  const list=(arg:string):Value[]|undefined=>{const m=/^\[([\s\S]*)\]$/.exec(arg.trim());if(!m)return;const parts=m[1]!.trim()?m[1]!.split(',').filter(s=>s.trim()):[];const values=parts.map(literal);return values.every(v=>v!==undefined)?values.map(v=>known(v!)):undefined;};
  if(name.startsWith('subprocess.')||name==='Bun.spawn'){const argv=list(first);if(argv)result.argv.push(argv);}
  else if(/(?:spawn|execFile)$/.test(name)){const command=literal(first),argv=list(args[1]??'');if(command!==undefined&&argv)result.argv.push([known(command),...argv]);}
 }
 if(/^(?:ruby|perl)$/.test(language))for(const match of text.matchAll(/%x\(([^()]*)\)/g))result.shells.push(match[1]!.replace(/@(\d+)@/g,(_,id:string)=>"'"+(literals[Number(id)-1]??'').replaceAll("'","'\\''")+"'"));
 // Ruby and Perl's common bare literal calls have no parenthesized argument list.
 for(const match of text.matchAll(/\b(FileUtils\.(?:rm_rf|rm_r|remove_dir|remove_entry|mv)|(?:File::Path::)?(?:rmtree|remove_tree))\s+(@\d+@)/g)){const target=literal(match[2]!);if(target!==undefined)result.effects.push(match[1]!.endsWith('.mv')?{k:'move-away',source:known(target)}:{k:'delete',target:known(target),recursive:true});}
 return result;
}
