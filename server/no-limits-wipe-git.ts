// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync,statSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const read=(path:string)=>{try{return statSync(path).size<=65536?readFileSync(path,'utf8').trim():undefined;}catch{return undefined;}};
const inside=(path:string,root:string)=>{const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\')&&!isAbsolute(rel);};
function gitState(cwd?:string,remote='origin'):{branch?:string;defaults:Set<string>;matching?:boolean}{
 const defaults=new Set(['main','master']);
 if(!cwd)return {defaults};
 let dir=resolve(cwd),git:string|undefined;
 for(let at=0;at<64;at++){
  const candidate=join(dir,'.git'),file=read(candidate);
  try{if(statSync(candidate).isDirectory()){git=candidate;break;}}catch{/* walk to the enclosing repository */}
  if(file?.startsWith('gitdir:')){git=resolve(dir,file.slice(7).trim());break;}
  const parent=dirname(dir);if(parent===dir)break;dir=parent;
 }
 if(!git)return {defaults};
 const common=read(join(git,'commondir')),commonDir=common?resolve(git,common):git;
 const defaultHead=read(join(commonDir,'refs','remotes',remote,'HEAD'))?.match(/^ref: refs\/remotes\/[^/]+\/(.+)$/)?.[1];
 if(defaultHead)defaults.add(defaultHead);
 const head=read(join(git,'HEAD')),branch=head?.match(/^ref: refs\/heads\/(.+)$/)?.[1];
 const config=read(join(commonDir,'config'))??'';
 return {defaults,branch:branch??(head?'(detached)':undefined),matching:/\[push\][^[]*\bdefault\s*=\s*matching\b/i.test(config)};
}
/** Read the actual subcommand and options, keeping option values/refspecs as
 * data. Both catastrophe readers must honor a proved help/dry-run invocation. */
export function gitWipeInvocation(args:string[],cwd?:string):{op?:string;rest:string[];cwd?:string;nonmutating:boolean}{
 let at=0,directory=cwd;
 for(;at<args.length;at++){
  const arg=args[at]!;
  if(arg==='--help'||arg==='-h'||arg==='--version'||arg==='-v')return {rest:[],cwd:directory,nonmutating:true};
  if(arg==='--'){at++;break;}
  if(!arg.startsWith('-'))break;
  if(arg==='-C')directory=resolve(directory??'/',args[++at]??'.');
  else if(arg.startsWith('-C'))directory=resolve(directory??'/',arg.slice(2));
  else if(['-c','--config-env','--git-dir','--work-tree','--namespace','--super-prefix','--attr-source'].includes(arg))at++;
 }
 const op=args[at],rest=args.slice(at+1);
 if(op==='help')return {op,rest,cwd:directory,nonmutating:true};
 const values=new Set(op==='clean'?['-e','--exclude']:op==='push'?['--repo','-o','--push-option','--receive-pack','--exec']:
  op==='filter-branch'?['--env-filter','--tree-filter','--index-filter','--parent-filter','--msg-filter','--commit-filter','--tag-name-filter','--subdirectory-filter','--original','-d','--state-branch','--setup']:
  op==='filter-repo'?['--path','--path-glob','--path-regex','--path-rename','--replace-text','--replace-message','--mailmap','--source','--target','--refs','--filename-callback','--file-info-callback','--message-callback','--name-callback','--email-callback','--refname-callback','--blob-callback','--commit-callback','--tag-callback','--reset-callback']:[]);
 const dryRun=op==='push'||op==='clean'||op==='filter-repo'||op==='reflog'&&rest[0]==='expire';
 for(let index=0;index<rest.length;index++){
  const arg=rest[index]!;
  if(arg==='--')break;
  if(values.has(arg)){index++;continue;}
  if(arg==='--help'||dryRun&&arg==='--dry-run')return {op,rest,cwd:directory,nonmutating:true};
  if(/^-[^-]/.test(arg))for(const flag of arg.slice(1)){
   // An attached push-option/exclusion consumes the rest of its short cluster.
   if(op==='push'&&flag==='o'||op==='clean'&&flag==='e')break;
   if(flag==='h'||dryRun&&flag==='n')return {op,rest,cwd:directory,nonmutating:true};
  }
 }
 return {op,rest,cwd:directory,nonmutating:false};
}
/** Additional Git catastrophe forms only. Existing reset, ordinary clean,
 * explicit feature-branch force pushes and force-with-lease stay runs. */
export function extraGitWipe(args:string[],cwd?:string):boolean {
 const {op,rest,cwd:directory,nonmutating}=gitWipeInvocation(args,cwd);
 if(nonmutating||op!=='push'&&op!=='clean')return false;
 if(op==='clean'){
  const flags=rest.filter(arg=>/^-[^-]/.test(arg)).join('');
  const force=flags.includes('f')||rest.includes('--force'),ignored=/[xX]/.test(flags);
  const paths=rest.filter(arg=>!arg.startsWith('-'));
  if(!force||!ignored||paths.some(path=>path!=='.'&&path!=='./'))return false;
  if(directory&&[tmpdir(),'/tmp','/var/tmp','/private/tmp'].some(root=>inside(resolve(directory),resolve(root))))return false;
  return true;
 }
 if(rest.includes('--mirror'))return true;
 if(rest.some(arg=>/^--force-with-lease(?:=|$)/.test(arg)))return false;
 const forced=rest.some(arg=>arg==='-f'||arg==='--force');if(!forced)return false;
 if(rest.includes('--all'))return true;
 const positionals:string[]=[];let repository=false,remote:string|undefined;
 for(let at=0;at<rest.length;at++){
  const arg=rest[at]!;
  if(arg==='--repo'){repository=true;remote=rest[++at];continue;}
  if(arg.startsWith('--repo=')){repository=true;remote=arg.slice(7);continue;}
  if(['-o','--push-option','--receive-pack','--exec'].includes(arg)){at++;continue;}
  if(!arg.startsWith('-'))positionals.push(arg);
 }
 const refs=repository?positionals:positionals.slice(1),state=gitState(directory,remote??positionals[0]);
 if(refs.length)return refs.some(ref=>state.defaults.has((ref.split(':').at(-1)??'').replace(/^\+|^refs\/heads\//g,'')));
 return state.matching===true||state.branch===undefined||state.defaults.has(state.branch);
}
