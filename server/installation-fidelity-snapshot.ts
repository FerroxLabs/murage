import { createHash } from "node:crypto";
import { constants, closeSync, createReadStream, fstatSync, lstatSync, openSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { backupSelectionSchema, type BackupSelection, type BackupCoverage } from "../shared/installation-backup.ts";
import { portableArchivePath, type ArchiveLimits } from "./installation-archive.ts";
import { InstallationSnapshotError, type OfflineInstallation } from "./installation-database-snapshot.ts";
import type { StateSnapshotManifest } from "./installation-state-snapshot.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { MAX_BACKUP_BYTES, MAX_BACKUP_FILES } from "../shared/backup-limits.ts";
// Every top-level name is classified by data-dir-inventory.ts, the one list
// shared with the restorable stage and the damaged-installation export. A
// name it does not know stops the backup with BACKUP_UNCLASSIFIED_COMPONENT
// rather than silently leaving owner work out.
function fail(code:string,path?:string):never{throw new InstallationSnapshotError(code,path?{path}:undefined);}
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
export interface FidelitySource { path:string; bytes:number; sha256:string; source:string; identity:Stats }
/** Inventory only the selected application files. No external roots or native custody. */
export async function inventoryFidelity(installation:OfflineInstallation,stage:{directory:string;manifest:StateSnapshotManifest},selection:BackupSelection,options:ArchiveLimits={}) {
  backupSelectionSchema.parse(selection);
  const root=installation.dataDir;
  const roots=readdirSync(root).sort();
  for(const required of ["bots.json","messages.db"])if(!roots.includes(required))fail("BACKUP_REQUIRED_COMPONENT_MISSING");
  if(roots.some(name=>name==="vm-home"||name==="vm-homes"))fail("VM_WORKSPACE_BACKUP_UNSUPPORTED");
  const components:BackupCoverage["components"]=[];
  if(!roots.includes("config.json"))components.push({path:"config.json",status:"missing",reason:"No saved configuration; restore creates explicit disabled defaults for review"});
  const memoryIndexPresent=roots.includes("memory-index.db");
  const memorySidecar=(name:string)=>name==="memory-index.db-wal"||name==="memory-index.db-shm";
  if(!memoryIndexPresent&&roots.some(memorySidecar))fail("BACKUP_UNCLASSIFIED_COMPONENT");
  for(const name of roots){
    const entry=classifyDataDirEntry(name);
    if(!entry)fail("BACKUP_UNCLASSIFIED_COMPONENT",name);
    if(entry.backup==="refused")fail(entry.code??"BACKUP_UNCLASSIFIED_COMPONENT",name);
    if(entry.backup==="sidecar")continue;
    if(entry.backup==="excluded"){components.push({path:name,status:"excluded",reason:entry.why});continue;}
    // Restorable names were copied into the stage by the same list (an
    // empty folder copies nothing); retained ones are read below.
    components.push({path:name,status:"included",reason:entry.why});
  }
  // Shortcuts, extra names and renamed entries inside folders of owner work
  // are part of the recovery stage itself (installation-state-snapshot.ts),
  // so nothing here refuses them.
  const sources:FidelitySource[]=[];
  const memoryOriginals=new Map<string,Stats>();
  // Raw ("fidelity") copies are kept only where they differ from what
  // restore uses: Murage's records, whose recovery copy is projected (keys
  // and live sessions removed), and the items kept only encrypted. An owner
  // file's raw bytes are exactly its recovery copy, and storing both doubled
  // every backup (audit A-05).
  const selectedFiles=stage.manifest.files.filter(file=>!file.path.includes("/")&&!file.path.includes("\\")&&file.path!=="messages.db"&&classifyDataDirEntry(file.path)?.backup==="record").map(file=>({path:file.path}));
  if(roots.includes("startup-background.json"))selectedFiles.push({path:"startup-background.json"});
  if(memoryIndexPresent){
    for(const name of ["memory-index.db","memory-index.db-wal"]){
      if(roots.includes(name))memoryOriginals.set(join(root,name),lstatSync(join(root,name)));
    }
    const snapshot=await installation.snapshotMemoryIndex(join(stage.directory,"memory-index.db"));
    if(snapshot.status!=="copied")fail("BACKUP_REQUIRED_COMPONENT_MISSING");
    selectedFiles.push({path:"memory-index.db"});
  }
  const channelDirectories=new Map<string,{identity:Stats;names:string[]}>();
  let channelEntries=0;
  const walkChannels=(relative:string,depth=0)=>{
    if(options.signal?.aborted)fail("SNAPSHOT_CANCELLED");
    if(depth>64||++channelEntries>(options.maxFiles??MAX_BACKUP_FILES))fail("SNAPSHOT_LIMIT_EXCEEDED",relative);
    if(!portableArchivePath(relative))fail("NONPORTABLE_SNAPSHOT_PATH",relative);
    const path=join(root,relative),stat=lstatSync(path);
    if(stat.isSymbolicLink())fail("BACKUP_SELECTED_COMPONENT_UNAVAILABLE",relative);
    if(stat.isDirectory()){
      const names=readdirSync(path).sort(),folded=new Set<string>();channelDirectories.set(path,{identity:stat,names});
      for(const name of names){const normal=name.normalize("NFC").toLowerCase();if(folded.has(normal))fail("NONPORTABLE_SNAPSHOT_PATH",`${relative}/${name}`);folded.add(normal);walkChannels(`${relative}/${name}`,depth+1);}
    }else if(stat.isFile()&&stat.nlink===1)selectedFiles.push({path:relative});
    else fail("UNSAFE_SNAPSHOT_ENTRY",relative);
  };
  if(roots.includes("channels"))walkChannels("channels");
  if(selectedFiles.length>(options.maxFiles??MAX_BACKUP_FILES))fail("SNAPSHOT_LIMIT_EXCEEDED");
  let bytes=0;
  for(const file of selectedFiles){
    if(options.signal?.aborted)fail("SNAPSHOT_CANCELLED");
    const path=file.path.replaceAll("\\","/");if(!portableArchivePath(path))fail("UNSAFE_ARCHIVE_PATH");
    const source=path==="messages.db"?join(stage.directory,"state",file.path):path==="memory-index.db"?join(stage.directory,"memory-index.db"):join(root,file.path);
    const before=lstatSync(source);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)fail("UNSAFE_SNAPSHOT_ENTRY",path);
    bytes+=before.size;if(bytes>(options.maxBytes??MAX_BACKUP_BYTES))fail("SNAPSHOT_LIMIT_EXCEEDED",path);
    const fd=openSync(source,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));
    if(!same(before,fstatSync(fd))){closeSync(fd);fail("SOURCE_CHANGED");}
    const hash=createHash("sha256");
    for await(const chunk of createReadStream(source,{fd,autoClose:true}))hash.update(chunk);
    if(!same(before,lstatSync(source)))fail("SOURCE_CHANGED");
    sources.push({path,bytes:before.size,sha256:hash.digest("hex"),source,identity:before});
  }
  return {sources,coverage:{scope:selection.scope,credentialPolicy:selection.credentialPolicy,fullInstallation:false as const,components},assertUnchanged(){
    if(JSON.stringify(readdirSync(root).sort())!==JSON.stringify(roots))fail("SOURCE_CHANGED");
    for(const [path,before] of memoryOriginals)if(!same(before,lstatSync(path)))fail("SOURCE_CHANGED");
    for(const [path,before] of channelDirectories)if(!same(before.identity,lstatSync(path))||JSON.stringify(readdirSync(path).sort())!==JSON.stringify(before.names))fail("SOURCE_CHANGED");
    for(const item of sources)if(!same(item.identity,lstatSync(item.source)))fail("SOURCE_CHANGED");
  }};
}
export function openFidelitySource(item:FidelitySource){
  const fd=openSync(item.source,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));
  if(!same(item.identity,fstatSync(fd))){closeSync(fd);fail("SOURCE_CHANGED");}
  return createReadStream(item.source,{fd,autoClose:true});
}
