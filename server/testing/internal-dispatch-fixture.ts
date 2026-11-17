// SPDX-License-Identifier: AGPL-3.0-or-later
// Setup only: no beforeEach, database closure, data-root deletion or live app import.
import { expect, vi } from "vitest";
import { protectPort } from "./port-integrity.ts";
import * as databaseApi from "../database.ts";
import * as decision from "../decision/index.ts";
import { Store, type BotRecord } from "../store.ts";

import { scopedTx } from "../tx-scope.ts";
import { reconcileMemoryRoster } from "../memory/policy.ts";
import { prepareRecallContextSync } from "../memory/recall-view.ts";
import { dirname, join } from "node:path";

import { fileOutsideStore } from "../outside-store.ts";

import { wireOutsideStore, restartOutsideForTests } from "../email/external-marks.ts";
import type { InternalCapabilities } from "../internal-capabilities.ts";
import type { consumingFixture } from "./consuming-fixture.ts";

import { executionStore, setExecutionStore } from "../execution-audience.ts";

import type { RoutineRequestService } from "../routine-requests.ts";

// Owner: sc-safety-rd (source fixture); index authority owners retain policy.
import { extractFunction } from "./source-extract.ts";
import { freshIndexPorts, initializeInternalFixtureDatabase } from "./index-ports.ts";
import { CASE_PORTS, checkCasePort, resolveCaseDeclaration, overrideRefused } from "./case-ports.ts";
import { withinPortScope, assertPortsPristine } from "./port-integrity.ts";
import { checkInternalDispatchRoutines, stopInternalDispatchRoutines, answerInternalFixtureOwnWrite, installInternalFixtureProducers, prepareInternalFixtureEngine, prepareInternalFixtureComputer, attachInternalFixtureRequest, stopInternalFixtureOwnWrite, prepareInternalFixtureActivity, holdInternalFixtureMcpConfiguration, prepareInternalFixtureBox, retainInternalFixtureLineage, closeWithInternalFixture, bindInternalDispatch, type FixtureObservers, type BoundInternalDispatch, type InternalAdmission } from "./internal-authority-fixture.ts";

let indexCallbackSource: import("typescript").SourceFile | undefined;
const dispatchSetups=new WeakSet<object>();
export function isDispatchAuthoritySetup(value:object):boolean{return dispatchSetups.has(value);}
export async function indexCallbackFixture(name: string, scope: Record<string, unknown>): Promise<any> {
  const ts = (await import("typescript")).default;
  const { readFileSync } = await import("node:fs");
  const source = indexCallbackSource ??= ts.createSourceFile("index.ts",readFileSync(new URL("../index.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true);
  let callback = "";
  const walk = (node: import("typescript").Node): void => {
    if (name.startsWith("projectToolHandlers.set:") && ts.isCallExpression(node) && node.expression.getText(source) === "projectToolHandlers.set"
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name.slice("projectToolHandlers.set:".length)) callback = node.arguments[1]!.getText(source);
    if (ts.isCallExpression(node) && node.expression.getText(source) === name && node.arguments[0]
      && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]) || ts.isObjectLiteralExpression(node.arguments[0]))) callback = node.arguments[0].getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) callback = node.initializer.getText(source);
    ts.forEachChild(node,walk);
  };
  walk(source);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (declaration) callback = declaration.getText(source);
  expect(callback, `production callback ${name}`).not.toBe("");
  return completeIndexCallbackFixture(callback,{...scope},source);
}

/** A callback reaching runtime services shares the dispatcher's complete real
 * state registry. Unknown dependencies still fail preflight before invocation. */
