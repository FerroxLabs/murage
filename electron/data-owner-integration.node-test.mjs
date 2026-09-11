// Node runner: included by package.json test:electron, not Vitest discovery.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { awaitOwnedWork } from "./server-child-lifecycle.mjs";
import { dataDirLeasePaths } from "./data-dir-lease.mjs";
import { deriveManagedComposioCredentials, MANAGED_COMPOSIO_UPDATE_OPTIONS } from "./managed-composio.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { trackedCredentialUpdate } from "./secure-credentials.mjs";

const rawSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
// Test-only negative controls execute the actual main function with exactly
// one barrier removed. They never edit the shared worktree or launch Electron.
const controls = {
  "no-bootstrap-lease": ['  if (app.isPackaged) acquireDesktopDataOwner();', ''],
  "no-child-root": ['    MURAGE_DATA_DIR: desktopDataDir,', ''],
  "no-fallback-wait": ['  await lifecycle.stop();\n  assertDesktopStartupActive();', '  void lifecycle.stop();\n  assertDesktopStartupActive();'],
  "no-shutdown-child-wait": ['    await awaitOwnedWork(Promise.all([...ownedServerChildren].map((child) => child.stop())), "The owned harness has not exited");', ''],
  "no-credential-wait": ['    await awaitOwnedWork(Promise.allSettled([...credentialWrites]), "Credential writes have not settled");', ''],
  "no-cua-wait": ['    await awaitOwnedWork(stopCua(), "Computer-use cleanup has not completed", CUA_STOP_TIMEOUT_MS);', ''],
  "no-legacy-migration": ['    migrateLegacyDataDirectory({', '    (() => false)({'],
};
const control = process.env.MURAGE_OWNER_TEST_CONTROL;
if (control) assert.ok(controls[control] && rawSource.includes(controls[control][0]), "negative control matches production");
const source = control ? rawSource.replace(...controls[control]) : rawSource;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const bootstrapDependencies = `process.env ??= {}; const path={join:(...parts)=>parts.join("/")}; const ownedDesktopDataDir=()=>"/fixture/canonical"; const migrateLegacyDataDirectory=()=>{}; const assertRestoreReviewed=()=>{}; const configureRestoredDesktopConnections=()=>{};`;
const between = (start, end) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `actual main wiring exists: ${start}`);
  return source.slice(first, last);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("packaged bootstrap claims canonical ownership before credential reads or migrations", async () => {
  const events = [];
  const body = between('app.whenReady().then(async () => {', '  // Boot migrations above').split('async () => {')[1];
  const run = new AsyncFunction("app", "process", "APP_ICON", "loadSecureCredentials", "secureComposioConfig", "secureWorkspaceConfig", "acquireDesktopDataOwner", "assertDesktopStartupActive", `${bootstrapDependencies} let secureCredentials; ${body}`);
  await run({isPackaged:true,setAsDefaultProtocolClient(){},getPath:()=>"/fixture/home"}, {platform:"linux"}, null,
    async()=>{events.push("read");return{};}, async()=>events.push("composio"), async()=>events.push("workspace"),
    ()=>events.push("lease"), ()=>{});
  assert.deepEqual(events, ["lease", "read", "composio", "workspace"]);
});

test("development bootstrap never claims packaged data ownership or migrates config", async () => {
  const events = [];
  const body = between('app.whenReady().then(async () => {', '  // Boot migrations above').split('async () => {')[1];
  const run = new AsyncFunction("app", "process", "APP_ICON", "loadSecureCredentials", "secureComposioConfig", "secureWorkspaceConfig", "acquireDesktopDataOwner", "assertDesktopStartupActive", `${bootstrapDependencies} let secureCredentials; ${body}`);
  await run({isPackaged:false}, {platform:"linux"}, null, async()=>({}),
    async()=>events.push("migration"), async()=>events.push("migration"), ()=>events.push("lease"), ()=>{});
  assert.deepEqual(events, []);
});

