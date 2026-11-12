// Verify a Git commit and its complete tracked file tree even in a container
// snapshot without .git. SHA1 here is Git object identity, not a secret hash.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,readlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const check=(ok)=>{if(!ok)throw Error('Candidate checkout or snapshot does not match the requested commit');};
const objectHash=(kind,bytes)=>createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
function git(root,args){const r=spawnSync('git',args,{cwd:root,maxBuffer:32*1024*1024});check(r.status===0);return r.stdout;}
export function candidateProof(root){
 const commit=git(root,['cat-file','commit','HEAD']);
 const entries=git(root,['ls-tree','-rz','--full-tree','HEAD']).toString('utf8').split('\0').filter(Boolean).map(line=>{
  const m=/^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(line);check(m);return {mode:m[1],oid:m[2],path:m[3]};
 });
 return {commit:commit.toString('base64'),entries};
}
export function writeCandidateProof(root,out){check(resolve(out)!=='/dev'&&!resolve(out).startsWith('/dev/'));writeFileSync(out,JSON.stringify(candidateProof(root))+'\n',{mode:0o600});}
export function verifyCandidate(root,candidateSha,proofFile){
 const proof=proofFile?JSON.parse(readFileSync(proofFile)):candidateProof(root);
 const commit=Buffer.from(proof.commit,'base64'),actual=objectHash('commit',commit);
 check(/^[a-f0-9]{40}$/.test(candidateSha??actual)&&(!candidateSha||candidateSha===actual));
 const tree=new Map();
 for(const e of proof.entries){
  check(['100644','100755','120000'].includes(e.mode)&&typeof e.path==='string'&&!e.path.includes('\\')&&!e.path.startsWith('/')&&e.path.split('/').every(p=>p&&p!=='.'&&p!=='..'));
  const path=join(root,e.path),stat=lstatSync(path);let bytes;
  if(e.mode==='120000'){check(stat.isSymbolicLink());bytes=Buffer.from(readlinkSync(path));}
  else{check(stat.isFile());if(process.platform!=='win32')check(Boolean(stat.mode&0o111)===(e.mode==='100755'));bytes=readFileSync(path);}
  check(objectHash('blob',bytes)===e.oid);
  const parts=e.path.split('/');let parent=tree;
  for(const part of parts.slice(0,-1)){if(!parent.has(part))parent.set(part,new Map());check(parent.get(part) instanceof Map);parent=parent.get(part);}
  const name=parts.at(-1);check(!parent.has(name));parent.set(name,{mode:e.mode,oid:e.oid});
 }
 const hashTree=dir=>{
  const entries=[...dir].map(([name,value])=>value instanceof Map?{name,mode:'40000',oid:hashTree(value),sort:name+'/'}:{name,...value,sort:name});
  entries.sort((a,b)=>Buffer.compare(Buffer.from(a.sort),Buffer.from(b.sort)));
  return objectHash('tree',Buffer.concat(entries.map(e=>Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`),Buffer.from(e.oid,'hex')]))));
 };
 check(hashTree(tree)===/^tree ([a-f0-9]{40})\n/.exec(commit.toString('utf8'))?.[1]);
 return {candidateSha:actual,verified:true,mode:proofFile?'verified-snapshot':'checkout',files:proof.entries.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))writeCandidateProof(resolve(process.argv[2]??'.'),resolve(process.argv[3]));