export async function completeIndexCallbackFixture(callback:string,scope:Record<string,unknown>,source:import("typescript").SourceFile):Promise<any>{
  if (Object.hasOwn(scope,"json")) {
    const actual = extractFunction({file:new URL("../index.ts",import.meta.url),text:source.text,select:()=>"() => {}"}).source;
    throw overrideRefused("json",resolveCaseDeclaration(actual,"json"),actual);
  }
  const {ensureDirs}=await import("../config.ts");ensureDirs();
  if(!scope.dispatchAuthoritySetup && !Object.hasOwn(scope,"fixtureObservers") && !["imageService","imageOperations","publishOperations","highlevel","routines","webhooks","chiefProposals","toolResults"].some(name=>Object.hasOwn(scope,name))) {

    const extracted=extractFunction({file:new URL("../index.ts",import.meta.url),text:source.text,select:()=>callback});
    const canonical={...scope},ports=freshIndexPorts();
    try{return (await extracted.preflight(canonical,{ports:ports.filter(port=>!Object.hasOwn(canonical,port.name))})).value;}
    catch(error){if(!(error instanceof Error)||!error.message.startsWith("FIXTURE_SCOPE_UNRESOLVED"))throw error;}
    scope=canonical;
  }
  const ts=(await import("typescript")).default;
  const canonical=source.statements.flatMap(statement=>ts.isFunctionDeclaration(statement)&&statement.name&&statement.getText(source)===callback?[statement.name.text]
    :ts.isVariableStatement(statement)?statement.declarationList.declarations.flatMap(declaration=>ts.isIdentifier(declaration.name)&&declaration.initializer?.getText(source)===callback?[declaration.name.text]:[]):[]);
  if(canonical.length===1) {
    const unit=await bindInternalDispatch({expression:"async () => {}",scope,source,expose:canonical});
    return unit.unit[canonical[0]];
  }
  const unit=await bindInternalDispatch({expression:`async () => (${callback})`,scope,source});
  return unit.dispatch();
}