test("packaged lease refusal prevents every credential read and migration", async () => {
  let accesses=0;
  const body=between('app.whenReady().then(async () => {','  // Boot migrations above').split('async () => {')[1];
  const run=new AsyncFunction("app","process","APP_ICON","loadSecureCredentials","secureComposioConfig","secureWorkspaceConfig","acquireDesktopDataOwner","assertDesktopStartupActive",`${bootstrapDependencies} let secureCredentials;${body}`);
  await assert.rejects(run({isPackaged:true,setAsDefaultProtocolClient(){}},{platform:"linux"},null,
    async()=>{accesses++;return{};},async()=>{accesses++;},async()=>{accesses++;},
    ()=>{throw new Error("installation busy");},()=>{}),/installation busy/);
  assert.equal(accesses,0);
});

test("bootstrap cannot resume migrations after shutdown during credential read",async()=>{
  const gate=deferred();let stopping=false,migrations=0;
  const body=between('app.whenReady().then(async () => {','  // Boot migrations above').split('async () => {')[1];
  const run=new AsyncFunction("app","process","APP_ICON","loadSecureCredentials","secureComposioConfig","secureWorkspaceConfig","acquireDesktopDataOwner","assertDesktopStartupActive",`${bootstrapDependencies} let secureCredentials;${body}`);
  const boot=run({isPackaged:true,setAsDefaultProtocolClient(){},getPath:()=>"/fixture/home"},{platform:"linux"},null,()=>gate.promise,
    async()=>{migrations++;},async()=>{migrations++;},()=>{},()=>{if(stopping)throw new Error("cancelled");});
  stopping=true;gate.resolve({});await assert.rejects(boot,/cancelled/);
  assert.equal(migrations,0);
});

for(const override of [undefined,"/explicit/installation"]) test(`actual packaged bootstrap migrates legacy only for original default (${override??"default"})`,async()=>{
  const events=[];
  const body=between('app.whenReady().then(async () => {','  // Boot migrations above').split('async () => {')[1];
  const scope={
    app:{isPackaged:true,setAsDefaultProtocolClient(){},getPath:()=>"/fixture/home"},process:{platform:"linux",env:override===undefined?{}:{MURAGE_DATA_DIR:override}},path,APP_ICON:null,
    assertDesktopStartupActive:()=>{},acquireDesktopDataOwner:()=>events.push("lease"),ownedDesktopDataDir:()=>"/canonical/owned",
    migrateLegacyDataDirectory:options=>{events.push(options);},assertRestoreReviewed:()=>{},configureRestoredDesktopConnections:()=>{},
    loadSecureCredentials:async()=>{events.push("read");return{};},secureComposioConfig:async()=>events.push("composio"),secureWorkspaceConfig:async()=>events.push("workspace"),
  };
  await new AsyncFunction(...Object.keys(scope),`let secureCredentials;${body}`)(...Object.values(scope));
  assert.deepEqual(events,["lease",{dataDir:"/canonical/owned",legacyDataDir:path.join("/fixture/home", ".opengrokbot"),enabled:override===undefined},"read","composio","workspace"]);
});

test("actual packaged migration failure never reaches credential/config reads",async()=>{
  let accessed=false;
  const body=between('app.whenReady().then(async () => {','  // Boot migrations above').split('async () => {')[1];
  const scope={
    app:{isPackaged:true,setAsDefaultProtocolClient(){},getPath:()=>"/fixture/home"},process:{platform:"linux",env:{}},path,APP_ICON:null,
    assertDesktopStartupActive:()=>{},acquireDesktopDataOwner:()=>{},ownedDesktopDataDir:()=>"/canonical/owned",
    migrateLegacyDataDirectory:()=>{throw new Error("migration refused");},assertRestoreReviewed:()=>{},configureRestoredDesktopConnections:()=>{},
    loadSecureCredentials:async()=>{accessed=true;return{};},secureComposioConfig:async()=>{accessed=true;},secureWorkspaceConfig:async()=>{accessed=true;},
  };
  await assert.rejects(new AsyncFunction(...Object.keys(scope),`let secureCredentials;${body}`)(...Object.values(scope)),/migration refused/);
  assert.equal(accessed,false);
});

