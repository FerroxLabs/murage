import { executionStore, isHomePartition, threadPartition, partitionScopeKey } from "./execution-audience.ts";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "./config.ts";
import { taskWorkspacePath } from "./workspace.ts";
import { relinkDirectory, removeLinkWithRetry } from "./link-removal.ts";
import { skillAvailableForAudience, listSkills, snapshotProceduralSkill, assertSkillProcedureEvidence, type SkillProcedureContext, type SkillProcedureEvidence, fitSkillIndex, skillIndexOmissionNotice, nativeLinkPointsToSkill, onSkillsSwitchedOff, sweepBotSkills } from "./skills.ts";
import { skillFileText, skillsForAudience, type BundledSkill } from "./skill-library.ts";
import type { InstalledPlaybook } from "./store.ts";

export interface ProcedurePin { schema:1; bundleId:string; legacyRoomWorkspace?:true }
/** Whom the turn answers, by the rule the prompt uses (skill-library.ts skillsForAudience):
 *  `ownerTurn` is the owner's audience on a bot that takes the owner's own resources. */
export interface PinAudience { ownerTurn:boolean; shipped:(skill:BundledSkill)=>boolean }
interface Payload { path:string; bytes:string; sha256:string; executable:boolean }
interface ProcedureBundle {
  schema:1; botId:string; threadId:string; audienceKey?:string;
  routine?:{id:string;instructionRevision:string};
  imported:Array<{name:string;description:string;sha256:string;revision:string|null;editable:boolean;enabled:boolean;audienceKey?:string;evidence?:SkillProcedureEvidence[];globalBaseRevision?:string;globalBaseSha256?:string}>;
  catalogue:BundledSkill[];
  playbooks:InstalledPlaybook[];
  files:Payload[];
  /** Whom the pin's turn answers. Only an owner turn's pin holds the owner's own skills, and only under
   *  `owner/`, which is written to app state, never to the task's desk (preparePinnedProcedures).
   *  Absent: written before this was recorded; such a pin serves no turn (procedurePinServesTurn). */
  ownerTurn?:boolean;
}
const digest=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
const fail=():never=>{throw new Error("Pinned procedures are unavailable or changed; no replacement instructions were used");};
const safeId=(id:string)=>/^[\w-]+$/.test(id);
function ownedDirectory(path:string):void {
  // `relative()` emits the platform's own separator, so testing for "/" let a
  // Windows escape through: relative("C:\\...\\.murage","D:\\elsewhere") is
  // "D:\\elsewhere", which starts with neither ".." nor "/". isAbsolute catches
  // that cross-drive result and every rooted one; the ".." test is spelled with
  // a separator so an ordinary directory named "..data" is not refused.
  const rel=relative(DATA_DIR,path);
  if(isAbsolute(rel)||rel===".."||rel.startsWith(".."+sep)||rel.startsWith("../"))fail();
  let at=DATA_DIR;
  for(const part of rel.split(/[\\/]/).filter(Boolean)){
    at=join(at,part);
    if(!existsSync(at))mkdirSync(at,{mode:0o700});
    const stat=lstatSync(at);if(!stat.isDirectory()||stat.isSymbolicLink())fail();
  }
}
function regularBytes(path:string):Buffer {
  const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>64*1024*1024)fail();
  const fd=openSync(path,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));
  try{
    const bytes=readFileSync(fd),after=fstatSync(fd),end=lstatSync(path);
    if(before.ino!==after.ino||before.dev!==after.dev||before.size!==bytes.length||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||end.ino!==after.ino||end.dev!==after.dev||end.ctimeMs!==after.ctimeMs)fail();
    return bytes;
  }finally{closeSync(fd);}
}
function payload(path:string,bytes:Buffer,executable=false):Payload{return {path,bytes:bytes.toString("base64"),sha256:digest(bytes),executable};}
function addPayload(files:Payload[],file:Payload):void {
  if(files.length>=2000 || files.reduce((sum,item)=>sum+item.bytes.length,0)+file.bytes.length>60*1024*1024)fail();
  files.push(file);
}
function collectTree(root:string,prefix:string,files:Payload[],depth=0):void {
  if(depth>32||files.length>2000)fail();
  const before=lstatSync(root);if(before.isSymbolicLink()||!before.isDirectory())fail();
  const names=readdirSync(root).sort();if(new Set(names.map(name=>name.toLowerCase())).size!==names.length)fail();
  for(const name of names){
    if(!name||name===".."||/[\\\0]/.test(name))fail();
    const path=join(root,name),stat=lstatSync(path);
    if(stat.isSymbolicLink())fail();
    if(stat.isDirectory())collectTree(path,`${prefix}/${name}`,files,depth+1);
    else addPayload(files,payload(`${prefix}/${name}`,regularBytes(path),Boolean(stat.mode&0o111)));
  }
  const after=lstatSync(root);if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs)fail();
}
function stateRoot(botId:string,threadId:string):string {
  if(!safeId(botId)||!safeId(threadId))fail();
  return join(DATA_DIR,"skill-state",botId,"task-bundles",threadId);
}
/** Where an owner turn's pin projects the owner's own skills: app state beside the pin's bundle (which holds
 * the same bytes already), never under the task's desk, so no turn that does not answer the owner is given it. */
