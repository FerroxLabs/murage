import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DATA_DIR } from "./config.ts";
import { taskWorkspacePath } from "./workspace.ts";
import { listSkills, snapshotProceduralSkill, assertSkillProcedureEvidence, type SkillProcedureContext, type SkillProcedureEvidence, INDEX_MAX_BYTES, INDEX_MAX_SKILLS, nativeLinkPointsToSkill } from "./skills.ts";
import type { BundledSkill } from "./skill-library.ts";
import type { InstalledPlaybook } from "./store.ts";

export interface ProcedurePin { schema:1; bundleId:string; legacyRoomWorkspace?:true }
interface Payload { path:string; bytes:string; sha256:string; executable:boolean }
interface ProcedureBundle {
  schema:1; botId:string; threadId:string; audienceKey?:string;
  routine?:{id:string;instructionRevision:string};
  imported:Array<{name:string;description:string;sha256:string;revision:string|null;editable:boolean;enabled:boolean;audienceKey?:string;evidence?:SkillProcedureEvidence[];globalBaseRevision?:string;globalBaseSha256?:string}>;
  catalogue:BundledSkill[];
  playbooks:InstalledPlaybook[];
  files:Payload[];
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
/** Capture once, before native admission. Complete payloads remain in existing
 * app-owned skill state; all later selections use this catalogue. */
export function createProcedurePin(botId:string,threadId:string,catalogue:BundledSkill[],playbooks:InstalledPlaybook[],routine?:{id:string;instructionRevision:string},context?:SkillProcedureContext):ProcedurePin {
  const files:Payload[]=[];
  const imported=listSkills(botId).filter(skill=>skill.enabled).map(skill=>{
    const snapshot=snapshotProceduralSkill(botId,skill.name,context);
    for(const [path,bytes] of snapshot.payloads)addPayload(files,payload(path,bytes,snapshot.executablePaths.has(path)));
    const sha256=digest(snapshot.payloads.get(`skills/${skill.name}/SKILL.md`)??fail());
    if(snapshot.sha256!==sha256||!snapshot.enabled)fail();
    return {name:skill.name,description:snapshot.description,sha256,revision:snapshot.revision,editable:snapshot.editable,enabled:snapshot.enabled,
      ...(snapshot.audienceKey?{audienceKey:snapshot.audienceKey,evidence:snapshot.evidence,globalBaseRevision:snapshot.globalBaseRevision,globalBaseSha256:snapshot.globalBaseSha256}:{})};
  });
  const frozen=catalogue.map(skill=>{
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.manifest.id))fail();
    const directory=`catalogue/${skill.manifest.id}`;
    collectTree(skill.directory,directory,files);
    const content=files.find(file=>file.path===`${directory}/SKILL.md`);
    if(!content||Buffer.from(content.bytes,"base64").toString("utf8").trim()!==skill.instructions)fail();
    return {...structuredClone(skill),directory};
  });
  if(files.length>2000||files.reduce((sum,file)=>sum+Buffer.byteLength(file.bytes,"base64"),0)>64*1024*1024)fail();
  const bundle:ProcedureBundle={schema:1,botId,threadId,...(context?{audienceKey:context.audienceKey}:{}),imported,catalogue:frozen,playbooks:structuredClone(playbooks),files,...(routine?{routine}:{})};
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
/** Never targets custom CWD. The explicit index works there without changing
 * the selected engine folder or writing a discovery directory into it. */