test("packaged restore review blocks credential reads before and after legacy migration",async()=>{
  for(const blockAfterMigration of [false,true]) {
    let migrated=false,reads=0;
    const body=between('app.whenReady().then(async () => {','  // Boot migrations above').split('async () => {')[1];
    const scope={
      app:{isPackaged:true,setAsDefaultProtocolClient(){},getPath:()=>"/fixture/home"},process:{platform:"linux",env:{}},path,APP_ICON:null,
      assertDesktopStartupActive:()=>{},acquireDesktopDataOwner:()=>{},ownedDesktopDataDir:()=>"/canonical/owned",
      assertRestoreReviewed:()=>{if(!blockAfterMigration||migrated)throw new Error("review required");},
      migrateLegacyDataDirectory:()=>{migrated=true;},configureRestoredDesktopConnections:()=>{},
      loadSecureCredentials:async()=>{reads++;return{};},secureComposioConfig:async()=>{reads++;},secureWorkspaceConfig:async()=>{reads++;},
    };
    await assert.rejects(new AsyncFunction(...Object.keys(scope),`let secureCredentials;${body}`)(...Object.values(scope)),/review required/);
    assert.equal(reads,0);
    assert.equal(migrated,blockAfterMigration);
  }
});

test("both actual boot migrations read only the owner's canonical root",async()=>{
  const composio=between("async function secureComposioConfig() {","// The remaining workspace credentials");
  const workspace=between("async function secureWorkspaceConfig() {","function composioBrokerUrl()");
  const reads=[];
  const run=new AsyncFunction("path","fs",`
    const ownedDesktopDataDir=()=>"/fixture/canonical",slog=()=>{};
    const secureCredentials={},migrateWorkspaceCredentials=()=>({credentials:{},credentialsChanged:false,configChanged:false});
    ${composio}${workspace};await secureComposioConfig();await secureWorkspaceConfig();
  `.replace("const secureCredentials={}","let secureCredentials={}"));
  await run(path,{readFileSync:file=>{reads.push(file);return "{}";}});
  assert.deepEqual(reads,[path.join("/fixture/canonical", "config.json"),path.join("/fixture/canonical", "config.json")]);
});

test("actual bootstrap selects fresh connection storage after ownership and before credential reads", async () => {
  const body = between('app.whenReady().then(async () => {', '  // Boot migrations above').split('async () => {')[1];
  const configure = between("function configureRestoredDesktopConnections() {", "/** Set once per launch:");
  const events = [];
  let owned = false;
  const scope = {
    app:{isPackaged:true,setAsDefaultProtocolClient(){},getPath:()=>"/fixture/home"}, process:{platform:"linux",env:{}}, path, APP_ICON:null,
    acquireDesktopDataOwner:()=>{owned=true;events.push("lease");}, assertDesktopStartupActive:()=>{},
    ownedDesktopDataDir:()=>{assert.equal(owned,true);return"/fixture/owned";},
    restoredConnectionProfile:root=>{events.push(root);return{credentialsFile:"/fresh/credentials.bin",companionSettings:"/fresh/settings",companionState:"/fresh/devices"};},
    configureCompanionStorage:storage=>events.push(storage), assertRestoreReviewed:()=>{}, migrateLegacyDataDirectory:()=>{},
    secureComposioConfig:async()=>{},secureWorkspaceConfig:async()=>{},events,
  };
  const code = `let CREDENTIALS_FILE="/old/credentials.bin",restoredConnections=null,secureCredentials;
    ${configure}
    const loadSecureCredentials=async()=>{events.push(CREDENTIALS_FILE);return{};};
    ${body}`;
  await new AsyncFunction(...Object.keys(scope), code)(...Object.values(scope));
  assert.deepEqual(events, ["lease","/fixture/owned",{settingsDirectory:"/fresh/settings",stateDirectory:"/fresh/devices"},"/fresh/credentials.bin"]);
});

