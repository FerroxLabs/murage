import { createHash } from "node:crypto";
import { constants, closeSync, createReadStream, fstatSync, lstatSync, openSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { backupSelectionSchema, type BackupSelection, type BackupCoverage } from "../shared/installation-backup.ts";
import { portableArchivePath, type ArchiveLimits } from "./installation-archive.ts";
import { InstallationSnapshotError, type OfflineInstallation } from "./installation-database-snapshot.ts";
import type { StateSnapshotManifest } from "./installation-state-snapshot.ts";
const excluded = new Set(["messages.pre-memory-v2.db","native","credentials.bin","companion","connection-profiles","memory-index","models","logs","tmp","browser-profiles","browser-engine","door-identity","folder-trust.json","skill-index.db","skill-index.db-wal","skill-index.db-shm",
  // Downloads Murage fetches again on demand: model catalogs (index.ts
  // ProviderConnectionsService cacheDir), managed engine binaries
  // (EngineManager root), the team-library catalog copy (team-library.ts
  // REMOTE_CATALOG_CACHE_FILE, only catalog.json), the memory embedding model
  // (memory/settings.ts) and the pinned agent-browser binary (browser-engine.ts).
  "provider-catalogs","managed-engines","team-library","memory-model","tools",
  // Runtime bookkeeping with no owner choice in it: handoff budgets that
  // expire after 24 hours (coordination-budget.ts), and who holds each native
  // browser session (browser-control.ts), keyed to profiles that are already
  // not restored.
  "coordination-roots.json","browser-control.json",
  // Credential homes, excluded like connection-profiles: Claude account
  // config dirs (claude-accounts.ts), the Hermes engine home
  // (acp/hermes.ts), the dev harness broker token (flux-composio-dev-token.ts)
  // and local model servers with their API keys (local-servers.ts). Restore
  // already clears provider credentials; these are re-added the same way.
  "providers","flux-hermes-home","flux-composio-broker-token.json","local-models",
  // Written by a restore into the installation it made. Restore refuses these
  // names inside an archive (installation-restore-preparation.ts
  // RESERVED_RESTORE_FILES), so they can only ever be left out; without them
  // listed, every backup of a restored installation failed.
  "restore-review.json","restored-connections.json","recovery-quarantine",
  // Folder metadata the operating system drops when the owner opens the folder.
  ".DS_Store","Thumbs.db","desktop.ini"]);
// setup.json keeps the Chief of Staff and brief routine first run chose
// (server/setup.ts); queued-messages.json holds the owner's own words that were
// waiting behind a turn when Murage closed (index.ts F7). Both are owner state.
const applicationRoots=new Set(["config.json","bots.json","groups.json","routines.json","calendar-calls.json","webhooks.json","delegations.json","delegation-receipts.json","section-contexts.json","browser-cleanups.json","setup.json","queued-messages.json","attachments","artifact-files","workspaces","skills","skill-state","checkpoints","events","channels","startup-background.json","memory-index.db"]);
// Scratch that outlives a crash: mkdtemp dirs for a memory evolution run
// (index.ts) and a package import's staging (bot-package-import.ts), and a
// stale permission socket (procs.ts brokerSocketPath). The import's own
// `.package-import-transaction` journal is deliberately NOT here: until the
// next start recovers it, bots.json may sit between two rosters.
const scratchLeftover=/^(?:\.memory-evolution-|\.package-import-)[A-Za-z0-9]{6}$|^perm-[\w-]+\.sock$/;
// A skill index build that was stopped before its rename leaves its private
// temp file (and a SQLite sidecar) behind: the same derived index, unfinished.
const skillIndexLeftover=/^skill-index\.db\.\d+\.[a-z0-9]{1,8}\.tmp(?:-journal|-wal|-shm)?$/;
const isExcluded=(name:string)=>excluded.has(name)||skillIndexLeftover.test(name)||scratchLeftover.test(name);
function fail(code:string):never{throw new InstallationSnapshotError(code);}
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
export interface FidelitySource { path:string; bytes:number; sha256:string; source:string; identity:Stats }
/** Inventory only the selected application files. No external roots or native custody. */
export async function inventoryFidelity(installation:OfflineInstallation,stage:{directory:string;manifest:StateSnapshotManifest},selection:BackupSelection,options:ArchiveLimits={}) {
  backupSelectionSchema.parse(selection);
  const root=installation.dataDir;
  const roots=readdirSync(root).sort();
  for(const required of ["bots.json","messages.db"])if(!roots.includes(required))fail("BACKUP_REQUIRED_COMPONENT_MISSING");
  if(roots.some(name=>name==="vm-home"||name==="vm-homes"))fail("VM_WORKSPACE_BACKUP_UNSUPPORTED");
  const included=new Set(stage.manifest.files.map(file=>file.path.replaceAll("\\","/").split("/")[0]));
  const components:BackupCoverage["components"]=[];
  if(!roots.includes("config.json"))components.push({path:"config.json",status:"missing",reason:"No saved configuration; restore creates explicit disabled defaults for review"});
  const memoryIndexPresent=roots.includes("memory-index.db");
  const memorySidecar=(name:string)=>name==="memory-index.db-wal"||name==="memory-index.db-shm";
  if(!memoryIndexPresent&&roots.some(memorySidecar))fail("BACKUP_UNCLASSIFIED_COMPONENT");
  for(const name of roots){
    if(["messages.db-wal","messages.db-shm"].includes(name)||memorySidecar(name))continue;
    if(included.has(name)||applicationRoots.has(name))components.push({path:name,status:"included",reason:name==="memory-index.db"?"Consistent memory search projection retained encrypted only; rebuild from paused messages.db authority after review":name==="channels"?"Channel bindings and receipt history retained encrypted only; re-pairing required before use":name==="startup-background.json"?"Startup preferences retained encrypted only; automatic startup is not restored":"Application data preserved in encrypted fidelity payload"});
    else if(isExcluded(name))components.push({path:name,status:"excluded",reason:name==="messages.pre-memory-v2.db"?"Pre-upgrade copy of messages.db kept for manual 0.1.x rollback only; the live messages.db is the backed-up authority":["door-identity","folder-trust.json"].includes(name)?"Host identity and folder execution authority require fresh trust; not restored":name.startsWith("skill-index.db")?"Derived skill search index rebuilt from the skill library; not restored":["provider-catalogs","managed-engines","team-library","memory-model","tools"].includes(name)?"Downloaded copy fetched again when needed; not restored":scratchLeftover.test(name)?"Temporary files left by an interrupted task; not restored":"Outside application-data capture; native/credential/derived state is not restored"});
    else fail("BACKUP_UNCLASSIFIED_COMPONENT");
  }
  // A skipped link inside a selected directory is not a complete capture.
  if(stage.manifest.omitted.some(item=>stage.manifest.files.every(file=>file.path!==item.path)&&item.reason.toLowerCase().includes("symlink")))fail("BACKUP_SELECTED_COMPONENT_UNAVAILABLE");
  const sources:FidelitySource[]=[];
  const memoryOriginals=new Map<string,Stats>();
  const selectedFiles=stage.manifest.files.map(file=>({path:file.path}));
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
    const source=path==="messages.db"?join(stage.directory,"state",file.path):path==="memory-index.db"?join(stage.directory,"memory-index.db"):join(root,file.path);
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
