// Actual packaged macOS arm64 main/preload/owner-HTTP/renderer proof.
// Preparation does not launch anything; run explicitly against an accepted private artifact:
// node scripts/smoke-memory-desktop.mjs --app /absolute/private/Murage.app --out /absolute/new-evidence-directory
// No installed app replacement, development owner bypass, real model calls or kill-by-name.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron, expect } from "@playwright/test";

const exec=promisify(execFile),args=process.argv.slice(2);
function option(flag){const index=args.indexOf(flag);return index<0?undefined:args[index+1];}
const within=(root,path)=>{const rel=relative(realpathSync(root),realpathSync(path));return rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);};
const digest=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function processes(){
  const {stdout}=await exec("/bin/ps",["-axo","pid=,ppid=,comm="]);
  return stdout.split("\n").flatMap(line=>{const match=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);return match?[{pid:Number(match[1]),parent:Number(match[2]),command:match[3]}]:[];});
}
async function frontmost(){
  const {stdout}=await exec("/usr/bin/osascript",["-l","JavaScript","-e",'ObjC.import("AppKit");var app=$.NSWorkspace.sharedWorkspace.frontmostApplication;JSON.stringify({pid:Number(app.processIdentifier),bundle:String(ObjC.unwrap(app.bundleIdentifier)||"")});']);
  return JSON.parse(stdout.trim());
}
async function restoreFrontmost(original){
  assert(Number.isSafeInteger(original.pid)&&original.pid>0);
  const source=`ObjC.import("AppKit");var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${original.pid});if(Number(app.processIdentifier)!==${original.pid}||String(ObjC.unwrap(app.bundleIdentifier)||"")!==${JSON.stringify(original.bundle)})throw Error("Original application identity unavailable");app.activateWithOptions(2);`;
  await exec("/usr/bin/osascript",["-l","JavaScript","-e",source]);
  await expect.poll(async()=>await frontmost(),{timeout:10000}).toEqual(original);
}
function protectedHashes(root){return Object.fromEntries(["config.json","bots.json","groups.json"].flatMap(name=>{const file=join(root,name);return existsSync(file)?[[name,digest(file)]]:[];}));}