function serverLauncher({ proc, poll, track, environment = {} }) {
  const text = between("async function startServerOn(port) {", "async function startServerPackaged()");
  const owner = { utilityServerLeaseEnvironment:()=>({MURAGE_INTERNAL_DATA_DIR_LEASE:"private-fixture-capability"}) };
  const scope = {
    path, process:{env:environment,resourcesPath:"/fixture/resources"},restoredConnections:null,restoredHarnessEnvironment:env=>env,
    app:{isPackaged:true,getPath:()=>"/fixture/user-data"}, companionToken:"private-companion",
    modelProviderCommitToken:"private-model-provider-commit",
    secureCredentials:{},credentialStoreUnavailable:false,desktopSurfaceSecret:"",browserHost:null,
    managedComposioChildEnvironment:(_url,_keys,env)=>env, composioBrokerUrl:()=>null, fluxComposioBrokerUrlValue:()=>"", composioLegacyUntilValue:()=>"",
    harnessResourceEnvironment:()=>({}),workspaceCredentialEnv:()=>({}),slog:()=>{},
    utilityProcess:{fork:(_entry,_args,options)=>{proc.environment=options.env;return proc;}},
    receiveDesktopSurfaceSecret:()=>false,receiveBrowserControlHold:()=>false,receiveBrowserLifecycleCleanup:()=>false,syncBrowserConnection:()=>{},
    pollServerIdentity:poll,SERVER_BOOT_TIMEOUT_MS:25,
    desktopDataOwner:owner,desktopDataDir:"/canonical/installation",assertDesktopStartupActive:()=>{},desktopShutdownStarted:false,
    trackOwnedServerChild:(child)=>({exit:new Promise(()=>{}),...track(child)}),
  };
  return new Function(...Object.keys(scope), `${text};return startServerOn;`)(...Object.values(scope));
}

test("actual utility launch overrides ambient root/delegation only in the owned child", async () => {
  const proc = new EventEmitter();
  proc.pid=123;proc.kill=()=>{};
  const ambient={MURAGE_DATA_DIR:"relative-alias",MURAGE_INTERNAL_DATA_DIR_LEASE:"ambient-forged"};
  const launch=serverLauncher({proc,environment:ambient,poll:async()=>({outcome:"ready"}),track:()=>({exited:false,stop:async()=>{}})});
  await launch(8799);
  assert.equal(proc.environment.MURAGE_DATA_DIR,"/canonical/installation");
  assert.equal(proc.environment.MURAGE_INTERNAL_DATA_DIR_LEASE,"private-fixture-capability");
  assert.equal(proc.environment.MURAGE_MODEL_PROVIDER_COMMIT_TOKEN,"private-model-provider-commit");
  assert.deepEqual(ambient,{MURAGE_DATA_DIR:"relative-alias",MURAGE_INTERNAL_DATA_DIR_LEASE:"ambient-forged"});
});

test("failed boot cannot return for port fallback before exact child exit", async () => {
  const proc=new EventEmitter();proc.pid=123;
  const gate=deferred();let killed=false;
  proc.kill=()=>{killed=true;};
  const launch=serverLauncher({proc,poll:async()=>({outcome:"foreign-owner"}),track:()=>({exited:false,stop:async()=>{proc.kill();await gate.promise;}})});
  let returned=false;
  const result=launch(8799).then(value=>{returned=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));
  const prematurelyReturned=returned;
  gate.resolve();
  await result;
  assert.equal(killed,true);
  assert.equal(prematurelyReturned,false,"fallback must remain behind the child exit barrier");
});