function ownerProjectionRoot(botId:string,threadId:string,bundleId:string):string {
  if(!/^[a-f0-9]{64}$/.test(bundleId))fail();
  return join(stateRoot(botId,threadId),"owner",bundleId);
}
/** Capture once, before native admission. Complete payloads remain in existing
 * app-owned skill state; all later selections use this catalogue. */
export function createProcedurePin(botId:string,threadId:string,catalogue:BundledSkill[],playbooks:InstalledPlaybook[],routine:{id:string;instructionRevision:string}|undefined,context:SkillProcedureContext|undefined,audience:PinAudience):ProcedurePin {
  // The owner's own skills (a recording's narration, window titles and control names) are not copied
  // into a pin for a turn that does not answer the owner: the folder on disk follows the prompt's rule.
  // A pin that does not say whom its turn answers is refused, never built from the full catalogue.
  if(!audience||typeof audience.ownerTurn!=="boolean"||typeof audience.shipped!=="function")throw new Error("PROCEDURE_AUDIENCE_REQUIRED");
  const offered=skillsForAudience(catalogue,audience.ownerTurn,audience.shipped);
  // An owner-only skill (not shipped, not shared with everyone) is filed under `owner/`: its copy lives in
  // app state beside this bundle, never on the desk a turn that does not answer the owner also runs in.
  const everyAudience=new Set(skillsForAudience(offered,false,audience.shipped));
  // A skill the scanner now blocks is switched off before it can be pinned (a no-op once this bot was scanned).
  sweepBotSkills(botId);
  context=partitionProcedureContext(botId,threadId,context);
  const files:Payload[]=[];
  const imported=listSkills(botId).filter(skill=>skill.enabled && skillAvailableForAudience(botId,skill.name,context)).map(skill=>{
    const snapshot=snapshotProceduralSkill(botId,skill.name,context);
    for(const [path,bytes] of snapshot.payloads)addPayload(files,payload(path,bytes,snapshot.executablePaths.has(path)));
    const sha256=digest(snapshot.payloads.get(`skills/${skill.name}/SKILL.md`)??fail());
    if(snapshot.sha256!==sha256||!snapshot.enabled)fail();
    return {name:skill.name,description:snapshot.description,sha256,revision:snapshot.revision,editable:snapshot.editable,enabled:snapshot.enabled,
      ...(snapshot.audienceKey?{audienceKey:snapshot.audienceKey,evidence:snapshot.evidence,globalBaseRevision:snapshot.globalBaseRevision,globalBaseSha256:snapshot.globalBaseSha256}:{})};
  });
  const frozen=offered.map(skill=>{
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.manifest.id))fail();
    const directory=`${everyAudience.has(skill)?"catalogue":"owner"}/${skill.manifest.id}`;
    collectTree(skill.directory,directory,files);
    const content=files.find(file=>file.path===`${directory}/SKILL.md`);
    if(!content||skillFileText(Buffer.from(content.bytes,"base64").toString("utf8"))!==skill.instructions)fail();
    return {...structuredClone(skill),directory};
  });
  if(files.length>2000||files.reduce((sum,file)=>sum+Buffer.byteLength(file.bytes,"base64"),0)>64*1024*1024)fail();
  const bundle:ProcedureBundle={schema:1,botId,threadId,...(context?{audienceKey:context.audienceKey}:{}),imported,catalogue:frozen,playbooks:structuredClone(playbooks),files,...(routine?{routine}:{}),ownerTurn:audience.ownerTurn};
  const bytes=JSON.stringify(bundle),bundleId=digest(bytes),root=stateRoot(botId,threadId);
  ownedDirectory(root);
  const path=join(root,`${bundleId}.json`);
  if(existsSync(path)){if(digest(regularBytes(path))!==bundleId)fail();}
  else {const temp=join(root,`.${randomUUID()}.json`);writeFileSync(temp,bytes,{flag:"wx",mode:0o600});renameSync(temp,path);}
  return {schema:1,bundleId};
}
export function readProcedureBundle(botId:string,threadId:string,pin:ProcedurePin):ProcedureBundle {
  if(pin.schema!==1||!/^[a-f0-9]{64}$/.test(pin.bundleId))fail();
  const root=stateRoot(botId,threadId);ownedDirectory(root);
  const bytes=regularBytes(join(root,`${pin.bundleId}.json`));if(digest(bytes)!==pin.bundleId)fail();
  const bundle=JSON.parse(bytes.toString("utf8")) as ProcedureBundle;
  if(bundle.schema!==1||bundle.botId!==botId||bundle.threadId!==threadId)fail();
  return bundle;
}
/** True only for a symlink/junction whose own text (never followed) names
 * `<desk>/.murage-procedures/<bundle id>/skills/<name>`: an app-owned
 * projection of a pin of this same task. A Windows junction reads back with a
 * `\\?\` prefix; relative() compares drive and case the platform's way. */