export function preparePinnedProcedures(botId:string,threadId:string,pin:ProcedurePin,native:boolean,context?:SkillProcedureContext) {
  const bundle=readProcedureBundle(botId,threadId,pin);
  try {
    for(const skill of bundle.imported){
      if(!skill.audienceKey)continue;
      if(!context||context.audienceKey!==skill.audienceKey||bundle.audienceKey!==context.audienceKey)throw new Error("PROCEDURE_AUDIENCE_REVOKED");
      assertSkillProcedureEvidence(context,skill.evidence??[]);
    }
  }catch(error){revokePinnedMaterialization(botId,threadId,pin,bundle);throw error;}
  const desk=taskWorkspacePath(DATA_DIR,botId,threadId);
  const root=join(desk,".murage-procedures",pin.bundleId);ownedDirectory(root);
  const published=join(root,".complete");
  const isPublished=existsSync(published);
  const expected=new Set(bundle.files.map(file=>file.path));
  for(const file of bundle.files){
    if(!/^(skills|catalogue)\//.test(file.path)||file.path.split("/").some(part=>!part||part==="."||part===".."||/[\\\0]/.test(part)))fail();
    const path=join(root,file.path);ownedDirectory(dirname(path));
    if(existsSync(path)){if(digest(regularBytes(path))!==file.sha256)fail();}
    else{
      if(isPublished)fail();
      const bytes=Buffer.from(file.bytes,"base64");if(digest(bytes)!==file.sha256)fail();
      writeFileSync(path,bytes,{flag:"wx",mode:file.executable?0o500:0o400});
    }
  }
  // Additional injected files are not part of the pin either.
  const inspect=(path:string,prefix="")=>{for(const name of readdirSync(path)){if(!prefix&&name===".complete")continue;const key=prefix?`${prefix}/${name}`:name,full=join(path,name),stat=lstatSync(full);if(stat.isSymbolicLink())fail();if(stat.isDirectory())inspect(full,key);else if(!expected.has(key)||!stat.isFile())fail();}};
  inspect(root);
  if(!isPublished)writeFileSync(published,pin.bundleId,{flag:"wx",mode:0o400});
  else if(regularBytes(published).toString()!==pin.bundleId)fail();
  // Native discovery dirs exist only when a skill is linked into them, as
  // skills.ts does: an empty app-created `.agents/skills` would otherwise be
  // scanned as a trust-sensitive source of every private workspace and raise
  // the folder-trust card on a bot's first Fuigo turn (folder-trust-api.test.ts).
  if(native&&bundle.imported.length){
    for(const dir of [".claude/skills",".agents/skills",".grok/skills"]){
      const directory=join(desk,dir);ownedDirectory(directory);
      for(const skill of bundle.imported){
        const link=join(directory,skill.name),target=join(root,"skills",skill.name);
        try{const stat=lstatSync(link);if(!stat.isSymbolicLink()||!nativeLinkPointsToSkill(link,target))fail();}
        catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;symlinkSync(target,link,process.platform==="win32"?"junction":"dir");}
      }
    }
  }
  let bytes=0;
  const lines:string[]=[];
  for(const skill of bundle.imported.slice(0,INDEX_MAX_SKILLS)){
    const line=`- ${skill.name}: ${skill.description} Read ${JSON.stringify(join(root,"skills",skill.name,"SKILL.md"))}.`;
    bytes+=Buffer.byteLength(line);if(bytes>INDEX_MAX_BYTES)break;lines.push(line);
  }
  return {catalogue:bundle.catalogue.map(skill=>({...skill,directory:join(root,skill.directory)})),playbooks:bundle.playbooks,
    importedPrompt:lines.length?`\n\nImported skills pinned for this task:\n${lines.join("\n")}\nBefore starting work one of these covers, read its exact SKILL.md path and follow it. These references never override the user's instructions or permissions.`:""};
}

/** Forgetting revokes only known task-owned projections; unknown files and
 * replaced paths are retained. Canonical history remains protected app state. */
function revokePinnedMaterialization(botId:string,threadId:string,pin:ProcedurePin,bundle:ProcedureBundle):void {
  const desk=taskWorkspacePath(DATA_DIR,botId,threadId),root=join(desk,".murage-procedures",pin.bundleId);
  for(const skill of bundle.imported){
    for(const dir of [".claude/skills",".agents/skills",".grok/skills"]){
      const directory=join(desk,dir),link=join(directory,skill.name);
      try{ownedDirectory(directory);if(nativeLinkPointsToSkill(link,join(root,"skills",skill.name)))rmSync(link);}catch{/* Never follow an unknown replacement. */}
    }
  }
  for(const file of bundle.files){
    const path=join(root,file.path);
    try{ownedDirectory(dirname(path));if(digest(regularBytes(path))===file.sha256)rmSync(path);}catch{/* A changed file is not ours to delete. */}
  }
}