test("actual canonical root resolver rejects empty override without acquiring or writing",()=>{
  const text=between("function acquireDesktopDataOwner() {","function trackOwnedServerChild(proc)");
  let claims=0;
  const run=new Function("process","path","app","dataDirLeasePaths","acquireDataDirLease",`
    let desktopDataDir=null,desktopDataOwner=null;
    const assertDesktopStartupActive=()=>{};
    ${text};acquireDesktopDataOwner();return ownedDesktopDataDir();
  `);
  assert.throws(()=>run({env:{MURAGE_DATA_DIR:""}},path,{isPackaged:true,getPath:()=>"/unused"},dataDirLeasePaths,()=>{claims++;}),
    error=>error.code==="INVALID_DATA_DIR");
  assert.equal(claims,0);
});

function shutdownFixture({stop=async()=>{},writes=[],cleanups=[],startup=Promise.resolve(),cua=async()=>{},release=()=>true,managedComposioShutdown=new AbortController()}={}) {
  const text=source.slice(source.indexOf("function cleanupDesktopForExit() {"));
  const messages=[];let quit=0;let trigger;
  const scope={
    app:{on:(_event,handler)=>{trigger=handler;},quit:()=>{quit++;}},
    syncCompanionKeepAwake:()=>{},nativeActions:{appleSpeech:false},stopSpeech:()=>{},stopRecorder:()=>{},browserSurface:null,
    stopDesktopCompanion:async()=>{},browserHost:null,browserLifecycleCleanups:new Map(cleanups.map((work,index)=>[index,work])),stopCua:cua,cuaReady:Promise.resolve(),
    slog:()=>{},dialog:{showErrorBox:(_title,body)=>messages.push(body)},
    awaitOwnedWork:(promise,label,timeout)=>awaitOwnedWork(promise,label,Math.min(timeout??25,25)),
    desktopStartup:startup,
    managedComposioShutdown,
  };
  const state=new Function(...Object.keys(scope),"stop","writes","release",`
    let desktopShutdownStarted=false,cuaCleanedUp=false,desktopCleanup=null,desktopCleanupStage="owned harness";
    let desktopDataOwner={release};const CUA_STOP_TIMEOUT_MS=25;
    const ownedServerChildren=new Set([{stop}]),credentialWrites=new Set(writes),companionStarts=new Set();
    ${text};return {cleanupWithoutQuit:cleanupDesktopForExit,get cleanup(){return desktopCleanup;},get owned(){return Boolean(desktopDataOwner);}};
  `)(...Object.values(scope),stop,writes,release);
  return {state,messages,quit:()=>quit,trigger:()=>trigger({preventDefault(){}})};
}

test("actual before-quit waits for child exit AND pending credentials before releasing",async()=>{
  const child=deferred(),write=deferred();let released=0;
  const f=shutdownFixture({stop:()=>child.promise,writes:[write.promise],release:()=>{released++;return true;}});
  f.trigger();await new Promise(resolve=>setImmediate(resolve));assert.equal(released,0);
  child.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(released,0);
  write.resolve();await f.state.cleanup;
  assert.equal(released,1);assert.equal(f.quit(),1);assert.equal(f.state.owned,false);
});

