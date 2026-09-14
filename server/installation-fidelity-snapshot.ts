import { createHash } from "node:crypto";
import { constants, closeSync, createReadStream, fstatSync, lstatSync, openSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { backupSelectionSchema, type BackupSelection, type BackupCoverage } from "../shared/installation-backup.ts";
import { portableArchivePath, type ArchiveLimits } from "./installation-archive.ts";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";
import type { StateSnapshotManifest } from "./installation-state-snapshot.ts";
const excluded = new Set(["native","credentials.bin","companion","connection-profiles","memory-index","models","logs","tmp","browser-profiles","browser-engine"]);
const applicationRoots=new Set(["config.json","bots.json","groups.json","routines.json","calendar-calls.json","webhooks.json","delegations.json","delegation-receipts.json","section-contexts.json","browser-cleanups.json","attachments","artifact-files","workspaces","skills","skill-state","checkpoints","events","channels","startup-background.json"]);
function fail(code:string):never{throw new InstallationSnapshotError(code);}
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
export interface FidelitySource { path:string; bytes:number; sha256:string; source:string; identity:Stats }
/** Inventory only the selected application files. No external roots or native custody. */
export async function inventoryFidelity(root:string,stage:{directory:string;manifest:StateSnapshotManifest},selection:BackupSelection,options:ArchiveLimits={}) {
  backupSelectionSchema.parse(selection);
  const roots=readdirSync(root).sort();
  for(const required of ["config.json","bots.json","messages.db"])if(!roots.includes(required))fail("BACKUP_REQUIRED_COMPONENT_MISSING");
  if(roots.some(name=>name==="vm-home"||name==="vm-homes"))fail("VM_WORKSPACE_BACKUP_UNSUPPORTED");
  const included=new Set(stage.manifest.files.map(file=>file.path.replaceAll("\\","/").split("/")[0]));
  const components:BackupCoverage["components"]=[];
  for(const name of roots){
    if(["messages.db-wal","messages.db-shm"].includes(name))continue;
    if(included.has(name)||applicationRoots.has(name))components.push({path:name,status:"included",reason:name==="channels"?"Channel bindings and receipt history retained encrypted only; re-pairing required before use":name==="startup-background.json"?"Startup preferences retained encrypted only; automatic startup is not restored":"Application data preserved in encrypted fidelity payload"});
    else if(excluded.has(name))components.push({path:name,status:"excluded",reason:"Outside application-data capture; native/credential/derived state is not restored"});
    else fail("BACKUP_UNCLASSIFIED_COMPONENT");
  }
  // A skipped link inside a selected directory is not a complete capture.
  if(stage.manifest.omitted.some(item=>stage.manifest.files.every(file=>file.path!==item.path)&&item.reason.toLowerCase().includes("symlink")))fail("BACKUP_SELECTED_COMPONENT_UNAVAILABLE");
  const sources:FidelitySource[]=[];
  const selectedFiles=stage.manifest.files.map(file=>({path:file.path}));
  if(roots.includes("startup-background.json"))selectedFiles.push({path:"startup-background.json"});
  const channelDirectories=new Map<string,{identity:Stats;names:string[]}>();
  let channelEntries=0;
  const walkChannels=(relative:string,depth=0)=>{
    if(options.signal?.aborted)fail("SNAPSHOT_CANCELLED");
    if(depth>64||++channelEntries>(options.maxFiles??100000))fail("SNAPSHOT_LIMIT_EXCEEDED");
    if(!portableArchivePath(relative))fail("NONPORTABLE_SNAPSHOT_PATH");
    const path=join(root,relative),stat=lstatSync(path);
    if(stat.isSymbolicLink())fail("BACKUP_SELECTED_COMPONENT_UNAVAILABLE");
    if(stat.isDirectory()){
      const names=readdirSync(path).sort(),folded=new Set<string>();channelDirectories.set(path,{identity:stat,names});
      for(const name of names){const normal=name.normalize("NFC").toLowerCase();if(folded.has(normal))fail("NONPORTABLE_SNAPSHOT_PATH");folded.add(normal);walkChannels(`${relative}/${name}`,depth+1);}
    }else if(stat.isFile()&&stat.nlink===1)selectedFiles.push({path:relative});
    else fail("UNSAFE_SNAPSHOT_ENTRY");
  };
  if(roots.includes("channels"))walkChannels("channels");
  if(selectedFiles.length>(options.maxFiles??100000))fail("SNAPSHOT_LIMIT_EXCEEDED");
  let bytes=0;
  for(const file of selectedFiles){
    if(options.signal?.aborted)fail("SNAPSHOT_CANCELLED");
    const path=file.path.replaceAll("\\","/");if(!portableArchivePath(path))fail("UNSAFE_ARCHIVE_PATH");
    const source=path==="messages.db"?join(stage.directory,"state",file.path):join(root,file.path);
    const before=lstatSync(source);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)fail("UNSAFE_SNAPSHOT_ENTRY");
    bytes+=before.size;if(bytes>(options.maxBytes??20*1024**3))fail("SNAPSHOT_LIMIT_EXCEEDED");
    const fd=openSync(source,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));
    if(!same(before,fstatSync(fd))){closeSync(fd);fail("SOURCE_CHANGED");}
    const hash=createHash("sha256");
    for await(const chunk of createReadStream(source,{fd,autoClose:true}))hash.update(chunk);
    if(!same(before,lstatSync(source)))fail("SOURCE_CHANGED");
    sources.push({path,bytes:before.size,sha256:hash.digest("hex"),source,identity:before});
  }
  return {sources,coverage:{scope:selection.scope,credentialPolicy:selection.credentialPolicy,fullInstallation:false as const,components},assertUnchanged(){
    if(JSON.stringify(readdirSync(root).sort())!==JSON.stringify(roots))fail("SOURCE_CHANGED");
    for(const [path,before] of channelDirectories)if(!same(before.identity,lstatSync(path))||JSON.stringify(readdirSync(path).sort())!==JSON.stringify(before.names))fail("SOURCE_CHANGED");
    for(const item of sources)if(!same(item.identity,lstatSync(item.source)))fail("SOURCE_CHANGED");
  }};
}
export function openFidelitySource(item:FidelitySource){
  const fd=openSync(item.source,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));
  if(!same(item.identity,fstatSync(fd))){closeSync(fd);fail("SOURCE_CHANGED");}
  return createReadStream(item.source,{fd,autoClose:true});
}
