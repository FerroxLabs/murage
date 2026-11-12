// SPDX-License-Identifier: AGPL-3.0-or-later
// Standalone fallback for an extension whose broker cannot be reached. Only
// positively named catastrophe targets hold; unknown syntax and targets run.
export type VisibleWipeRule = 'delete-root'|'delete-home'|'delete-system-folder'|'disk-erase'|'fork-bomb';
export function visibleWipe(text:string, home:string, depth=0):VisibleWipeRule|null {
 if(depth>8)return null;
 const commands:string[][]=[];let words:string[]=[],word='',quote='',started=false;
 const endWord=()=>{if(started){words.push(word);word='';started=false;}};
 const endCommand=()=>{endWord();if(words.length)commands.push(words);words=[];};
 for(let i=0;i<text.length;i++){
  const c=text[i]!;
  if(quote){
   if(c===quote){quote='';continue;}
   if(c==='\\'&&quote==='"'&&/[\\"$`]/.test(text[i+1]??'')){word+=text[++i]??'';continue;}
   word+=c;continue;
  }
  if(c==='"'||c==="'"){quote=c;started=true;continue;}
  if(c==='\\'){started=true;word+=text[++i]??'';continue;}
  if(c==='#'&&!started){while(i<text.length&&text[i]!=='\n')i++;endCommand();continue;}
  if(/[;\n|&]/.test(c)){endCommand();continue;}
  if(/\s/.test(c)){endWord();continue;}
  started=true;word+=c;
 }
 endCommand();
 const normal=(path:string)=>{
  path=path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/,home).replaceAll('\\','/');
  if(/[$*?`]/.test(path))return undefined;
  if(!path.startsWith('/')&&!/^[A-Za-z]:\//.test(path))return undefined;
  const parts:string[]=[];for(const p of path.split('/')){if(!p||p==='.')continue;if(p==='..')parts.pop();else parts.push(p);}
  return (path.startsWith('/')?'/':'')+parts.join('/');
 };
 const system=/^(?:\/(?:etc|usr(?:\/local)?|bin|sbin|lib(?:32|64|exec)?|var|boot|System|Library|opt)|[A-Za-z]:\/(?:Windows(?:\/System32)?|Program Files(?: \(x86\))?))$/i;
 for(let words of commands){
  while(words.length&&/^(?:command|exec|sudo|doas|env)$/.test(words[0]!)){
   const wrapper=words.shift()!;
   while(words.length&&(words[0]!.startsWith('-')||wrapper==='env'&&/^\w+=/.test(words[0]!))){const option=words.shift()!;if(['-u','-g','-C','--user','--group','--chdir'].includes(option))words.shift();}
  }
  while(words.length&&/^\w+=/.test(words[0]!))words.shift();
  const program=(words.shift()??'').split(/[\\/]/).at(-1)!.replace(/\.exe$/i,'').toLowerCase();
  if(/^(?:bash|sh|dash|zsh|ksh|pwsh|powershell)$/.test(program)){
   const at=words.findIndex(w=>/^-[^-]*c$|^-command$/i.test(w));
   if(at>=0&&words[at+1]!==undefined){const hit=visibleWipe(words[at+1]!,home,depth+1);if(hit)return hit;}
  }
  if(/^(?:mkfs(?:\.[\w-]+)?|mke2fs|newfs|wipefs|clear-disk|format-volume)$/.test(program))return 'disk-erase';
  if(program==='dd'&&words.some(w=>/^of=\/dev\/(?!null$|zero$|random$|urandom$|stdout$)/.test(w)))return 'disk-erase';
  if(program==='diskutil'&&words.some(w=>/^erase(?:disk|volume)$/i.test(w)))return 'disk-erase';
  if(/^(?:rm|rmdir|rimraf|remove-item|ri|rd|deltree)$/.test(program)){
   const recursive=/^(?:rimraf|deltree)$/.test(program)||words.some(w=>/^-[^-]*r|^--recursive$|^-recurse$|^\/s$/i.test(w));
   if(!recursive)continue;
   for(const operand of words.filter(w=>w==='/'||!w.startsWith('-'))){
    const path=normal(operand);if(path===undefined)continue;
    if(path==='/'||/^[A-Za-z]:$/.test(path))return 'delete-root';
    if(path===normal(home))return 'delete-home';
    if(system.test(path))return 'delete-system-folder';
   }
  }
  // Interpreter source is inspected only in an actual interpreter code slot.
  if(/^(?:python[\d.]*|node|ruby|perl)$/.test(program)){
   const at=words.findIndex(w=>/^-c$|^-e$|^--eval$/.test(w)),code=at>=0?words[at+1]:undefined;
   if(code)for(const match of code.matchAll(/(?:rmtree|rmSync|removeAll|rmdirSync)\s*\(\s*(['"])([^'"\n]+)\1/g)){
    const path=normal(match[2]!);if(path==='/')return 'delete-root';if(path===normal(home))return 'delete-home';if(path&&system.test(path))return 'delete-system-folder';
   }
  }
 }
 if(/^\s*:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:\s*$/.test(text))return 'fork-bomb';
 return null;
}