// R2-T5 changed intended behavior: an aborted registration that derives an
// unchanged document no longer writes at all. The drain barrier is exercised
// with the case that still must write, a definitive 401 invalidation whose
// replacement registration is stalled when quit begins.
test("actual quit cancels stalled optional registration but drains its credential write", async () => {
  const controller = new AbortController();
  const requested = deferred(), persist = deferred();
  let requestAborted = false, released = 0;
  const credentials = createSecureCredentialState({ composioBrokerToken: "a".repeat(64), composioInstallationId: "revoked" }, () => persist.promise);
  const writes = [];
  const scope = {
    app: { isPackaged: true }, composioBrokerUrl: () => "http://127.0.0.1:12345", fluxComposioBrokerUrlValue: () => "", fluxComposioLifecycleEnabled: () => false,
    credentialStoreUnavailable: false, desktopShutdownStarted: false,
    managedComposioShutdown: controller, slog() {}, syncManagedComposioCredentials() {},
    MANAGED_COMPOSIO_UPDATE_OPTIONS,
    updateSecureCredentialDocument: (derive, afterPersist, options) => {
      const write = credentials.update(derive, afterPersist, options);
      writes.push(write);
      return write;
    },
    deriveManagedComposioCredentials: (options) => deriveManagedComposioCredentials({
      ...options,
      fetchImpl: (url, { signal }) => url.endsWith("/v1/me") ? Promise.resolve({ ok: false, status: 401 }) : new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { requestAborted = true; reject(signal.reason); }, { once: true });
        requested.resolve();
      }),
    }),
  };
  new Function(...Object.keys(scope), between('  if (app.isPackaged && composioBrokerUrl() && !credentialStoreUnavailable) {', '  // in-app auto-update'))(...Object.values(scope));
  await requested.promise;
  const f = shutdownFixture({ writes, managedComposioShutdown: controller, release: () => { released++; } });
  f.trigger();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requestAborted, true, "quit must cancel the pending HTTP request");
  assert.equal(released, 0, "cancelling HTTP must not skip persistent write settlement");
  persist.resolve();
  await f.state.cleanup;
  assert.equal(released, 1);
  assert.equal(f.quit(), 1);
  assert.deepEqual(f.messages, []);
});

test("actual before-quit retains ownership until admitted browser cleanup settles", async () => {
  const gate = deferred(); let released = 0;
  const f = shutdownFixture({ cleanups: [gate.promise], release: () => { released++; return true; } });
  f.trigger(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 0);
  gate.resolve(); await f.state.cleanup;
  assert.equal(released, 1);
});

