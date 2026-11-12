// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { writeFileAtomic } from '../atomic.ts';
import { HighLevelCredentialCommit, highLevelActiveMetadataSchema, highLevelCredentialIntentSchema, highLevelRuntimeGrantSchema, requestHighLevelCredentialBootstrap, type HighLevelPrivateParentPort } from './credential-commit.ts';
const stateSchema=z.object({epoch:z.number().int().nonnegative(),metadata:highLevelActiveMetadataSchema.nullable()}).strict()
 .refine(value=>value.metadata===null||value.metadata.connectionEpoch===value.epoch);
const stageSchema=highLevelCredentialIntentSchema.extend({expectedRevision:z.number().int().nonnegative(),expectedEpoch:z.number().int().nonnegative(),connection:highLevelRuntimeGrantSchema.nullable(),metadata:highLevelActiveMetadataSchema.omit({bankRevision:true,bankDigest:true}).nullable()}).strict();

/** A lost locator key must never be replaced over retained recovery identities.
 * Empty runtime directories and the empty claims database are ordinary boot
 * artifacts. Unknown/unreadable files conservatively count as recovery state. */
function recoveryExists(dir:string):boolean {
 try {
  if(!existsSync(dir))return false;
  let visited=0;
  const walk=(path:string):boolean=>{
   for(const name of readdirSync(path)){
    if(++visited>2048)return true;
    if(path===dir&&name==='credential-metadata.json')continue;
    const file=join(path,name),stat=lstatSync(file);
    if(stat.isSymbolicLink())return true;
    if(stat.isDirectory()){if(walk(file))return true;continue;}
    if(path===dir&&/^user-create-claims\.sqlite(?:-wal|-shm)?$/.test(name)){
     if(name!=='user-create-claims.sqlite')continue;
     const db=new DatabaseSync(file,{readOnly:true});
     try{if(db.prepare('SELECT 1 FROM user_create_claims LIMIT 1').get())return true;}finally{db.close();}
     continue;
    }
    return true;
   }
   return false;
  };
  return walk(dir);
 } catch {return true;}
}

/** One launch-scoped bank, obtained exclusively over the private utility port.
 * Only non-secret active metadata and the monotonic epoch reach disk. Trusted
 * connection producers stage an owner-confirmed intent on that same port; HTTP
 * accepts IDs for prepare, and only main's exact durable bank for commit. */
export async function startHighLevelCredentialCommit(port:HighLevelPrivateParentPort,dataDir:string,held:()=>boolean):Promise<HighLevelCredentialCommit> {
 const bootstrap=await requestHighLevelCredentialBootstrap(port);
 const directory=join(dataDir,'highlevel'),file=join(directory,'credential-metadata.json');
 const read=()=>{
  try{return stateSchema.parse(JSON.parse(readFileSync(file,'utf8')));}
  catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT'){
    if(bootstrap.bank!==null)throw Error('credential metadata unavailable');
    return {epoch:0,metadata:null};
   }
   throw error;
  }
 };
 let state=read();
 const commit=new HighLevelCredentialCommit({bootstrap,
  hasRecoveryState:()=>held()||state.epoch>0||recoveryExists(directory),
  readMetadata:()=>state.metadata,readConnectionEpoch:()=>state.epoch,
  activateMetadata:async(metadata,expectedEpoch)=>{
   const disk=read();if(disk.epoch!==expectedEpoch||JSON.stringify(disk)!==JSON.stringify(state))throw Error('stale credential metadata');
   const next=stateSchema.parse({epoch:expectedEpoch+1,metadata});
   mkdirSync(directory,{recursive:true,mode:0o700});
   writeFileAtomic(file,JSON.stringify(next),{mode:0o600,syncDir:true});state=next;
  },
 });
 port.on('message',function stageFromParent(event){
  const message=event.data as {type?:unknown;stage?:unknown}|undefined;
  if(message?.type!=='murage:highlevel-stage-credential')return;
  try {
   const intent=commit.stage(stageSchema.parse(message.stage));
   port.postMessage({type:'murage:highlevel-credential-staged',intent});
  } catch {port.postMessage({type:'murage:highlevel-credential-staged',error:'unavailable'});}
 });
 return commit;
}