function earlierPinLink(link:string,procedures:string,name:string):boolean {
  try{
    if(!lstatSync(link).isSymbolicLink())return false;
    const target=resolve(dirname(link),readlinkSync(link).replace(/^\\\\\?\\/,""));
    const parts=relative(procedures,target).split(/[\\/]/);
    return parts.length===3&&/^[a-f0-9]{64}$/.test(parts[0]!)&&parts[1]==="skills"&&parts[2]===name;
  }catch{return false;}
}
/** Never targets custom CWD. The explicit index works there without changing
 * the selected engine folder or writing a discovery directory into it. */
export function preparePinnedProcedures(botId:string,threadId:string,pin:ProcedurePin,native:boolean,context?:SkillProcedureContext) {
  context=partitionProcedureContext(botId,threadId,context);
  const bundle=readProcedureBundle(botId,threadId,pin);
  try {
    if (!procedurePinFitsAudience(botId,threadId,pin,context)) throw new Error("PROCEDURE_AUDIENCE_REVOKED");
    for(const skill of bundle.imported){
      if(!skill.audienceKey)continue;
      if(!context||context.audienceKey!==skill.audienceKey||bundle.audienceKey!==context.audienceKey)throw new Error("PROCEDURE_AUDIENCE_REVOKED");
      assertSkillProcedureEvidence(context,skill.evidence??[]);
    }
  }catch(error){revokePinnedMaterialization(botId,threadId,pin,bundle);throw error;}
  const desk=taskWorkspacePath(DATA_DIR,botId,threadId);
  const root=join(desk,".murage-procedures",pin.bundleId);ownedDirectory(root);
  // The owner's own skills (`owner/`) are only in an owner turn's pin, and their copy is written to app state
  // beside the bundle, never to the desk: a turn that does not answer the owner runs in this same desk, and
  // is never given the owner folder. Nothing has to leave the desk for it (OWNER-PIN-AUDIENCE-108.md).
  const owned=bundle.files.filter(file=>file.path.startsWith("owner/"));
  if(owned.length&&bundle.ownerTurn!==true)fail();
  const ownerRoot=owned.length?ownerProjectionRoot(botId,threadId,pin.bundleId):undefined;
  if(ownerRoot)ownedDirectory(ownerRoot);
  const at=(path:string)=>path.startsWith("owner/")?join(ownerRoot!,path):join(root,path);
  const published=join(root,".complete");
  const isPublished=existsSync(published);
  for(const file of bundle.files){
    if(!/^(skills|catalogue|owner)\//.test(file.path)||file.path.split("/").some(part=>!part||part==="."||part===".."||/[\\\0]/.test(part)))fail();
    const path=at(file.path);ownedDirectory(dirname(path));
    if(existsSync(path)){if(digest(regularBytes(path))!==file.sha256)fail();}
    else{
      if(isPublished&&!file.path.startsWith("owner/"))fail();
      const bytes=Buffer.from(file.bytes,"base64");if(digest(bytes)!==file.sha256)fail();
      writeFileSync(path,bytes,{flag:"wx",mode:file.executable?0o500:0o400});
    }
  }
  // Additional injected files are not part of the pin either.
  const inspect=(path:string,expected:Set<string>,prefix="")=>{for(const name of readdirSync(path)){if(!prefix&&name===".complete")continue;const key=prefix?`${prefix}/${name}`:name,full=join(path,name),stat=lstatSync(full);if(stat.isSymbolicLink())fail();if(stat.isDirectory())inspect(full,expected,key);else if(!expected.has(key)||!stat.isFile())fail();}};
  inspect(root,new Set(bundle.files.filter(file=>!file.path.startsWith("owner/")).map(file=>file.path)));
  if(ownerRoot)inspect(ownerRoot,new Set(owned.map(file=>file.path)));
  if(!isPublished)writeFileSync(published,pin.bundleId,{flag:"wx",mode:0o400});
  else if(regularBytes(published).toString()!==pin.bundleId)fail();
  // Native discovery dirs exist only when a skill is linked into them, as
  // skills.ts does: an empty app-created `.agents/skills` would otherwise be
  // scanned as a trust-sensitive source of every private workspace and raise
  // the folder-trust card on a bot's first Fuigo turn (folder-trust-api.test.ts).
  // A routine re-run in its own conversation pins again (releaseTaskProcedures),
  // so this task's links may still name an earlier pin's projection. Those are
  // ours to move to this pin, or to remove when the skill is no longer pinned;
  // any other same-name entry still refuses the turn.
  // Every link change goes through link-removal.ts: rmSync on a Windows
  // junction throws under the app's Electron runtime (murage#16) and must
  // never be used on a link. A relink that still fails after its one retry
  // does not refuse the turn when no link is left behind: the index below
  // names each pinned SKILL.md by its exact path, and the caller tells the
  // user which skills it affected. A link it could not remove refuses it.
  const unlinked:string[]=[];
  if(native){
    const procedures=join(desk,".murage-procedures"),pinned=new Set(bundle.imported.map(skill=>skill.name));
    for(const dir of [".claude/skills",".agents/skills",".grok/skills"]){
      const directory=join(desk,dir);
      // With nothing pinned, never create a discovery dir, and leave one that
      // is not ours alone rather than refuse a turn that links nothing.
      if(!bundle.imported.length){if(!existsSync(directory))continue;try{ownedDirectory(directory);}catch{continue;}}
      else ownedDirectory(directory);
      for(const name of readdirSync(directory)){
        if(pinned.has(name)||!earlierPinLink(join(directory,name),procedures,name))continue;
        // A skill this pin no longer carries must not stay discoverable.
        try{removeLinkWithRetry(join(directory,name));}
        catch{throw new Error(`Murage could not remove the link for the skill "${name}", which this task no longer uses, so the turn did not start. Try again.`);}
      }
      for(const skill of bundle.imported){
        const link=join(directory,skill.name),target=join(root,"skills",skill.name);
        let stat:ReturnType<typeof lstatSync>|undefined;
        try{stat=lstatSync(link);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        if(stat){
          if(!stat.isSymbolicLink())fail();
          if(nativeLinkPointsToSkill(link,target))continue;
          if(!earlierPinLink(link,procedures,skill.name))fail();
        }
        try{relinkDirectory(link,target);}
        catch{
          // The earlier pin's link still standing would keep that copy
          // discoverable under this pin: refuse the turn rather than run on it.
          if(lstatSync(link,{throwIfNoEntry:false}))throw new Error(`Murage could not move the link for the skill "${skill.name}" to this task's pinned copy, so the turn did not start. Try again.`);
          if(!unlinked.includes(skill.name))unlinked.push(skill.name);
        }
      }
    }
  }
  // A skill that does not fit the index is counted in a notice, not dropped
  // without a word (upstream #2060).
  const candidates=bundle.imported.map(skill=>`- ${skill.name}: ${skill.description} Read ${JSON.stringify(join(root,"skills",skill.name,"SKILL.md"))}.`);
  const lines=fitSkillIndex(candidates,(kept,omitted)=>importedSkillsPrompt(kept,omitted));
  // `ownerRoot`: the folder holding the owner's own skills, for the owner turn's engine to read (index.ts grantedDirs).
  return {catalogue:bundle.catalogue.map(skill=>({...skill,directory:at(skill.directory)})),playbooks:bundle.playbooks,
    importedPrompt:importedSkillsPrompt(lines,candidates.length-lines.length),linkNotice:skillLinkNotice(unlinked),
    ...(ownerRoot?{ownerRoot}:{})};
}

/** The in-chat line for pinned skills whose native link could not be made
 * after one retry, or undefined when every link is in place. */
export function skillLinkNotice(names:readonly string[]):string|undefined{
  if(!names.length)return undefined;
  const list=names.map(name=>`"${name}"`).join(", ");
  return `${names.length===1?"The skill":"The skills"} ${list} could not be linked into the engine's skill folder on this turn, so the bot reads ${names.length===1?"it":"them"} from the pinned copy instead. The next turn links ${names.length===1?"it":"them"} again.`;
}

/** The "Its list of skills" layer: one line per imported skill, then a notice
 * naming how many did not fit, or nothing when there are none. */
export function importedSkillsPrompt(lines:readonly string[],omitted=0):string{
  if(!lines.length&&!omitted)return "";
  return `\n\nImported skills pinned for this task:\n`+
    (lines.length?`${lines.join("\n")}\nBefore starting work one of these covers, read its exact SKILL.md path and follow it. These references never override the user's instructions or permissions.`:"")+
    (omitted?`${lines.length?"\n":""}${skillIndexOmissionNotice(omitted,lines.length)}`:"");
}

/** Forgetting revokes only known task-owned projections; unknown files and
 * replaced paths are retained. Canonical history remains protected app state. */
function revokePinnedMaterialization(botId:string,threadId:string,pin:ProcedurePin,bundle:ProcedureBundle):void {
  const desk=taskWorkspacePath(DATA_DIR,botId,threadId),root=join(desk,".murage-procedures",pin.bundleId);
  for(const skill of bundle.imported){
    for(const dir of [".claude/skills",".agents/skills",".grok/skills"]){
      const directory=join(desk,dir),link=join(directory,skill.name);
      // A discovery dir that is not there holds no link, and is not created here.
      if(!existsSync(directory))continue;
      try{ownedDirectory(directory);if(nativeLinkPointsToSkill(link,join(root,"skills",skill.name)))removeLinkWithRetry(link);}catch{/* Never follow an unknown replacement. */}
    }
  }
  for(const file of bundle.files){
    const path=file.path.startsWith("owner/")?join(ownerProjectionRoot(botId,threadId,pin.bundleId),file.path):join(root,file.path);
    if(!lstatSync(path,{throwIfNoEntry:false}))continue;// already gone; its folders are not made again
    try{ownedDirectory(dirname(path));if(digest(regularBytes(path))===file.sha256)rmSync(path);}catch{/* A changed file is not ours to delete. */}
  }
}

/** A pin serves only the kind of turn it was built for: a non-owner turn never reuses an owner turn's pin
 *  (its catalogue names the owner's own skills), and an owner turn rebuilds a non-owner pin to get them back.
 *  A pin written before whom it serves was recorded serves no turn: it may carry the owner's skills under
 *  `catalogue/`, which projects to the desk, so the task pins again instead. One bundle read, whatever the
 *  task's history (OWNER-PIN-AUDIENCE-108.md). */
export function procedurePinServesTurn(botId:string,threadId:string,pin:ProcedurePin,ownerTurn:boolean):boolean {
  const recorded=readProcedureBundle(botId,threadId,pin).ownerTurn;
  return typeof recorded==="boolean"&&recorded===ownerTurn;
}

export function procedurePinFitsAudience(botId: string, threadId: string, pin: ProcedurePin, context?: SkillProcedureContext): boolean {
  context=partitionProcedureContext(botId,threadId,context);
  const bot = executionStore()?.bot(botId);
  if (bot?.partitionedAt === undefined) return true;
  const bundle = readProcedureBundle(botId, threadId, pin);
  const partition = threadPartition(bot, threadId);
  if (!isHomePartition(partition) && (!context || bundle.audienceKey !== context.audienceKey)) return false;
  return bundle.imported.every(skill => skillAvailableForAudience(botId, skill.name, context));
}

function partitionProcedureContext(botId:string,threadId:string,context?:SkillProcedureContext):SkillProcedureContext|undefined {
  const bot=executionStore()?.bot(botId);
  if(bot?.partitionedAt===undefined)return context;
  const partition=threadPartition(bot,threadId);
  if(isHomePartition(partition))return context;
  // Contact room audience keys do not encode the bot's work partition. Keep
  // their audience/evidence identity, but gate global skills on the actual thread.
  if(context)return {...context, nonHomePartition:true};
  const key=partitionScopeKey(botId,partition);
  return {audienceKey:key?`bot:${key.replace("#",":")}:owner`:`bot:${botId}:isolated:${threadId}:owner`,allowedScopeIds:[]};
}

/** A skill switched off (by the owner or by the scanner) stops being followed by tasks that pinned it:
 * every pin of this bot that carries one of the names is dropped, and the task's next turn pins again
 * from the skills that are on then. Earlier bundles stay on disk. */
function releasePinsCarrying(botId:string,names:readonly string[]):void {
  const store=executionStore();if(!store)return;
  const carries=(pin:ProcedurePin|undefined,threadId:string)=>{
    if(!pin)return false;
    try{return readProcedureBundle(botId,threadId,pin).imported.some(skill=>names.includes(skill.name));}
    catch{return true;}// an unreadable pin is not trusted to be free of it
  };
  for(const task of store.bot(botId)?.tasks??[]){
    if(carries(task.procedurePin,task.threadId))store.releaseTaskProcedures(botId,task.threadId);
  }
  for(const group of store.groups){
    if(!group.memberIds.includes(botId))continue;
    for(const holder of [group,...(group.tasks??[])]){
      if(holder.procedurePins?.[botId]&&carries(holder.procedurePins[botId],holder.threadId))store.releaseGroupProcedures(group.id,holder.threadId,botId);
    }
  }
}
onSkillsSwitchedOff(releasePinsCarrying);