test("actual private browser cleanup admission closes during recovery and shutdown", async () => {
  const body = between("function receiveBrowserLifecycleCleanup(", "async function startServerOn(");
  for (const [recovery, shutdown, expected] of [[false,false,1],[true,false,0],[false,true,0]]) {
    let actions = 0, acknowledgements = 0;
    const scope = { desktopRecoveryMode: recovery, desktopShutdownStarted: shutdown,
      decodeBrowserLifecycleMessage:()=>({type:"bot-deleted",botId:"fixture",requestId:"request"}),
      browserLifecycleCleanups:new Map(),completedBrowserLifecycleCleanups:new Set(),
      applyBrowserLifecycleCleanup:async()=>{actions++;return true;},rememberBrowserLifecycleCleanup:()=>{},browserLifecycleResult:()=>({}),slog:()=>{} };
    const receive = new Function(...Object.keys(scope), body + ";return receiveBrowserLifecycleCleanup;")(...Object.values(scope));
    receive({postMessage(){acknowledgements++;}}, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(actions, expected);
    assert.equal(acknowledgements, expected);
  }
});

for (const held of ["child", "credential"]) test(`actual before-quit ${held} barrier independently blocks release`,async()=>{
  const gate=deferred();let released=0;
  const f=shutdownFixture({
    ...(held==="child"?{stop:()=>gate.promise}:{writes:[gate.promise]}),
    release:()=>{released++;return true;},
  });
  f.trigger();await new Promise(resolve=>setImmediate(resolve));
  const premature=released;
  gate.resolve();await f.state.cleanup;
  assert.equal(premature,0,`${held} must independently keep installation ownership`);
  assert.equal(released,1);
});

test("actual before-quit timeout retains lease, names blocker and permits retry",async()=>{
  let blocked=true,released=0;
  const f=shutdownFixture({stop:()=>blocked?new Promise(()=>{}):Promise.resolve(),release:()=>{released++;return true;}});
  f.trigger();await assert.rejects(f.state.cleanup);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(released,0);assert.equal(f.state.owned,true);assert.equal(f.quit(),0);
  assert.match(f.messages[0],/owned harness/);
  blocked=false;f.trigger();await f.state.cleanup;
  assert.equal(released,1);assert.equal(f.quit(),1);
});

test("actual before-quit CUA deadline is not clean lease release",async()=>{
  let released=0;
  const f=shutdownFixture({cua:()=>new Promise(()=>{}),release:()=>{released++;return true;}});
  f.trigger();await assert.rejects(f.state.cleanup);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(released,0);assert.match(f.messages[0],/computer-use/);
});

test("actual credential mutation barrier rejects new work but waits for admitted rollback",async()=>{
  const text=between("export async function updateSecureCredentialDocument(","function publicManagedCompanionState()").replace("export ","");
  const gate=deferred();let calls=0;
  const make=new Function("gate","trackedCredentialUpdate",`
    let desktopShutdownStarted=false,secureCredentials={};
    const app={isPackaged:true};
    const credentialWrites=new Set();
    const assertDesktopStartupActive=()=>{if(desktopShutdownStarted)throw new Error("shutdown");};
    const ownedDesktopDataDir=()=>"fixture";
    const secureCredentialState={update:()=>gate.promise,read:()=>({})};
    ${text};return {write:updateSecureCredentialDocument,close:()=>{desktopShutdownStarted=true;},pending:()=>credentialWrites.size};
  `);
  const f=make(gate,trackedCredentialUpdate);const admitted=f.write(()=>{calls++;});assert.equal(f.pending(),1);
  f.close();await assert.rejects(f.write(()=>{calls++;}),/shutdown/);
  assert.equal(f.pending(),1);gate.resolve();await admitted;assert.equal(f.pending(),0);
  assert.equal(calls,0);
});

test("actual companion startup cannot fork after shutdown during HTTPS observation",async()=>{
  const text=between("async function startDesktopCompanion(","/** Re-probe Tailscale");
  const gate=deferred();let stopping=false,forks=0;
  const scope={
    companionStarts:new Set(),assertDesktopStartupActive:()=>{if(stopping)throw new Error("cancelled");},
    refreshRemoteAccessObservation:()=>gate.promise,startCompanion:async()=>{forks++;return {enabled:true};},
    companionLaunchOptions:()=>({}),rememberCompanionEnabled:()=>{},startManagedCompanionConnection:async()=>{},desktopCompanionState:async()=>({}),
  };
  const launch=new Function(...Object.keys(scope),`let companionDesiredThisLaunch=false,companionLaunchGeneration=0;${text};return startDesktopCompanion;`)(...Object.values(scope));
  const pending=launch();stopping=true;gate.resolve();await assert.rejects(pending,/cancelled/);
  assert.equal(forks,0);assert.equal(scope.companionStarts.size,0);
});

test("actual startup rejection is handled visibly without echoing arbitrary private details",async()=>{
  const text=between("void desktopStartup.catch((error) => {",'app.on("window-all-closed"');
  const visible=[],logs=[];let quits=0;
  const scope={desktopStartup:Promise.reject(new Error("private supplied credential")),desktopShutdownStarted:false,
    slog:line=>logs.push(line),dialog:{showErrorBox:(...args)=>visible.push(args)},app:{quit:()=>{quits++;}}};
  await new Function(...Object.keys(scope),`${text};return desktopStartup.catch(()=>{});`)(...Object.values(scope));
  assert.equal(quits,1);assert.equal(visible.length,1);
  assert.doesNotMatch(JSON.stringify([visible,logs]),/private supplied credential/);
});


test("updater cleanup awaits the actual owned barriers without quitting early", async () => {
  const child=deferred(),write=deferred();let released=0;
  const f=shutdownFixture({stop:()=>child.promise,writes:[write.promise],release:()=>{released++;return true;}});
  const cleanup=f.state.cleanupWithoutQuit();
  assert.equal(f.state.cleanupWithoutQuit(),cleanup);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(released,0);assert.equal(f.quit(),0);
  child.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(released,0);
  write.resolve();await cleanup;
  assert.equal(released,1);assert.equal(f.state.owned,false);assert.equal(f.quit(),0);
});
