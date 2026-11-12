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
/** Consume option values before deciding whether a token is a push flag. */
export function gitPushArguments(rest:readonly string[]):{positionals:string[];flags:string[];repository:boolean;remote?:string}{
 const positionals:string[]=[],flags:string[]=[];let repository=false,remote:string|undefined,ended=false;
 for(let at=0;at<rest.length;at++){
  const arg=rest[at]!;
  if(!ended&&arg==='--'){ended=true;continue;}
  if(!ended){
   if(arg==='--repo'){repository=true;remote=rest[++at];continue;}
   if(arg.startsWith('--repo=')){repository=true;remote=arg.slice(7);continue;}
   if(['-o','--push-option','--receive-pack','--exec'].includes(arg)){at++;continue;}
   if(/^(?:--(?:push-option|receive-pack|exec)=|-o.)/.test(arg))continue;
   if(arg.startsWith('-')){flags.push(arg);continue;}
  }
  positionals.push(arg);
 }
 return {positionals,flags,repository,remote};
}
/** Additional Git catastrophe forms only. Existing reset, ordinary clean,
 * explicit feature-branch force pushes and force-with-lease stay runs. */
export function extraGitWipe(args:string[],cwd?:string):boolean {
 const sub=args.findIndex(word=>/^(?:push|clean)$/.test(word));if(sub<0)return false;
 let directory=cwd;
 for(let at=0;at<sub;at++)if(args[at]==='-C')directory=resolve(directory??'/',args[++at]??'.');else if(args[at]!.startsWith('-C'))directory=resolve(directory??'/',args[at]!.slice(2));
 const rest=args.slice(sub+1);
 if(args[sub]==='clean'){
  if(rest.some(arg=>/^(?:--dry-run|-[-\w]*n[\w]*)$/.test(arg)))return false;
  const flags=rest.filter(arg=>/^-[^-]/.test(arg)).join('');
  const force=flags.includes('f')||rest.includes('--force'),ignored=/[xX]/.test(flags);
  const paths=rest.filter(arg=>!arg.startsWith('-'));
  if(!force||!ignored||paths.some(path=>path!=='.'&&path!=='./'))return false;
  if(directory&&[tmpdir(),'/tmp','/var/tmp','/private/tmp'].some(root=>inside(resolve(directory),resolve(root))))return false;
  return true;
 }
 const {positionals,flags,repository,remote}=gitPushArguments(rest);
 if(flags.includes('--dry-run')||flags.includes('-n'))return false;
 if(flags.includes('--mirror'))return true;
 if(flags.some(arg=>/^--force-with-lease(?:=|$)/.test(arg)))return false;
 const forced=flags.some(arg=>arg==='-f'||arg==='--force');if(!forced)return false;
 if(flags.includes('--all'))return true;
 const refs=repository?positionals:positionals.slice(1),state=gitState(directory,remote??positionals[0]);
 if(refs.length)return refs.some(ref=>state.defaults.has((ref.split(':').at(-1)??'').replace(/^\+|^refs\/heads\//g,'')));
 return state.matching===true||state.branch===undefined||state.defaults.has(state.branch);
}