/** Both entry points use the shared preflight and actual authority unit. */
export async function internalDispatchFixture(catchErrors = false) {
  const ts = (await import("typescript")).default;
  const { readFileSync } = await import("node:fs");
  const source = ts.createSourceFile("index.ts",readFileSync(new URL("../index.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true);
  let branch = "", json = "", localJson = "", boundaryCatch = "";
  const helpers: string[] = [], admission = new Map<string,string>();
  const walk = (node: import("typescript").Node): void => {
    if (ts.isVariableDeclaration(node) && ["consumingRequest","requestClaim","requestBinding"].includes(node.name.getText(source))) admission.set(node.name.getText(source),`const ${node.getText(source)};`);
    if (ts.isIfStatement(node) && node.expression.getText(source) === 'path.startsWith("/api/internal/")') branch = node.thenStatement.getText(source);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "json") json = node.getText(source);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "localJson") localJson = node.getText(source);
    if (ts.isFunctionDeclaration(node) && ["serveVenuePost","serveShareAsk","toolJson","indexService","applyIndexVenuePost","currentConnectedAccessAccounts"].includes(node.name?.text ?? "")) helpers.push(node.getText(source));
    if (ts.isCatchClause(node) && node.variableDeclaration?.name.getText(source) === "e" && node.getText(source).includes("coordinationRefusalText(e)")) boundaryCatch = node.getText(source);
    ts.forEachChild(node,walk);
  };
  walk(source);
  expect(branch.length).toBeGreaterThan(0); expect(json.length).toBeGreaterThan(0);
  expect(branch.includes("res = consumingHttpWriter(originalResponse, responseBinding,"), "the real internal dispatcher must replace its raw response before invoking a consuming producer").toBe(true);
  if (catchErrors) expect(boundaryCatch.includes("coordinationRefusalText(e)")).toBe(true);
  expect(admission.size).toBe(3);
  const expression = `async () => { ${[...admission.values()].join("\n")} ${json} ${localJson} ${helpers.join("\n")} ${catchErrors ? `try ${branch} ${boundaryCatch}` : branch} }`;
  const dispatch = async (scope: Record<string,unknown>) => {
    const setup = scope.dispatchAuthoritySetup as DispatchAuthoritySetup | undefined;
    if(setup&&!isDispatchAuthoritySetup(setup))throw new Error("FIXTURE_OVERRIDE_REFUSED dispatchAuthoritySetup: real fixture setup required");
    const run = async () => {
      const {dispatch,bound,free} = await bindInternalDispatch({expression,scope,source});
      let missing = 0, missingIndex = -1, missingName = "";
      for (const [name,resolution] of free) if (!Object.hasOwn(bound,name) && resolution.step !== "declaration") Object.defineProperty(bound,name,{
        get() { missing++; missingName=name; missingIndex=[...free.keys()].indexOf(name); throw new Error(`dispatch dependency missing index=${missingIndex} count=${free.size}`); },
      });
      try { return await dispatch(); }
      finally { expect(missing, `dispatch missing dependencies name=${missingName} count index=${missingIndex} total=${free.size}`).toBe(0); }
    };
    return setup ? setup.run(run) : run();
  };
  // Construction-only diagnostics use the identical complete production
  // branch and admissions. They never replace it with a synthetic handler.
  return Object.assign(dispatch, {
    code: expression,
    preflight: (scope: Record<string,unknown>) => bindInternalDispatch({expression,scope,source}),
  });
}

// Connect the ordinary SQL transaction port to the caller-owned fixture DB.
// The final-write releaseTransaction implementation continues to own releases.
let savepoint = 0;
function fixtureTransaction<T>(db: import('node:sqlite').DatabaseSync, work: (db: import('node:sqlite').DatabaseSync) => T): T {
  return scopedTx(() => {
    const name = `dispatch_setup_${++savepoint}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = work(db); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
  });
}

/** I/O scopes may nest during registration, thread preparation and request
 * execution. Restoring a child must retain the parent installation. */
function fixtureDatabaseIo(db: import("node:sqlite").DatabaseSync): () => void {
  const hadDatabase = vi.isMockFunction(databaseApi.database), hadTransaction = vi.isMockFunction(databaseApi.transaction);
  const databaseIo = vi.spyOn(databaseApi, "database"), transactionIo = vi.spyOn(databaseApi, "transaction");
  const previousDatabase = databaseIo.getMockImplementation(), previousTransaction = transactionIo.getMockImplementation();
  databaseIo.mockReturnValue(db);
  transactionIo.mockImplementation(work => fixtureTransaction(db, work));
  return () => {
    if (hadTransaction) transactionIo.mockImplementation(previousTransaction!); else transactionIo.mockRestore();
    if (hadDatabase) databaseIo.mockImplementation(previousDatabase!); else databaseIo.mockRestore();
  };
}

interface DispatchAuthoritySetup {
  readonly priorHelp: ReturnType<typeof prepareInternalFixtureActivity>;
  approveOwnerWrite():Promise<void>;
  retain: typeof retainInternalFixtureLineage extends (binding: any, ...args: infer Args) => any ? (...args: Args) => Promise<void> : never;
  run<T>(work: () => Promise<T>): Promise<T>;
  bind(expression:string,scope:Record<string,unknown>,source?:import("typescript").SourceFile,expose?:string[]):Promise<BoundInternalDispatch>;
}

/** Admission is explicit test setup, separate from the capability. Never infer
 * the sender from thread ownership or let a capability mint owner provenance.
 * All persistence during dispatch uses the consuming fixture's own SQLite DB.
 */
export async function internalDispatchAuthorityFixture(
  f: ReturnType<typeof consumingFixture>, capabilities: InternalCapabilities,
  options: { provider?: { driver: import("../contracts.ts").AnyProviderDriver; configs: import("../contracts.ts").InstanceConfigMap }; box?:{id:string;fetch?:typeof fetch}; mcpConfigurationBusy?:boolean; revoke?: boolean; unattended?: boolean; voiceQuotaExhausted?: boolean; initiator?: decision.TurnProvenance['initiator']; roomOwnerOnly?: boolean;
    routineRequests?: Pick<RoutineRequestService, 'pendingApprovals'>;
    settings?: Partial<BotRecord>; provenance?: boolean; generation?: string;
    config?:Record<string,unknown>;store?:Store; observers?:FixtureObservers;computer?:{hostComputer:import("../host-computer-broker.ts").HostComputerBroker;unifiedBrowser:import("../browser-control.ts").UnifiedBrowserController;connection:import("../host-computer-broker.ts").HostComputerSpec;mode:"host"|"browser"|"legacy";io?:{agentBrowserIntegration:typeof import("../browser-engine.ts").agentBrowserIntegration;settledBrowserEngineStatus:typeof import("../browser-engine.ts").settledBrowserEngineStatus;verifyAgentBrowserBinary:typeof import("../browser-engine.ts").verifyAgentBrowserBinary}};phone?:{phoneRegistryOnce:import("../phones/registry.ts").PhoneRegistry;phoneAuthorities:import("../phones/authority.ts").PhoneAuthorities;phoneJobs:import("../phones/jobs.ts").PhoneJobs};
    requestId?:string;activityStallMs?:number;computerHelp?:string;engine?:{profile:import("./internal-authority-fixture.ts").FixtureEngineProfile;model:string};
    messages?:Array<{threadId:string;message:Omit<import("../store.ts").Message,"id"|"at">;id:string}>;
    ownerBotApproval?: { tool: string; input: Record<string, unknown> } } = {},
) {
  return withinPortScope(async()=>{
  assertPortsPristine();
  // Imported principal readers and production registration writers share this
  // installation during assembly as well as request execution. A bound person
  // must never fall back to the worker installation's unbound owner default.
  const closeAssemblyIo = fixtureDatabaseIo(f.f.db);
  try {
  const { botId, threadId, dispatchGeneration: generation } = f.binding.identity;
  initializeInternalFixtureDatabase(f.f.db);
  const dbFile = String(f.f.db.prepare('PRAGMA database_list').get()!.file);
  expect(dbFile, 'dispatch setup requires the consuming fixture database file').not.toBe('');
  const directory=dirname(dbFile);
  // Each consuming database is a separate isolated installation, including its
  // outside journal. Initialize it before any real authority/attribution writer.
  restartOutsideForTests();
  expect(wireOutsideStore(fileOutsideStore(join(directory, "outside-state.jsonl")))).toBe(true);
  const ambientStore=executionStore();
  let store:Store;
  try {
    if(options.store)checkCasePort(CASE_PORTS.find(port=>port.category==="DATA"&&port.declaration.exportName==="store")!,options.store,undefined,()=>new Error("FIXTURE_OVERRIDE_REFUSED store"));
    store=options.store??new Store(undefined,undefined,true);
    if(!options.store){store.bots=[];store.groups=[];}
  }
  finally { setExecutionStore(ambientStore); }
  const existing=store.bot(botId),task=existing?.tasks?.find(task=>task.threadId===threadId);
  const bot = {
    name:'Authenticated dispatch fixture',title:'Fixture',description:'',notifications:false,color:'blue',unread:false,resumeCursors:{},createdAt:1,
    autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true,
    modelSelection:{instanceId:'fixture',model:'fixture'},
    ...existing,...options.settings,id:botId,threadId,
    tasks:[...(existing?.tasks?.filter(task=>task.threadId!==threadId)??[]),{threadId,title:'Fixture',createdAt:1,resumeCursors:{},...task,...options.settings,pinned:options.settings?.pinned ? true as const : undefined}],
  } satisfies BotRecord;
  store.bots=[bot,...store.bots.filter(bot=>bot.id!==botId)];
  // These are SQLite I/O ports. All policy/roster methods come from Store.
  store.patchMessage = (thread,id,patch) => {
    const row=f.f.db.prepare('SELECT json FROM messages WHERE thread_id=? AND id=?').get(thread,id);
    if(!row)throw new Error('dispatch fixture approval message missing');
    const updated={...JSON.parse(String(row.json)),...patch};
    f.f.db.prepare('UPDATE messages SET json=? WHERE thread_id=? AND id=?').run(JSON.stringify(updated),thread,id);
    return updated;
  };
  store.scanNewest = (thread,visit) => {
    for(const row of f.f.db.prepare('SELECT json FROM messages WHERE thread_id=? ORDER BY at DESC').all(thread))if(visit(JSON.parse(String(row.json))))return true;
    return false;
  };
  for(const seed of options.messages??[])store.appendMessage(seed.threadId,seed.message,seed.id);
  const threads=new Set([threadId,...(options.messages??[]).map(seed=>seed.threadId)]);
  for(const thread of threads)await store.prepareThread(thread);
  const environment:Record<string,any>={
    ...(options.observers?{fixtureObservers:options.observers}:{}),
    ...(options.config?{cfg:options.config}:{}),
    ...options.phone,...(options.computer?{hostComputer:options.computer.hostComputer,unifiedBrowser:options.computer.unifiedBrowser}:{}),store,internalCapabilities:capabilities,
    database:()=>f.f.db,transaction:<T>(work:(db:typeof f.f.db)=>T)=>fixtureTransaction(f.f.db,work),
  };

  const expose=['connectorThread','botForDirectThread','peerContactSettings','decisionNoLimitsOrigin','decisionLiveLevel',
    'ownLaneTurn','ownPermissionFacts','verifyDecisionClaim','inheritedBotPermissionLevel','botEffectiveState','botWriteDecision',
    'projectGroupForThread','highlevelConnectionActive','issueDecisionAuthority','retainInternalResponseBinding','markUnattended'];
  const admission:InternalAdmission={botId,threadId,generation,provenanceGeneration:options.generation,
    initiator:options.initiator??{k:'owner-typed'},roomOwnerOnly:options.roomOwnerOnly??true,provenance:options.provenance!==false};
  const registered=await bindInternalDispatch({expression:'async () => {}',scope:environment,admission,preserveCapabilities:true,expose,boxFetch:options.box?.fetch,provider:options.provider});
  checkInternalDispatchRoutines(registered);
  const priorHelp=prepareInternalFixtureActivity(registered,{botId,threadId,generation},options.activityStallMs,options.computerHelp);
  if(options.requestId)await attachInternalFixtureRequest(registered,{botId,threadId,generation},options.requestId);
  if(options.computer)await prepareInternalFixtureComputer(registered,{botId,threadId,generation},options.computer.mode,options.computer.connection,options.computer.io);
  if(options.engine)await prepareInternalFixtureEngine(registered,{botId,threadId,generation},options.engine.profile,options.engine.model);

  if(options.mcpConfigurationBusy)await holdInternalFixtureMcpConfiguration(registered,{botId,threadId,generation});
  if(options.unattended)registered.unit.markUnattended(threadId);
  if(options.voiceQuotaExhausted) {
    const {admitVoiceNote,VOICE_NOTES_PER_TURN}=await import("../voice/voice-notes.ts");
    for(let n=0;n<VOICE_NOTES_PER_TURN;n++)if(!admitVoiceNote(`${threadId}:${generation}`))throw new Error("FIXTURE_VOICE_QUOTA_ALREADY_USED");
  }
  if (admission.provenance) registered.unit.retainInternalResponseBinding(generation, f.binding);
  const issueDecisionAuthority=registered.unit.issueDecisionAuthority;
  const provenance=registered.unit.makeDecisionProvenance(botId,threadId,options.generation??generation,admission.initiator,admission.roomOwnerOnly);

  if (options.ownerBotApproval) {
    expect(options.provenance !== false && provenance.generation === generation && provenance.roomOwnerOnly && provenance.initiator.k === 'owner-typed',
      'only an authenticated fixture owner can approve a bot change').toBe(true);
  }
  let ownerRouteReady:()=>void=()=>{};
  const ownerReadiness=new Promise<void>(resolve=>{ownerRouteReady=resolve;});
  let failOwnerAction:(error:unknown)=>void=()=>{};
  const ownerActionFailure=new Promise<never>((_resolve,reject)=>{failOwnerAction=reject;});
  void ownerActionFailure.catch(()=>{});
  let dispatching=false;
  const dispatchAuthoritySetup: DispatchAuthoritySetup = {
    priorHelp,
    async approveOwnerWrite() {
      try {
      const expected=options.ownerBotApproval;if(!expected)throw new Error("FIXTURE_OWNER_ACTION_NOT_REQUESTED");
      await ownerReadiness;
      const deadline=Date.now()+5_000;
      while(Date.now()<deadline) {
        const rows=f.f.db.prepare("SELECT hold_id,revision,body FROM own_write_holds WHERE bot_id=? AND thread_id=? AND generation=? AND tool=? AND state='waiting'").all(botId,threadId,generation,expected.tool);
        for(const row of rows) {
          const body=JSON.parse(String(row.body));
          if(!Object.entries(expected.input).every(([key,value])=>JSON.stringify(body[key])===JSON.stringify(value)))throw new Error("FIXTURE_OWNER_OPERATION_CHANGED");
          await answerInternalFixtureOwnWrite(registered,`own-${row.hold_id}`,Number(row.revision));return;
        }
        await new Promise(done=>setTimeout(done,5));
      }
      throw new Error("FIXTURE_OWNER_CARD_NOT_RAISED");
      } catch(error) { failOwnerAction(error);stopInternalFixtureOwnWrite(registered,threadId,generation);throw error; }
    },
    retain: (...args) => retainInternalFixtureLineage(registered, ...args),
    async bind(expression,scope,source,requested=[]) {
      // The actual recall admission caches a view by the exact roster identity.
      // Use the producer's explicit structural/fixture preparation under real
      // SQLite I/O before issuing access; live request code keeps its async API.
      if(dispatching&&typeof scope.path==="string"&&scope.path.startsWith("/api/internal/memory/")) {
        const authorization=(scope.req as {headers?:{authorization?:string}}|undefined)?.headers?.authorization;
        const claim=protectPort(capabilities).resolve(authorization);
        if(claim?.kind==="memory")prepareRecallContextSync(claim.botId,claim.threadId,protectPort(store),claim.notOwnerAudience===true);
      }
      const unit=await bindInternalDispatch({expression,scope:{...environment,...scope},source,parent:registered,expose:[...new Set([...expose,...requested])]});
      ownerRouteReady();return unit;
    },
    async run(work) {
      const previousStore = executionStore();
      const previousCloudRole=process.env.MURAGE_CLOUD_ROLE;
      if(options.box)process.env.MURAGE_CLOUD_ROLE="home";
      setExecutionStore(store);
      const closeRequestIo = fixtureDatabaseIo(f.f.db);
      const closeHost = decision.installDecisionHost({ store, view: () => ({ title: 'Fixture', subtitle: 'Dispatch' }) });
      decision.installProvenanceReader(registered.unit.reader);
      decision.installDenySources(registered.unit.denials);
      let closeProducers:()=>void=()=>{};
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;dispatching=false;
        const failures:unknown[]=[];
        for(const restore of [()=>stopInternalDispatchRoutines(registered),closeProducers,closeHost,closeRequestIo,()=>setExecutionStore(previousStore),()=>{if(options.box){if(previousCloudRole===undefined)delete process.env.MURAGE_CLOUD_ROLE;else process.env.MURAGE_CLOUD_ROLE=previousCloudRole;}}]) {
          try {restore();}catch(error){failures.push(error);}
        }
        if(failures.length)throw new AggregateError(failures,"FIXTURE_IO_CLEANUP_FAILED");
      };
      // afterEach also restores the exact fixture's I/O if a pending product
      // operation outlives the test deadline. A closed DB never becomes the next case's global port.
      closeWithInternalFixture(close);
      try {
        closeProducers=installInternalFixtureProducers(registered);
        expect(wireOutsideStore(fileOutsideStore(join(directory, "outside-state.jsonl")))).toBe(true);
        reconcileMemoryRoster(store);
        if(options.box)await prepareInternalFixtureBox(registered,{botId,threadId,generation},options.box.id);
        if (options.revoke) f.flip();
        dispatching=true;
        return await Promise.race([work(),ownerActionFailure]);
      } finally { stopInternalFixtureOwnWrite(registered,threadId,generation);close(); }
    },
  };
  Object.freeze(dispatchAuthoritySetup);dispatchSetups.add(dispatchAuthoritySetup);

  const scope=Object.freeze({dispatchAuthoritySetup,store,...(options.observers?{fixtureObservers:options.observers}:{}),
    database:environment.database,transaction:environment.transaction});
  return {scope,dispatchAuthoritySetup,store,issueDecisionAuthority,ownLaneTurn:registered.unit.ownLaneTurn,priorHelp};
  } finally {
    closeAssemblyIo();
  }
  });
}