async function main(){
  assert.equal(process.platform,"darwin","This gate is macOS-native only");assert.equal(process.arch,"arm64","This gate is Apple Silicon only");
  assert(Number(process.versions.node.split(".")[0])>=24,"Run the fixture with Node24+ for node:sqlite");
  const requested=option("--app"),outArgument=option("--out");
  assert(requested&&isAbsolute(requested)&&outArgument&&isAbsolute(outArgument),"Explicit absolute --app and --out are required");
  const appPath=realpathSync(requested),out=resolve(outArgument),protectedProfile=resolve(option("--protected-profile")??join(homedir(),".murage"));
  assert(appPath.endsWith(".app")&&lstatSync(appPath).isDirectory(),"Expected an actual .app bundle");
  assert(!within("/Applications",appPath)&&!within(join(homedir(),"Applications"),appPath),"Refusing to launch an installed application for this fixture");
  assert(!existsSync(out)||readdirSync(out).length===0,"Evidence destination must be new or empty");mkdirSync(out,{recursive:true,mode:0o700});
  const executable=join(appPath,"Contents/MacOS/Murage"),resources=join(appPath,"Contents/Resources"),archive=join(resources,"app.asar");
  assert(existsSync(executable)&&existsSync(archive)&&existsSync(join(resources,"server/index.js")),"Private packaged executable, app.asar and server are required");
  // ASAR stores source bytes without compression. Refuse an older artifact
  // without the tested pre-lock override before its main process can start.
  const archiveBytes=readFileSync(archive),isolationAt=archiveBytes.indexOf(Buffer.from("// Explicit fixture/profile isolation"));
  const overrideAt=archiveBytes.indexOf(Buffer.from('app.setPath("userData", isolatedUserData);'),isolationAt);
  const lockAt=archiveBytes.indexOf(Buffer.from("app.requestSingleInstanceLock()"),isolationAt);
  assert(isolationAt>=0&&overrideAt>isolationAt&&lockAt>overrideAt,"Candidate lacks the tested pre-lock user-data override; rebuild before native verification");
  const originalProcesses=await processes(),originalFront=await frontmost(),beforeHashes=protectedHashes(protectedProfile);
  assert(!originalProcesses.some(process=>process.command===executable),"This candidate artifact is already running; use an unused private artifact");
  const originalMurage=originalProcesses.filter(process=>/\/Contents\/MacOS\/Murage$/.test(process.command));
  const root=mkdtempSync(join(tmpdir(),"murage-memory-desktop-")),data=join(root,"data"),userData=join(root,"electron-user-data"),home=join(root,"home"),temp=join(root,"tmp");
  for(const directory of [data,userData,home,temp])mkdirSync(directory,{recursive:true,mode:0o700});
  assert(!within(protectedProfile,data)&&!within(data,protectedProfile),"Fixture data overlaps the protected installation");
  let application,page,db,fake,mainProcess;let providerCalls=0,checks=[],cleanupVerified=false,foregroundRestored=false;
  const owned=new Map();let outcome;
  const rememberChildren=async()=>{
    if(!mainProcess?.pid)return;
    const current=await processes(),parents=new Set([mainProcess.pid]);let changed=true;
    while(changed){changed=false;for(const process of current)if(parents.has(process.parent)&&!parents.has(process.pid)){parents.add(process.pid);owned.set(process.pid,process);changed=true;}}
  };
  try{
    fake=createServer((request,response)=>{
      if(request.method==="GET"&&request.url==="/v1/models"){response.setHeader("content-type","application/json");response.end(JSON.stringify({data:[{id:"native-memory-fixture",name:"Synthetic fixture"}]}));return;}
      providerCalls++;response.writeHead(503,{"content-type":"application/json"});response.end('{"error":"No model calls are allowed in this UI proof"}');
    });
    await new Promise(done=>fake.listen(0,"127.0.0.1",done));const address=fake.address();assert(address&&typeof address!=="string");
    writeFileSync(join(data,"config.json"),JSON.stringify({profile:{name:"Native memory fixture"},instances:{fixture:{driver:"openai-compat",displayName:"Isolated fixture",config:{url:`http://127.0.0.1:${address.port}/v1`,key:"synthetic-local-only",model:"native-memory-fixture"}}}}),{mode:0o600});
    writeFileSync(join(userData,"companion-settings.json"),JSON.stringify({enabled:false,remoteAccess:false,keepAwake:false}),{mode:0o600});
    const env={PATH:"/usr/bin:/bin:/usr/sbin:/sbin",HOME:home,USERPROFILE:home,TMPDIR:temp,TMP:temp,TEMP:temp,
      XDG_CONFIG_HOME:join(home,"config"),XDG_CACHE_HOME:join(home,"cache"),XDG_DATA_HOME:join(home,"data"),
      MURAGE_DATA_DIR:data,MURAGE_USER_DATA:userData,HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",LANG:process.env.LANG??"en_US.UTF-8"};
    // The packaged main validates these explicit paths and sets userData before
    // the instance lock. The Chromium switch agrees; HOME is independently isolated.
    application=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${userData}`],cwd:root,env,timeout:60000});
    mainProcess=application.process();assert(mainProcess.pid);owned.set(mainProcess.pid,{pid:mainProcess.pid,command:executable});
    const identity=await application.evaluate(({app})=>({userData:app.getPath("userData"),home:app.getPath("home"),envHome:process.env.HOME,nodeHome:process.getBuiltinModule("node:os").homedir(),sessionData:app.getPath("sessionData"),logs:app.getPath("logs"),packaged:app.isPackaged,appPath:app.getAppPath(),lock:app.hasSingleInstanceLock(),data:process.env.MURAGE_DATA_DIR,pid:process.pid}));
    checks.push({nativeIdentity:identity});
    assert.equal(identity.packaged,true);assert.equal(realpathSync(identity.userData),realpathSync(userData));assert.equal(realpathSync(identity.data),realpathSync(data));assert.equal(identity.lock,true);assert.equal(identity.pid,mainProcess.pid);assert.equal(identity.appPath,archive);
    // macOS reports the OS account home independently of HOME. Verify the
    // actual Node home and every writable profile root; retain OS home as diagnostics.
    assert(within(root,identity.envHome)&&within(root,identity.nodeHome)&&within(root,identity.logs)&&within(root,identity.sessionData),"Writable native profile paths escaped the fixture root");
    checks.push("actual-private-app-isolated-userdata-data-and-single-instance-lock");
    page=await application.firstWindow();page.setDefaultTimeout(20000);
    await page.waitForURL(url=>url.protocol==="http:"&&url.hostname==="127.0.0.1",{timeout:60000});
    await page.waitForFunction(()=>typeof window.muragebox?.desktopSurfaceSecret==="string"&&window.muragebox.desktopSurfaceSecret.length>0);
    assert.equal(await page.evaluate(()=>typeof window.require),"undefined");
    const origin=new URL(page.url()).origin;
    assert.equal((await fetch(`${origin}/api/memory/status`,{signal:AbortSignal.timeout(10000)})).status,404,"Unauthenticated owner route must remain hidden");
    const api=async(method,path,body)=>page.evaluate(async({method,path,body})=>{
      const proof=window.muragebox.desktopSurfaceSecret;
      if(!proof)throw Error("Actual packaged preload owner proof is unavailable");
      const response=await fetch(path,{method,headers:{"content-type":"application/json","x-murage-surface":"desktop","x-murage-surface-secret":proof},body:body===undefined?undefined:JSON.stringify(body)});
      if(!response.ok)throw Error(`Owner API ${path} returned ${response.status}`);return response.json();
    },{method,path,body});
    await api("GET","/api/memory/status");checks.push("real-packaged-preload-owner-proof-and-unauthenticated-denial");
    const bot=(await api("POST","/api/bots",{name:"Native memory review",section:"Native fixture"})).bot;
    const other=(await api("POST","/api/bots",{name:"Other isolated audience",section:"Native fixture"})).bot;
    const room=(await api("POST","/api/groups",{name:"Native reviewed audience",memberIds:[bot.id,other.id],setup:{bulletin:"Synthetic native memory audience",defaultResponder:{kind:"member",botId:bot.id}}})).group;
    const dbPath=join(data,"messages.db");assert(within(realpathSync(data),realpathSync(dbPath)));db=new DatabaseSync(dbPath);db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    const scope=(kind,owner)=>String(db.prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").get(kind,owner).id);
    const botScope=scope("bot",bot.id),roomScope=scope("room",room.id),source="native-source",record="native-candidate",original="NATIVEORCHID The reviewed launch day is Tuesday.",corrected="NATIVEORCHID The reviewed launch day is Thursday.";
    const payload=JSON.stringify({text:original}),hash=createHash("sha256").update(payload).digest("hex");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,?,?,1,?,'text','owner','completed','active')").run(source,botScope,bot.threadId,"native-source-message",hash);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(source,hash,payload);
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','candidate',0,1,NULL,NULL,1)").run(record,botScope,original);
    db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,?)").run(record,source,Buffer.byteLength(original));
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1; COMMIT");assert.equal(db.prepare("PRAGMA foreign_key_check").all().length,0);
    // Dismiss only the product's own optional onboarding controls; no DOM overlay
    // deletion, forced clicks, route interception or fabricated preload bridge.
    await page.evaluate(()=>localStorage.setItem("murage-email-gate","skipped"));await page.reload();
    await expect(page.getByRole("button",{name:/^Open .+'s profile$/}).first()).toBeVisible();
    const invitation=page.getByRole("complementary",{name:"Let your bots pick the right model",exact:true});
    if(await invitation.isVisible()){await invitation.getByRole("button",{name:"Not now",exact:true}).last().click();await expect(invitation).not.toBeVisible();}
    // HTTP creation/hydration can leave the other seeded bot selected. Use the
    // actual navigation row to establish the intended chat before its header
    // exposes that bot's profile control; do not assume creation order selects it.
    const sidebar=page.getByRole("complementary",{name:"Bots and navigation",exact:true});
    const targetRow=sidebar.locator('div[role="button"]').filter({has:page.getByText(bot.name,{exact:true})});
    await expect(targetRow).toHaveCount(1);await targetRow.click();
    // ChatView exposes the same profile action on both avatar and title. Choose
    // the visible title button explicitly; both dispatch toggleSettings(open:true).
    const profile=page.getByRole("main").getByRole("button",{name:`Open ${bot.name}'s profile`,exact:true}).filter({hasText:bot.name});
    await expect(profile).toHaveCount(1);await expect(profile).toBeVisible();await profile.click();
    await page.locator("summary").filter({hasText:/^Managed memory$/}).click();
    await expect(page.getByRole("heading",{name:"Bot memory",exact:true})).toBeVisible();
    await page.screenshot({path:join(out,"bot-memory-settings.png"),fullPage:true});checks.push("actual-packaged-bot-managed-memory-settings");
    await page.getByRole("button",{name:"Close agent profile",exact:true}).click();
    await sidebar.getByRole("button",{name:"More",exact:true}).click();await sidebar.getByRole("menuitem",{name:"Team map",exact:true}).click();
    await page.getByRole("button",{name:"Manage memory",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Workspace memory",exact:true})).toBeVisible();
    const clickAction=async(label,action)=>{
      const response=page.waitForResponse(response=>response.url().endsWith("/api/memory/action")&&response.request().postDataJSON()?.action===action);
      await page.getByRole("button",{name:label,exact:true}).click();assert.equal((await response).ok(),true,`Native UI ${action} failed`);
    };
    const inspect=async()=>{
      await page.getByRole("combobox",{name:"Audience",exact:true}).selectOption(botScope);await page.getByRole("combobox",{name:"Record status",exact:true}).selectOption("active");
      await clickAction("Search","list");await page.locator(`[data-memory-id="${record}"]`).getByRole("button",{name:"Inspect memory",exact:true}).click();
      await expect(page.getByRole("region",{name:"Memory details",exact:true})).toHaveAttribute("data-memory-detail-id",record);
    };
    await page.getByRole("combobox",{name:"Audience",exact:true}).selectOption(botScope);await page.getByRole("combobox",{name:"Record status",exact:true}).selectOption("candidate");await page.getByRole("textbox",{name:"Search memory",exact:true}).fill("NATIVEORCHID");
    await clickAction("Search","list");await page.locator(`[data-memory-id="${record}"]`).getByRole("button",{name:"Inspect memory",exact:true}).click();
    await expect(page.getByRole("region",{name:"Memory details",exact:true})).toBeVisible();
    await page.screenshot({path:join(out,"candidate-review.png"),fullPage:true});await clickAction("Approve candidate","approve");await inspect();
    await page.getByRole("textbox",{name:"Correction text",exact:true}).fill(corrected);await clickAction("Save correction","correct");await inspect();
    await page.getByRole("combobox",{name:"Share with audience",exact:true}).selectOption(roomScope);await clickAction("Share memory","promote");await inspect();await clickAction("Pin memory","pin");await inspect();
    await expect(page.getByRole("button",{name:"Unpin memory",exact:true})).toBeVisible();
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_records WHERE scope_id=? AND state='active' AND text=?").get(roomScope,corrected).n,1);
    await page.screenshot({path:join(out,"shared-corrected-pinned.png"),fullPage:true});checks.push("native-team-map-review-correction-sharing-pinning-persisted");
    await page.getByRole("checkbox",{name:"Confirm forgetting this memory",exact:true}).check();await clickAction("Forget memory","forget");
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_records WHERE id=? AND state='active'").get(record).n,0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_records WHERE scope_id=? AND state='active' AND text=?").get(roomScope,corrected).n,0);
    await page.screenshot({path:join(out,"forgotten.png"),fullPage:true});checks.push("native-forget-revokes-source-and-shared-derivative");
    assert.equal(providerCalls,0,"UI-only proof unexpectedly attempted a model request");
    outcome={ok:true,platform:process.platform,arch:process.arch,node:process.version,appPath,appArchiveSha256:digest(archive),serverSha256:digest(join(resources,"server/index.js")),checks,providerCalls,
      roots:{data,userData,home},identity,protectedProfile,protectedFiles:Object.keys(beforeHashes),originalMuragePids:originalMurage.map(process=>process.pid),
      limitation:"Actual packaged macOS arm64 GUI/main/preload/owner API only. Synthetic evidence; no native-model generation, semantic inference, Windows, Linux or Intel proof."};
  }catch(error){
    try{await page?.screenshot({path:join(out,"failure.png"),fullPage:true});}catch{/* preserve primary failure */}
    outcome={ok:false,platform:process.platform,arch:process.arch,appPath,checks,error:error?.stack??String(error),providerCalls};
  }finally{
    try{db?.close();}catch{}
    try{
      await rememberChildren();
      if(application){let timer;try{await Promise.race([application.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Task-owned Electron did not close")),20000);})]);}finally{clearTimeout(timer);}}
    }catch{/* exact task-owned fallback below; never target another app by name */}
    for(const [pid,known] of [...owned].reverse()){
      const current=(await processes()).find(process=>process.pid===pid);
      if(current&&current.command===known.command){try{process.kill(pid,"SIGTERM");}catch{}}
    }
    for(let i=0;i<40;i++){if(!(await processes()).some(process=>owned.has(process.pid)&&owned.get(process.pid).command===process.command))break;await sleep(100);}
    for(const [pid,known] of owned){const current=(await processes()).find(process=>process.pid===pid);if(current&&current.command===known.command){try{process.kill(pid,"SIGKILL");}catch{}}}
    await sleep(100);
    cleanupVerified=!(await processes()).some(process=>owned.has(process.pid)&&owned.get(process.pid).command===process.command);
    if(fake){fake.closeAllConnections();await new Promise(done=>fake.close(done));}
    try{await restoreFrontmost(originalFront);foregroundRestored=true;}catch(error){outcome={...outcome,ok:false,foregroundError:String(error)};}
    const after=await processes();const originalProcessesAlive=originalMurage.every(original=>after.some(process=>process.pid===original.pid&&process.command===original.command));
    const protectedFilesUnchanged=JSON.stringify(protectedHashes(protectedProfile))===JSON.stringify(beforeHashes);
    outcome={...outcome,ok:Boolean(outcome?.ok&&cleanupVerified&&foregroundRestored&&originalProcessesAlive&&protectedFilesUnchanged),cleanupVerified,foregroundRestored,originalProcessesAlive,protectedFilesUnchanged,ownedPids:[...owned.keys()]};
    if(cleanupVerified)rmSync(root,{recursive:true,force:true});else outcome.preservedFixtureRoot=root;
    writeFileSync(join(out,"result.json"),JSON.stringify(outcome,null,2));
  }
  console.log(JSON.stringify(outcome));assert(outcome.ok,`Native packaged memory gate failed; inspect ${join(out,"result.json")}`);
}
main().catch(error=>{console.error(error?.stack??String(error));process.exitCode=1;});
