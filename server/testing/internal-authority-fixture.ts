// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: sc-safety fixture binding; index.ts owns every authority writer/reader.
import ts from "typescript";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFunction, currentSourceText, preloadDeclarationAnalysis, preloadStatePortAdmission, type Resolution, type StatePort } from "./source-extract.ts";
import { freshIndexPorts } from "./index-ports.ts";
import { assertPortsPristine, registerPortConstructor, observePort, trackPort, withinPortScope } from "./port-integrity.ts";
import { CASE_PORTS, checkCasePort, casePortFor, resolveCaseDeclaration, overrideRefused } from "./case-ports.ts";
import { Store, type BotRecord, type GroupRecord } from "../store.ts";
import { InternalCapabilities, requiredInternalKind } from "../internal-capabilities.ts";
import { BotOutsideWrites } from "../bot-outside-writes.ts";
import { CoordinationBudget } from "../coordination-budget.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { RoutineManager } from "../routines.ts";
import { IndependentThreadRuns } from "../independent-thread-runs.ts";
import { createTurnAttribution } from "../turn-attribution.ts";
import { CallSpeechCoordinator } from "../tts/call-coordinator.ts";
import { callSourceVisible } from "../voice/call-access.ts";
import { turnOutsideRead } from "../email/external-marks.ts";
import { installProducerBindings, installClaimVerifier, installProvenanceReader, installDenySources, type ProvenanceReader, type Initiator } from "../decision/index.ts";
import { removeTempDir } from "./cleanup.ts";

import { configureBotEgress } from "../bot-egress.ts";
import { database } from "../database.ts";
import { initializeTeamIdentityTables } from "../team-identities.ts";
import * as databaseApi from "../database.ts";
import { vi } from "vitest";
import type { InternalPortContext } from "./internal-port-context.ts";
import { executionStore, setExecutionStore } from "../execution-audience.ts";
import { isExecutionStoreFixture } from "./execution-store-fixture.ts";
import { isDispatchAuthoritySetup } from "./internal-dispatch-fixture.ts";
import { ChiefProposalTurns } from "../project-proposal-engines.ts";
import { WebhookManager } from "../webhooks.ts";
import { ImageGenerationService } from "../image-generation.ts";
import { ImageOperations } from "../image-operations.ts";
import { PublishOperations } from "../publish/publish-ops.ts";
import { HostComputerBroker } from "../host-computer-broker.ts";
import { UnifiedBrowserController } from "../browser-control.ts";
import { judgeDaemonIdentity } from "../browser-daemon-identity.ts";
import { PhoneAuthorities } from "../phones/authority.ts";
import { PhoneRegistry } from "../phones/registry.ts";
import { PhoneJobs } from "../phones/jobs.ts";
import { trackProducerQueue } from "../decision/producer-bindings.ts";
import { producerAuthorityFor, readTurnPolicy } from "../decision/index.ts";
import { ToolResults } from "../tool-results.ts";
import { EmailRuntime } from "../email/runtime.ts";
import { EmailTools } from "../email/tools.ts";
import { projectToolHandlers } from "../project-tool-routing.ts";
import { PROJECT_ROUTE_NAMES } from "../consuming-sink-inventory.ts";
import { roomShareApprovalQueue } from "../room-shares.ts";
import { botAccessApprovalQueue } from "../bot-access.ts";

// Capture imported constructor and ancestor methods before any case hook.
for (const Constructor of [CASE_PORTS, Store, InternalCapabilities, BotOutsideWrites, CoordinationBudget, ProviderRegistry, RoutineManager, IndependentThreadRuns, CallSpeechCoordinator, ChiefProposalTurns, WebhookManager, ToolResults]) if (typeof Constructor === "function") registerPortConstructor(Constructor);
const realServiceClasses = {chiefProposals: ChiefProposalTurns, routines: RoutineManager, webhooks: WebhookManager, toolResults: ToolResults, imageService: ImageGenerationService, imageOperations: ImageOperations, publishOperations: PublishOperations,emailRuntime:EmailRuntime,phoneAuthorities:PhoneAuthorities,phoneRegistryOnce:PhoneRegistry,phoneJobs:PhoneJobs,hostComputer:HostComputerBroker,unifiedBrowser:UnifiedBrowserController};
for (const Constructor of [...Object.values(realServiceClasses),EmailTools]) registerPortConstructor(Constructor);
let admittedServices = new WeakSet<object>();
function realService(name: string, value: unknown, Constructor: Function,plan?:ObserverPlan): boolean {
  if (!(value instanceof Constructor)) return false;
  if (Object.getPrototypeOf(value) !== Constructor.prototype) throw new Error(`FIXTURE_OVERRIDE_REFUSED ${name}: real service prototype required`);
  if (admittedServices.has(value)) { assertPortsPristine(); return true; }
  if(Constructor===EmailRuntime) {
    const options=Reflect.get(value,"options");
    const io=new Set(["accountKey","database","transaction","fetch","workspaceRoot","bot","capsFile","now","apiBase","appBase"]);
    if(!options||Reflect.ownKeys(options).some(key=>typeof key!=="string"||!io.has(key)||Object.getOwnPropertyDescriptor(options,key)?.get||Object.getOwnPropertyDescriptor(options,key)?.set))throw new Error("FIXTURE_OVERRIDE_REFUSED emailRuntime: only constructor I/O is admitted");
    const tools=(value as EmailRuntime).services()?.tools;
    if(tools) {
      const descriptor=Object.getOwnPropertyDescriptor(tools,"handle"),real=EmailTools.prototype.handle;
      if(descriptor) {
        if(!vi.isMockFunction(descriptor.value)||descriptor.value.getMockImplementation()!==real)throw new Error("FIXTURE_OVERRIDE_REFUSED emailRuntime.tools.handle");
        Object.defineProperty(tools,"handle",{...descriptor,value:observePort("emailRuntime.tools.handle",descriptor.value,real)});
      }
      trackPort("emailRuntime.tools",tools,true);
    }
  }
  if(Constructor===PhoneJobs) {
    const deps=Reflect.get(value,"deps");
    if(deps?.authorityFor!==producerAuthorityFor)throw new Error("FIXTURE_OVERRIDE_REFUSED phoneJobs.authorityFor");
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value,key)!;
    if (descriptor.get || descriptor.set) throw new Error(`FIXTURE_OVERRIDE_REFUSED ${name}.${String(key)}`);
    if (typeof descriptor.value !== "function") continue;
    // These constructors explicitly accept clocks as I/O. No permission,
    // audience, registry or final-writer implementation is admitted here.
    if ((Constructor===RoutineManager||Constructor===WebhookManager||Constructor===ToolResults||Constructor===PhoneRegistry)
      && (key==="now"||key==="monotonicNow")) continue;
    if(Constructor===HostComputerBroker&&key==="start"||Constructor===UnifiedBrowserController&&["factory","closeFactory","chromeWaiting"].includes(String(key)))continue;
    if(Constructor===UnifiedBrowserController&&key==="judgeDaemon"&&descriptor.value===judgeDaemonIdentity)continue;
    // These fields are the production constructors' explicitly injected provider HTTP transports.
    if ((Constructor===ImageGenerationService||Constructor===PublishOperations) && key==="fetcher" || Constructor===ImageOperations&&key==="waiting") continue;
    const real = Object.getOwnPropertyDescriptor(Constructor.prototype,key)?.value;
    if (!real || !vi.isMockFunction(descriptor.value) || descriptor.value.getMockImplementation() !== real) throw new Error(`FIXTURE_OVERRIDE_REFUSED ${name}.${String(key)}`);
    Object.defineProperty(value,key,{...descriptor,value:observePort(`${name}.${String(key)}`,descriptor.value,real)});
  }
  observeFixtureState(plan,name,value);
  trackPort(name,value,true);
  admittedServices.add(value);
  return true;
}

/** Private fixture assembly, never a production registry or an admitted port.
 * Every value still comes from its unchanged real constructor recipe. */
class FixtureAssembly extends Map<string,unknown> {
  readonly recipes=new Map<string,StatePort>();
  readonly constructing=new Set<string>();
  observe:(name:string,value:unknown)=>unknown=(_name,value)=>value;
  construct:(fresh:()=>unknown)=>unknown=fresh=>fresh();
  override has(name:string):boolean{return super.has(name)||this.recipes.has(name)&&!this.constructing.has(name);}
  override get(name:string):unknown {
    if(super.has(name))return super.get(name);
    const recipe=this.recipes.get(name);if(!recipe)return;
    if(this.constructing.has(name))throw new Error(`FIXTURE_CONSTRUCTOR_CYCLE ${name}`);
    this.constructing.add(name);
    try {const value=this.observe(name,this.construct(recipe.fresh));super.set(name,value);return value;}
    finally {this.constructing.delete(name);}
  }
  override keys():MapIterator<string>{return new Set([...super.keys(),...this.recipes.keys()]).keys();}
}
const assemblyDependencies=new Map<string,{production:readonly string[];values:readonly string[]}>();
const internalStatePorts = new WeakSet<object>();
const stateOwners = new WeakMap<Map<string,unknown>,object>();
const portOwners = new WeakMap<object,object>();
export const internalStatePortOwner = (port:StatePort):object|undefined => portOwners.get(port);
const internalContexts = new WeakSet<object>();
export const isInternalStatePort = (port: StatePort): boolean => internalStatePorts.has(port);
export const isInternalPortContext = (context: InternalPortContext): boolean => internalContexts.has(context);
function privatePorts(ports: StatePort[], state?:Map<string,unknown>): StatePort[] {
  let owner=state&&stateOwners.get(state);
  if(state&&!owner){owner=Object.freeze(Object.create(null));stateOwners.set(state,owner!);}
  for (const port of ports) { port.defer=true;Object.freeze(port); internalStatePorts.add(port);if(owner)portOwners.set(port,owner); }
  return ports;
}

const cleanups: Array<() => void | Promise<void>> = [];
export function closeWithInternalFixture(close: () => void): void { cleanups.push(close); }
let cachedIndexSource: ts.SourceFile | undefined;
const callbackSources = new WeakMap<ts.SourceFile,Map<string,string>>();
// Cache source selections only. No state, services, imports or policy outcomes
// are retained by these recipes; a changed source has a new AST identity.
const statementRecipes=new WeakMap<ts.SourceFile,Map<string,string>>();
function sourceRecipe(source:ts.SourceFile,key:string,select:()=>string):string {
  let recipes=statementRecipes.get(source);if(!recipes){recipes=new Map();statementRecipes.set(source,recipes);}
  if(!recipes.has(key))recipes.set(key,select());return recipes.get(key)!;
}
const callbackInitializers=new WeakMap<ts.SourceFile,Map<string,ts.Expression>>();
function callbackRoots(source:ts.SourceFile):Map<string,ts.Expression> {
  const cached=callbackInitializers.get(source);if(cached)return cached;
  const roots=new Map<string,ts.Expression>(),assignments=new Map<string,ts.Expression>();
  for(const statement of source.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)
    if(ts.isIdentifier(declaration.name)&&declaration.initializer)roots.set(declaration.name.text,declaration.initializer);
  const walk=(node:ts.Node):void=>{
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(node.left))assignments.set(node.left.text,node.right);
    ts.forEachChild(node,walk);
  };walk(source);
  for(const [name,value]of assignments){const root=roots.get(name);if(!root||root.kind===ts.SyntaxKind.NullKeyword||ts.isIdentifier(root)&&root.text==="undefined")roots.set(name,value);}
  callbackInitializers.set(source,roots);return roots;
}

const authorityRecipes = new WeakMap<ts.SourceFile,{reader:string;denials:string;producers:string;origin:string;pure:Map<string,string>}>();
/** The acceptance suite registers this with its existing afterEach cleanup. */
export async function clearInternalAuthorityFixtures(): Promise<void> {
  admittedServices = new WeakSet<object>();
  configureBotEgress(undefined);
  installDenySources({revision(){throw new Error("FIXTURE_NOT_OPEN");},resolve(){throw new Error("FIXTURE_NOT_OPEN");}});
  installProvenanceReader({ turnGenerationFor: () => undefined, provenance: () => undefined, live: () => undefined });
  for (const close of cleanups.splice(0).reverse()) await close();
}

const object = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
function completedStore(input: unknown, claim?: { botId: string; threadId: string }, retained?: Store): Store {
  const supplied = object(input);
  if(input!==undefined&&!(input instanceof Store)&&!isExecutionStoreFixture(input))throw new Error("FIXTURE_OVERRIDE_REFUSED store: complete real Store required");
  if(input instanceof Store) {
    const port=CASE_PORTS.find(port=>port.category==="DATA"&&port.declaration.exportName==="store")!;
    checkCasePort(port,input,undefined,()=>new Error("FIXTURE_OVERRIDE_REFUSED store: real authorization methods required"));
  }
  if (input instanceof Store && (!retained || input === retained)) return input;
  const previous = executionStore();
  const store = retained ?? new Store(undefined,undefined,true);
  setExecutionStore(previous);
  const rows = Array.isArray(supplied.bots) ? supplied.bots : [];
  if (rows.length || !retained) store.bots = rows.map((row: Partial<BotRecord>) => {
    const bot = {
      id: claim?.botId ?? "fixture-bot", threadId: claim?.threadId ?? "fixture-thread", name: "Fixture", title: "Fixture", description: "", notifications: false,
      color: "blue", unread: false, resumeCursors: {}, modelSelection: { instanceId: "fixture", model: "fixture" }, createdAt: 1,
      ...store.bot(row.id ?? claim?.botId ?? "fixture-bot"), ...row,
    } satisfies BotRecord;
    const tasks = [...(bot.tasks ?? [])];
    if (!tasks.some(task => task.threadId === bot.threadId)) tasks.push({threadId:bot.threadId,title:bot.title,createdAt:bot.createdAt,resumeCursors:{...bot.resumeCursors}});
    bot.tasks = tasks;
    return bot;
  });
  if (Array.isArray(supplied.groups) || !retained) store.groups = (Array.isArray(supplied.groups) ? supplied.groups : []).map((row: Partial<GroupRecord>) => ({
    id: "fixture-room", threadId: "fixture-room-thread", name: "Fixture", memberIds: [], defaultResponder: { kind: "everyone" },
    bulletin: "", unread: false, createdAt: 1, ...row,
  } satisfies GroupRecord));
  // Only roster data is migrated from legacy literals. Every method remains
  // the real Store method; case callbacks cannot replace authority readers or
  // manufacture the result of storage queries.
  return store;
}

export interface DispatchUnit {
  [name: string]: any;
  dispatch: () => Promise<void>;
  verifyDecisionClaim: Parameters<typeof installClaimVerifier>[0];
  makeDecisionProvenance: (...args: any[]) => any;
  beginInternalTurn: (...args: any[]) => void;
  internalToken: (...args: any[]) => string;
  reader: ProvenanceReader;
}
export interface InternalAdmission {
  botId: string; threadId: string; generation: string; provenanceGeneration?: string;
  initiator: Initiator; roomOwnerOnly: boolean; provenance: boolean;
}
export interface BoundInternalDispatch {
  dispatch: () => Promise<void>; bound: Record<string, unknown>; free: Map<string, Resolution>;
  unit: DispatchUnit;
}
const privateStates=new WeakMap<BoundInternalDispatch,Map<string,unknown>>();
const fixtureMapGet=Map.prototype.get;
const fixtureObserverNames=["sharedOwnerUsage.begin","sharedOwnerUsage.accepted","sharedOwnerUsage.end","botCalls.fact","botCalls.warn","store.createBot","store.appendMessage","store.rowsOfKind","store.markPhoneUsed","phoneJobs.request","browserSetup.request","routineRequests.propose","computerControl.snapshot","computerControl.requestHelpLease","computerControl.expireHelp","watchdog.touch","watchdog.silenceLimitMs","watchdog.opts.onStall"] as const;
type FixtureObserverName=typeof fixtureObserverNames[number] | `projectToolHandlers.${string}`;
export interface FixtureObservers { spy(name:FixtureObserverName):ReturnType<typeof observationView> }
type ObserverPlan={requested:Set<FixtureObserverName>;bound:Map<FixtureObserverName,{owner:object;guarded:Function;view:ReturnType<typeof observationView>}>};
const observerPlans=new WeakMap<FixtureObservers,ObserverPlan>();
function observationView(spy:ReturnType<typeof vi.fn>,name:string) {
  // Matchers read exact, unfiltered records from the real private spy. This
  // read-only view has no callable implementation and never publishes the
  // receiver stored in Vitest's contexts/instances arrays.
  const metadata=Object.freeze({
    get calls(){return Object.freeze(spy.mock.calls.map(args=>Object.freeze([...args])));},
    get results(){return Object.freeze(spy.mock.results.map(result=>Object.freeze({...result})));},
    get settledResults(){return Object.freeze(spy.mock.settledResults.map(result=>Object.freeze({...result})));},
    get invocationCallOrder(){return Object.freeze([...spy.mock.invocationCallOrder]);},
    get lastCall(){return spy.mock.lastCall&&Object.freeze([...spy.mock.lastCall]);},
    get contexts():never{throw new Error("FIXTURE_OBSERVER_PRIVATE_RECEIVER");},
    get instances():never{throw new Error("FIXTURE_OBSERVER_PRIVATE_RECEIVER");},
  });
  return Object.freeze(Object.assign(function fixtureObservation(..._args:unknown[]):never{
    throw new Error("FIXTURE_OBSERVER_READ_ONLY");
  },{_isMockFunction:true as const,getMockName:()=>name,getMockImplementation:()=>undefined,mock:metadata}));
}
/** Names only: the fixture binds observations to methods of its own real
 * services. A caller cannot provide a method implementation or service object. */
export function fixtureObservers(names:readonly FixtureObserverName[]):FixtureObservers {
  if(names.some(name=>!(fixtureObserverNames as readonly string[]).includes(name)&&!(name.startsWith("projectToolHandlers.")&&PROJECT_ROUTE_NAMES.includes(name.slice("projectToolHandlers.".length)))))throw new Error("FIXTURE_OBSERVER_NAME_REFUSED");
  const plan:FixtureObservers=Object.freeze({spy(name:FixtureObserverName){
    const bound=observerPlans.get(plan)?.bound.get(name);
    if(!bound)throw new Error(`FIXTURE_OBSERVER_NOT_BOUND ${name}`);
    return bound.view;
  }});
  observerPlans.set(plan,{requested:new Set(names),bound:new Map()});return plan;
}
function observerPlan(value:unknown):ObserverPlan|undefined {
  if(value===undefined)return;
  const plan=typeof value==="object"&&value!==null?observerPlans.get(value as FixtureObservers):undefined;
  if(!plan)throw new Error("FIXTURE_OVERRIDE_REFUSED fixtureObservers: fixture-owned observation plan required");
  return plan;
}
function observeFixtureState(plan:ObserverPlan|undefined,name:string,value:unknown):unknown {
  if(!plan||!value||typeof value!=="object")return value;
  for(const requested of plan.requested) {
    if(requested==="botCalls.warn"||requested.startsWith("projectToolHandlers."))continue; // A constructor callback, installed from the production unit below.
    const [service,...path]=requested.split(".");if(service!==name)continue;
    let owner=value;for(const part of path.slice(0,-1))owner=Reflect.get(owner,part);
    const method=path.at(-1)!;
    const before=plan.bound.get(requested);
    if(before){if(before.owner!==owner||Reflect.get(owner,method)!==before.guarded)throw new Error(`FIXTURE_PORT_TAMPERED ${requested}`);continue;}
    const real=Reflect.get(owner,method);
    if(typeof real!=="function")throw new Error(`FIXTURE_OBSERVER_METHOD_MISSING ${requested}`);
    const spy=vi.fn(real as (...args:any[])=>any),guarded=observePort(requested,spy,real);
    Object.defineProperty(owner,method,{value:guarded,writable:true,configurable:true});
    plan.bound.set(requested,{owner,guarded,view:observationView(spy,requested)});
  }
  return value;
}
const projectObservationOrigins=new WeakMap<Function,Function>();
function observeProjectHandlers(plan:ObserverPlan|undefined):void {
  if(!plan)return;
  for(const name of plan.requested)if(name.startsWith("projectToolHandlers.")) {
    const key=name.slice("projectToolHandlers.".length),current=projectToolHandlers.get(key);
    const before=plan.bound.get(name);
    if(before){if(current!==before.guarded)throw new Error(`FIXTURE_PORT_TAMPERED ${name}`);continue;}
    if(typeof current!=="function")throw new Error(`FIXTURE_OBSERVER_METHOD_MISSING ${name}`);
    const real=projectObservationOrigins.get(current)??current,spy=vi.fn(real as (...args:any[])=>any),guarded=observePort(name,spy,real);
    projectObservationOrigins.set(guarded,real);
    projectToolHandlers.set(key,guarded as typeof current);
    const owner=Object.freeze({call:guarded});plan.bound.set(name,{owner,guarded,view:observationView(spy,name)});
    cleanups.push(()=>{if(projectToolHandlers.get(key)===guarded)projectToolHandlers.set(key,current);});
  }
}
/** Seed only real per-turn public writers, retaining their production callbacks. */
export function prepareInternalFixtureActivity(binding:BoundInternalDispatch,identity:{botId:string;threadId:string;generation:string},stallMs?:number,help?:string) {
  if(stallMs===undefined&&help===undefined)return;
  const state=privateStates.get(binding);if(!state)throw new Error("FIXTURE_STATE_MISSING");
  const retained=(state.get("internalTurnOwners") as Map<string,{botId:string;generation:string}>).get(identity.threadId);
  if(retained?.botId!==identity.botId||retained.generation!==identity.generation)throw new Error("FIXTURE_ACTIVITY_OWNER_MISMATCH");
  if(stallMs!==undefined)(state.get("watchdog") as import("../turn-watchdog.ts").TurnWatchdog).watch(identity.threadId,identity.botId,{generation:identity.generation,stallMs});
  return help===undefined?undefined:(state.get("computerControl") as import("../computer-control.ts").ComputerControl).requestHelpLease(identity.botId,help);
}
/** Hold the real configuration transaction across a dispatch. The imported
 * lock runner owns both transitions; fixture I/O supplies only its pending work. */
export async function holdInternalFixtureMcpConfiguration(binding:BoundInternalDispatch,identity:{botId:string;threadId:string;generation:string}):Promise<void> {
  if(!fixtureOwner(binding,identity))throw new Error("FIXTURE_CONFIGURATION_OWNER_MISMATCH");
  const source=cachedIndexSource!;const callback=sourceRecipe(source,"configuration-lock",()=>{
  let callback="";
  const walk=(node:ts.Node):void=>{
    if(ts.isCallExpression(node)&&node.expression.getText(source)==="runLockedImport"&&node.arguments[0]&&ts.isObjectLiteralExpression(node.arguments[0])) {
      const field=node.arguments[0].properties.find(field=>ts.isPropertyAssignment(field)&&field.name.getText(source)==="setBusy");
      if(field&&ts.isPropertyAssignment(field))callback=field.initializer.getText(source);
    }
    ts.forEachChild(node,walk);
  };walk(source);if(!callback)throw new Error("FIXTURE_CONFIGURATION_WRITER_MISSING");return callback;
  });
  const unit=await bindInternalDispatch({expression:`async () => (${callback})`,scope:{},source,parent:binding});
  const setBusy=await unit.dispatch() as unknown;
  if(typeof setBusy!=="function")throw new Error("FIXTURE_CONFIGURATION_WRITER_MISSING");
  const {runLockedImport}=await import("../claude-code-import.ts");
  let release!:()=>void;const held=new Promise<void>(done=>{release=done;});
  const pending=runLockedImport({setBusy:busy=>setBusy(busy),run:async()=>{await held;return {status:200,body:{}};},respond:()=>undefined});
  cleanups.push(async()=>{release();await pending;});
}
function fixtureOwner(binding:BoundInternalDispatch,identity:{botId:string;threadId:string;generation:string}):boolean {
  const state=privateStates.get(binding),owner=(state?.get("internalTurnOwners") as Map<string,{botId:string;generation:string}>|undefined)?.get(identity.threadId);
  return owner?.botId===identity.botId&&owner.generation===identity.generation
    &&readTurnPolicy({threadId:identity.threadId,generation:identity.generation})?.actor==="owner";
}
/** Register the fixture's hosted computer through the production mount writer. */
export async function prepareInternalFixtureBox(binding:BoundInternalDispatch,identity:{botId:string;threadId:string;generation:string},id:string):Promise<void> {
  if(!fixtureOwner(binding,identity)||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error("FIXTURE_BOX_OWNER_MISMATCH");
  const source=cachedIndexSource!;const statement=sourceRecipe(source,"box-mount",()=>{
    let statement="";
    const walk=(node:ts.Node):void=>{if(ts.isIfStatement(node)&&node.expression.getText(source)==="isCloudHome()"&&node.thenStatement.getText(source)==="boxBindings.set(bot.id, b.id);")statement=node.getText(source);ts.forEachChild(node,walk);};walk(source);
    if(!statement)throw new Error("FIXTURE_BOX_WRITER_MISSING");return statement;
  });
  const unit=await bindInternalDispatch({expression:`async () => { const bot=store.bot(${JSON.stringify(identity.botId)}),b={id:${JSON.stringify(id)}};${statement} }`,scope:{},source,parent:binding});await unit.dispatch();
}
export async function attachInternalFixtureRequest(binding:BoundInternalDispatch,identity:{botId:string;threadId:string;generation:string},id:string):Promise<void> {
  const state=privateStates.get(binding),source=cachedIndexSource!;
  if(!state||!fixtureOwner(binding,identity))throw new Error("FIXTURE_REQUEST_OWNER_MISMATCH");
  const db=(state.get("_fixtureDatabase") as ()=>import("node:sqlite").DatabaseSync|undefined)?.();
  if(!db)throw new Error("FIXTURE_DATABASE_MISSING");
  const {roomRequest}=await import("../room-requests.ts"),request=roomRequest(db,id);
  if(!request||request.toBotId!==identity.botId||request.targetThreadId!==identity.threadId||request.state!=="running")throw new Error("FIXTURE_REQUEST_DATA_MISMATCH");
  const writer=sourceRecipe(source,"project-request",()=>{
    let writer="";const walk=(node:ts.Node):void=>{if(ts.isIfStatement(node)&&node.expression.getText(source)==="opts?.projectCardRun || opts?.sharedWorkRun")writer=node.thenStatement.getText(source);ts.forEachChild(node,walk);};walk(source);
    if(!writer)throw new Error("FIXTURE_REQUEST_WRITER_MISSING");return writer;
  });
  const unit=await bindInternalDispatch({expression:`async () => {const dispatchClaimId=${JSON.stringify(identity.generation)},opts={sharedWorkRun:{request:${JSON.stringify(request)}}};${writer}}`,scope:{},source,parent:binding});await unit.dispatch();
}
export async function prepareInternalFixtureComputer(binding:BoundInternalDispatch,identity:{botId:string;threadId:string;generation:string},mode:"host"|"browser"|"legacy",connection:import("../host-computer-broker.ts").HostComputerSpec,io:Record<string,unknown>={}):Promise<void> {
  if(!privateStates.has(binding)||!fixtureOwner(binding,identity))throw new Error("FIXTURE_DEVICE_OWNER_MISMATCH");

  if(mode==="legacy") {
    // Compatibility-snapshot DATA: the current producer mounts the unified
    // controller. Exercise the retained legacy reader with its real native Map,
    // the admitted capability identity, and a virtual process spec. No case may
    // supply a registry, an ownership check, or a liveness implementation.
    checkCasePort(CASE_PORTS.find(port=>port.declaration.exportName==="cfg")!,connection,undefined,()=>new Error("FIXTURE_DEVICE_SPEC_REFUSED"));
    const entries=privateStates.get(binding)!.get("headlessBrowsersByThread") as Map<string,unknown>;
    entries.set(identity.threadId,Object.freeze({botId:identity.botId,ownerId:identity.generation,spec:structuredClone(connection)}));
    return;
  }
  const expression=mode==="host"?`async () => hostComputerIntegration(${JSON.stringify(identity.botId)},${JSON.stringify(identity.threadId)},${JSON.stringify(identity.generation)},${JSON.stringify(connection)})`
    :`async () => browserIntegration(${JSON.stringify(identity.botId)},undefined,${JSON.stringify(identity.threadId)},()=>internalCapabilities.isActive(internalCapabilities.resolve("Bearer "+internalToken(${JSON.stringify(identity.botId)},${JSON.stringify(identity.threadId)},${JSON.stringify(identity.generation)},"computer"))),${JSON.stringify(identity.generation)})`;
  const unit=await bindInternalDispatch({expression,scope:io,source:cachedIndexSource!,parent:binding});
  const result=await unit.dispatch() as unknown;
  if(mode==="browser"&&(!result||typeof result!=="object"||!("profileKey" in result)))throw new Error(`FIXTURE_BROWSER_MOUNT_REFUSED ${JSON.stringify(result)}`);
}
export interface FixtureEngineProfile {instanceId:string;driverKind:string;adapter:{capabilities:Record<string,unknown>};models:{default:string;options:Array<{id:string;contextWindow?:number}>}}
export async function prepareInternalFixtureEngine(binding:BoundInternalDispatch,identity:{botId:string;threadId:string;generation:string},profile:FixtureEngineProfile,model:string):Promise<void> {
  if(!privateStates.has(binding)||!fixtureOwner(binding,identity))throw new Error("FIXTURE_ENGINE_OWNER_MISMATCH");
  const source=cachedIndexSource!;let writer="";
  const walk=(node:ts.Node):void=>{if(ts.isExpressionStatement(node)&&node.getText(source)==="turnEngineByThread.set(threadId, engineStamp(instance, model, providerRoute?.connectionId));")writer=node.getText(source);ts.forEachChild(node,walk);};walk(source);
  if(!writer)throw new Error("FIXTURE_ENGINE_WRITER_MISSING");
  const unit=await bindInternalDispatch({expression:`async () => {const threadId=${JSON.stringify(identity.threadId)},instance=${JSON.stringify(profile)},model=${JSON.stringify(model)},providerRoute=undefined;${writer}}`,scope:{},source,parent:binding});
  await unit.dispatch();
}
export function installInternalFixtureProducers(binding:BoundInternalDispatch):()=>void {
  const unit=privateStates.get(binding)?.get("_fixtureProductionUnit") as DispatchUnit|undefined;
  if(!unit)throw new Error("FIXTURE_STATE_MISSING");
  const state=privateStates.get(binding)!;
  // These producers own a queue per service, database or roster. Construct
  // their real queues before binding, so another fixture's queue is never reused.
  state.get("routineRequests");state.get("phoneJobs");
  const db=(state.get("_fixtureDatabase") as (()=>import("node:sqlite").DatabaseSync)|undefined)?.()??database();
  trackProducerQueue(roomShareApprovalQueue(db));
  trackProducerQueue(botAccessApprovalQueue(state.get("store") as Store));
  for(const value of state.values())if(value&&typeof value==="object"&&typeof Reflect.get(value,"approvalQueue")==="function")trackProducerQueue(Reflect.get(value,"approvalQueue").call(value));
  return installProducerBindings(unit.producers);
}
/** Construction/cleanup operations never return the retained service. */
export function checkInternalDispatchRoutines(binding:BoundInternalDispatch):void {
  const state=privateStates.get(binding);
  if(state instanceof FixtureAssembly&&state.recipes.has("routines"))return;
  if(!(state?.get("routines") instanceof RoutineManager))throw new Error("FIXTURE_SCOPE_UNRESOLVED routines");
}
export function stopInternalDispatchRoutines(binding:BoundInternalDispatch):void {
  const state=privateStates.get(binding);
  const routines=state&&fixtureMapGet.call(state,"routines");
  if(routines instanceof RoutineManager)routines.stop();
}
/** Register only an authentic retained binding for the already admitted owner.
 * Execute the actual production registration statement against private state. */
export async function registerInternalFixtureResponse(binding: BoundInternalDispatch, response: import("../consuming-turn-response.ts").ConsumingTurnBinding): Promise<void> {
  const state = privateStates.get(binding);
  if (!state) throw new Error("FIXTURE_STATE_MISSING");
  const { assertConsumingBinding } = await import("../consuming-turn-response.ts");
  assertConsumingBinding(response);
  const owner = (state.get("internalTurnOwners") as Map<string, any>).get(response.identity.threadId);
  if (!owner || owner.botId !== response.identity.botId || owner.generation !== response.identity.dispatchGeneration) throw new Error("FIXTURE_RESPONSE_OWNER_MISMATCH");
  const extracted = extractFunction({file: new URL("../index.ts", import.meta.url), select: sf => {
    const selected=sourceRecipe(sf,"response-binding",()=>{
      let selected = "";
      const walk = (node: ts.Node): void => {
        if (ts.isExpressionStatement(node) && node.expression.getText(sf) === "internalResponseBindings.set(owner.generation, consumingBinding)") selected = node.getText(sf);
        ts.forEachChild(node, walk);
      };walk(sf);
      if (!selected) throw new Error("FIXTURE_RESPONSE_WRITER_MISSING");return selected;
    });
    return `() => { const consumingBinding = fixtureResponse(); ${selected} }`;
  }});
  const unit = await extracted.preflight({}, {ports: privatePorts([
    {name: "internalResponseBindings", fresh: () => state.get("internalResponseBindings"), reason: "Private real response registry."},
    {name: "owner", fresh: () => owner, reason: "Already admitted production owner row."},
    {name: "fixtureResponse", fresh: () => () => response, reason: "Return the validated immutable retained binding with its exact identity."},
  ],state)});
  unit.value();
}
/** The fixture's explicitly admitted owner answers the actual durable card.
 * Keep the checked-card tail and answer invocation from the real owner handler;
 * no valid-card, live-owner or state-machine implementation comes from a case. */
export function stopInternalFixtureOwnWrite(binding:BoundInternalDispatch,threadId:string,generation:string):void {
  const state=privateStates.get(binding);
  const holds=state&&fixtureMapGet.call(state,"ownWriteHolds") as import("../own-write-holds.ts").OwnWriteHolds|undefined;
  holds?.stop(threadId,generation);
}
export async function answerInternalFixtureOwnWrite(binding:BoundInternalDispatch,requestId:string,stateRevision:number):Promise<void> {
  if(!privateStates.has(binding))throw new Error("FIXTURE_STATE_MISSING");
  const file=new URL("../index.ts",import.meta.url),source=cachedIndexSource??=ts.createSourceFile("index.ts",readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  const handler=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="respondToOwnWriteCard");
  if(!handler||!ts.isFunctionDeclaration(handler)||!handler.body)throw new Error("FIXTURE_OWNER_HANDLER_MISSING");
  const statements=handler.body.statements,start=statements.findIndex(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>ts.isIdentifier(declaration.name)&&declaration.name.text==="id"));
  const answer=statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>ts.isIdentifier(declaration.name)&&declaration.name.text==="result"));
  const declaration=answer&&ts.isVariableStatement(answer)?answer.declarationList.declarations[0]:undefined;
  if(start<0||!declaration?.initializer)throw new Error("FIXTURE_OWNER_HANDLER_MISSING");
  const state=privateStates.get(binding)!;
  const id=requestId.slice(4),row=state.get("ownWriteHolds") as import("../own-write-holds.ts").OwnWriteHolds;
  const held=row.get(id);
  if(!held||!fixtureOwner(binding,held))throw new Error("FIXTURE_OWNER_ACTION_REFUSED");

  const expression=`async () => { const threadId=${JSON.stringify(held.threadId)}; const route={botId:${JSON.stringify(held.botId)}}; const requestId=${JSON.stringify(requestId)}; ${statements.slice(start,statements.indexOf(answer!)).map(node=>node.getText(source)).join("\n")} return ${declaration.initializer.getText(source)}; }`;
  const {consumingResponseRecorder}=await import("./consuming-fixture.ts");
  const output=consumingResponseRecorder();
  const owner=await bindInternalDispatch({expression,scope:{req:{headers:{}},res:output.raw,body:{behavior:"allow",stateRevision}},source,parent:binding});
  const result=await owner.dispatch() as unknown as {status:number;row:{state:string}|null}|undefined;
  if(result?.status!==200||result.row?.state!=="applied")throw new Error(`FIXTURE_OWNER_ANSWER_REFUSED ${result?.status??output.output[0]?.status??0}`);
  // The consuming request may finish before this owner answer resumes. Read
  // its durable card through the retained database, independently of global I/O cleanup.
  const db=(state.get("_fixtureDatabase") as ()=>import("node:sqlite").DatabaseSync)();
  const card=db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(held.threadId,`own-writer-card-${id}`);
  const {ownWriteCardAuthorized}=await import("../own-write-holds.ts");
  if(!card||!ownWriteCardAuthorized(db,held.threadId,JSON.parse(String(card.json))))throw new Error("FIXTURE_OWNER_CARD_MISSING");
}
/** Fixture-owned retained data enters through the same registration statements as dispatch.
 * Neither a caller map nor an arbitrary lineage lookup can replace these readers. */
export async function retainInternalFixtureLineage(binding: BoundInternalDispatch, response: import("../consuming-turn-response.ts").ConsumingTurnBinding,
  lineage?: import("../steer-lineage.ts").RunningTurnLineage, writer?: object): Promise<void> {
  const state = privateStates.get(binding);
  if (!state) throw new Error("FIXTURE_STATE_MISSING");
  const { assertConsumingBinding, consumingResponseBinding } = await import("../consuming-turn-response.ts");
  assertConsumingBinding(response);
  if (writer && consumingResponseBinding(writer) !== response) throw new Error("FIXTURE_RESPONSE_OWNER_MISMATCH");
  if (lineage && (lineage.turn !== response.turn || lineage.generation !== response.identity.dispatchGeneration || lineage.botId !== response.identity.botId)) throw new Error("FIXTURE_LINEAGE_OWNER_MISMATCH");
  const statements = [
    ...(writer ? ["internalCallers.set(res, { botId: internalClaim.botId, threadId: internalClaim.threadId })"] : []),
    ...(lineage ? ["turnOutputRoots.set(threadId, lineage)"] : []),
  ];
  const extracted = extractFunction({file: new URL("../index.ts", import.meta.url), select: source => {
    return sourceRecipe(source,`retained:${statements.join(";")}`,()=>{
      const selected: string[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isExpressionStatement(node) && statements.includes(node.expression.getText(source))) selected.push(node.getText(source));
        ts.forEachChild(node, walk);
      };walk(source);
      if (selected.length !== statements.length) throw new Error("FIXTURE_RETAINED_WRITER_MISSING");
      return `() => { const lineage = fixtureLineage(); ${selected.join("\n")} }`;
    });
  }});
  const unit = await extracted.preflight(writer ? {res: writer} : {}, {ports: privatePorts([
    {name: "fixtureLineage", fresh: () => () => lineage, reason: "Return the validated retained lineage with its exact identity."},
    ...["internalCallers", "turnOutputRoots"].map(name => ({name, fresh: () => state.get(name), reason: "Private production state; no caller map is admitted."})),
    ...Object.entries({internalClaim: response.identity, threadId: response.identity.threadId}).map(([name, value]) => ({name, fresh: () => value, reason: "Validated authentic retained fixture input."})),
  ],state)});
  unit.value();
}
function diagnosticSnapshot(value:unknown,seen=new WeakMap<object,unknown>()):unknown {
  if(!value||typeof value!=="object")return typeof value==="function"?undefined:value;
  if(seen.has(value))return seen.get(value);
  if(value instanceof Map){const copy=new Map();seen.set(value,copy);for(const [key,row]of value)copy.set(diagnosticSnapshot(key,seen),diagnosticSnapshot(row,seen));return copy;}
  const copy:Record<string,unknown>=Object.create(null);seen.set(value,copy);
  for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(value)))if("value"in descriptor)copy[key]=diagnosticSnapshot(descriptor.value,seen);
  return Object.freeze(copy);
}
type InternalDispatchOptions = { expression: string; scope: Record<string, unknown>; source?: ts.SourceFile;
  admission?: InternalAdmission; parent?: BoundInternalDispatch; preserveCapabilities?: boolean; expose?: string[]; boxFetch?:typeof fetch;
};
export function bindInternalDispatch(options: InternalDispatchOptions): Promise<BoundInternalDispatch> {
  return withinPortScope(()=>bindInternalDispatchScoped(options));
}
async function bindInternalDispatchScoped(options: InternalDispatchOptions): Promise<BoundInternalDispatch> {
  assertPortsPristine();
  await preloadStatePortAdmission();
  const sharedState=options.parent?privateStates.get(options.parent):undefined;
  if(options.boxFetch!==undefined&&typeof options.boxFetch!=="function")throw new Error("FIXTURE_BOX_TRANSPORT_REFUSED");
  if(options.parent&&!sharedState)throw new Error("FIXTURE_STATE_MISSING");
  const setupDescriptor=Object.getOwnPropertyDescriptor(options.scope,"dispatchAuthoritySetup");
  if(setupDescriptor&&(setupDescriptor.get||setupDescriptor.set||!isDispatchAuthoritySetup(setupDescriptor.value)))throw new Error("FIXTURE_OVERRIDE_REFUSED dispatchAuthoritySetup: fixture-owned setup required");
  const setup = object(setupDescriptor?.value);
  if(options.scope.dispatchAuthoritySetup!==undefined&&!isDispatchAuthoritySetup(setup))throw new Error("FIXTURE_OVERRIDE_REFUSED dispatchAuthoritySetup: real fixture setup required");
  if (!sharedState && typeof setup.bind === "function") return setup.bind(options.expression,options.scope,options.source,options.expose);
  const file = new URL("../index.ts", import.meta.url);
  const text=currentSourceText(file.pathname);
  if(text===undefined)throw new Error("FIXTURE_SOURCE_MISSING index.ts");
  if(options.source&&options.source.text!==text)throw new Error("FIXTURE_SOURCE_REFUSED index.ts: canonical production text required");
  const source=cachedIndexSource?.text===text?cachedIndexSource:(cachedIndexSource=ts.createSourceFile(file.pathname,text,ts.ScriptTarget.Latest,true));
  let reader = "", denials = "", producers="", origin="";
  const pure = new Map<string,string>();
  const walk = (node: ts.Node): void => {
    if(ts.isExpressionStatement(node)&&node.getText(source)==="botTurnOrigins.set(dispatchClaimId, botOrigin);")origin=node.getText(source);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "installProvenanceReader" && node.arguments[0]) reader = node.arguments[0].getText(source);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "installDenySources" && node.arguments[0]) denials = node.arguments[0].getText(source);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "installProducerBindings" && node.arguments[0]) producers = node.arguments[0].getText(source);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["turnGenerationFor","botSettleDriver"].includes(node.name.text)
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) pure.set(node.name.text,node.initializer.getText(source));
    ts.forEachChild(node,walk);
  };
  const recipe=authorityRecipes.get(source);
  if(recipe){reader=recipe.reader;denials=recipe.denials;producers=recipe.producers;origin=recipe.origin;for(const [name,text]of recipe.pure)pure.set(name,text);}
  else {walk(source);authorityRecipes.set(source,{reader,denials,producers,origin,pure});}
  if (!reader || !denials || !producers || !origin || pure.size !== 2) throw new Error("FIXTURE_AUTHORITY_WRITER_MISSING");
  for(const [name,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(options.scope)))if(descriptor.get||descriptor.set)throw overrideRefused(name,resolveCaseDeclaration(source,name),source);
  const canonical:Record<string,unknown> = {
    ...(sharedState?.has("_fixtureDatabase")?{database:sharedState.get("_fixtureDatabase")}:{}),
    ...(sharedState?.has("_fixtureTransaction")?{transaction:sharedState.get("_fixtureTransaction")}:{}),
    ...options.scope,
  };
  for(const name of Object.keys(canonical)) {
    if(name==="dispatchAuthoritySetup") {
      if(!canonical[name]||!isDispatchAuthoritySetup(canonical[name] as object))throw overrideRefused(name,resolveCaseDeclaration(source,name),source);
      delete canonical[name];continue;
    }
    if(name==="fixtureObservers") {observerPlan(canonical[name]);continue;}
    if(name==="internalCapabilities")continue; // Exact real registry is validated below.
    if(Object.hasOwn(realServiceClasses,name)) {
      if(canonical[name]===undefined)delete canonical[name];
      else if(!(canonical[name] instanceof realServiceClasses[name as keyof typeof realServiceClasses]))throw overrideRefused(name,resolveCaseDeclaration(source,name),source);
      continue;
    }
    const port=casePortFor(resolveCaseDeclaration(source,name));
    if(!port)throw overrideRefused(name,resolveCaseDeclaration(source,name),source);
    if(port.category==="DATA")checkCasePort(port,canonical[name],undefined,()=>overrideRefused(name,resolveCaseDeclaration(source,name),source));
  }
  const observation=observerPlan(canonical.fixtureObservers);
  delete canonical.fixtureObservers;
  if(sharedState&&observation&&sharedState.get("_fixtureObserverPlan")!==observation)throw new Error("FIXTURE_OBSERVER_OWNER_CHANGED");
  if (Object.hasOwn(canonical,"json")) {
    const actual = extractFunction({file,text:source.text,select:()=>"() => {}"}).source;
    throw overrideRefused("json",resolveCaseDeclaration(actual,"json"),actual);
  }
  if (!Object.hasOwn(canonical,"url") && typeof canonical.path === "string") canonical.url = new URL(canonical.path,"http://fixture.invalid");
  const suppliedCaps=canonical.internalCapabilities;
  if(suppliedCaps!==undefined&&(!(suppliedCaps instanceof InternalCapabilities)||Object.getPrototypeOf(suppliedCaps)!==InternalCapabilities.prototype
    ||Reflect.ownKeys(suppliedCaps).some(key=>{const descriptor=Object.getOwnPropertyDescriptor(suppliedCaps,key)!;return (typeof descriptor.value==="function"||!!descriptor.get||!!descriptor.set)
      &&typeof Object.getOwnPropertyDescriptor(InternalCapabilities.prototype,key)?.value==="function";})))throw new Error("FIXTURE_OVERRIDE_REFUSED internalCapabilities: real constructor and methods required");
  const oldRegistry=suppliedCaps instanceof InternalCapabilities?suppliedCaps:undefined;
  const req = object(canonical.req), headers = object(req.headers);
  const candidate = oldRegistry?.resolve(headers.authorization);
  const claim = candidate && [candidate.botId,candidate.threadId,candidate.generation].every(value => typeof value === "string" && value.length > 0) ? candidate : undefined;
  const releaseControl = claim && oldRegistry ? oldRegistry.releaseControl(claim) : undefined;
  const callerCaps = oldRegistry;
  const caps = sharedState?.get("internalCapabilities") as InternalCapabilities | undefined
    ?? (options.preserveCapabilities ? new InternalCapabilities() : callerCaps ?? new InternalCapabilities());
  const retainedStore = sharedState?.get("store") as Store | undefined;
  const store = completedStore(canonical.store,options.admission ?? claim ?? undefined,retainedStore);
  const home = sharedState?.get("_fixtureHome") as string|undefined ?? mkdtempSync(join(tmpdir(),"internal-authority-"));
  if(!sharedState)cleanups.push(() => removeTempDir(home));
  const state = sharedState ?? new FixtureAssembly();
  state.set("_fixtureHome",home);
  if(!sharedState&&observation)state.set("_fixtureObserverPlan",observation);
  if(!sharedState&&options.boxFetch)state.set("_fixtureBoxFetch",options.boxFetch);
  const boundObservation=state.get("_fixtureObserverPlan") as ObserverPlan|undefined;
  observeProjectHandlers(boundObservation);
  if(state instanceof FixtureAssembly) {
    state.observe=(name,value)=>{
      const observed=observeFixtureState(boundObservation,name,value);
      // Services created after the producer bridge was installed register the
      // same real queue as services constructed during initial setup.
      if(observed&&typeof observed==="object"&&typeof Reflect.get(observed,"approvalQueue")==="function")trackProducerQueue(Reflect.get(observed,"approvalQueue").call(observed));
      return observed;
    };
    if(typeof canonical.transaction==="function")state.construct=fresh=>Reflect.apply(canonical.transaction as Function,undefined,[()=>fresh()]);
  }
  const suppliedServices=new Set<string>();
  if(!sharedState)for(const [name,Constructor]of Object.entries(realServiceClasses)) {
    const supplied=canonical[name];
    if(supplied!==undefined&&realService(name,supplied,Constructor,boundObservation)){state.set(name,supplied);suppliedServices.add(name);}
  }
  const requiredProduction = state.get("_fixtureProductionNames") as Set<string> | undefined ?? new Set<string>();
  state.set("_fixtureProductionNames",requiredProduction);
  const requiredValues = state.get("_fixtureProductionValues") as Set<string> | undefined ?? new Set<string>();
  state.set("_fixtureProductionValues",requiredValues);
  if (!sharedState) state.set("directRuns",new IndependentThreadRuns<BotRecord>());
  const context: InternalPortContext = {store,dataDir:home,capabilities:caps,state,boxFetch:state.get("_fixtureBoxFetch") as typeof fetch|undefined,
    port(name) {
      if(!state.has(name))throw new Error(`FIXTURE_STATE_MISSING ${name}`);
      return privatePorts([{name,fresh:()=>state.get(name),reason:"Existing private real fixture state; no caller-created port."}],state)[0];
    },
    database:typeof canonical.database === "function" ? canonical.database as () => import("node:sqlite").DatabaseSync : database,
    value<T>(name: string): () => T {
      requiredValues.add(name);
      return () => {
        const unit = state.get("_fixtureProductionUnit") as DispatchUnit;
        if (!unit || !Object.hasOwn(unit,name)) throw new Error(`FIXTURE_POLICY_DEPENDENCY_MISSING ${name}`);
        return unit[name] as T;
      };
    },
    production<T extends (...args: any[]) => any>(name: string): T {
      requiredProduction.add(name);
      return ((...args: Parameters<T>) => {
        const unit = state.get("_fixtureProductionUnit") as DispatchUnit;
        if (typeof unit?.[name] !== "function") throw new Error(`FIXTURE_POLICY_DEPENDENCY_MISSING ${name}`);
        const observed=state.get("_fixtureObservedProduction") as Map<string,Function>|undefined;
        return (observed?.get(name)??unit[name])(...args);
      }) as T;
    },
  };
  internalContexts.add(context);
  if (!sharedState) {
    const wasMock = vi.isMockFunction(databaseApi.database);
    const db = context.database();
    state.set("_fixtureDatabase",context.database);
    if(typeof canonical.transaction==="function")state.set("_fixtureTransaction",canonical.transaction);
    initializeTeamIdentityTables(db);
    const io = vi.spyOn(databaseApi,"database");
    const previous = io.getMockImplementation();
    io.mockReturnValue(db);
    try {
      const recipes=freshIndexPorts(context),known=assemblyDependencies.get(source.text);
      if(known&&state instanceof FixtureAssembly) {
        for(const name of known.production)requiredProduction.add(name);
        for(const name of known.values)requiredValues.add(name);
        for(const port of recipes)state.recipes.set(port.name,port);
        // A requested observation is available before dispatch, without
        // constructing unrelated services merely to discover their callbacks.
        for(const requested of boundObservation?.requested??[])if(!requested.startsWith("projectToolHandlers."))state.get(requested.split(".")[0]);
      } else {
        const construct=()=>{for(const port of recipes)if(!suppliedServices.has(port.name))state.set(port.name,port.fresh());};
        if(state instanceof FixtureAssembly)state.construct(construct);else construct();
        assemblyDependencies.set(source.text,{production:Object.freeze([...requiredProduction]),values:Object.freeze([...requiredValues])});
      }
    }
    finally { if (wasMock) io.mockImplementation(previous!); else io.mockRestore(); }
  }
  if(!sharedState) {
    state.get("cfg");
    // This real constructor wires lifecycle admission/idle callbacks. Finish
    // that collaborator graph before any lifecycle integrity baseline is read.
    state.get("browserChoices");
  }
  for(const name of ["ASK_USER_REFUSED","WIDGET_REFUSED"])if(Object.hasOwn(canonical,name)) {
    const port=CASE_PORTS.find(port=>port.declaration.exportName===name)!;
    checkCasePort(port,canonical[name],undefined,()=>new Error(`FIXTURE_OVERRIDE_REFUSED ${name}`));
    state.set(name,canonical[name]);
  }
  if (Object.hasOwn(canonical,"cfg")) {
    const port = CASE_PORTS.find(port=>port.declaration.exportName==="cfg")!;
    checkCasePort(port,canonical.cfg,undefined,()=>new Error("FIXTURE_OVERRIDE_REFUSED cfg: JSON settings required"));
    Object.assign(state.get("cfg") as object,structuredClone(canonical.cfg));
  }
  // A complete service seeded by its real public writers may be retained.
  // Methods and prototypes are validated; maps and service-shaped literals
  // never acquire authority by being copied into fixture state.
  for (const [name, Constructor] of Object.entries(realServiceClasses)) {
    const supplied = canonical[name];
    if (supplied !== undefined && realService(name,supplied,Constructor,boundObservation)) state.set(name,supplied);
  }
  for(const [name,value]of state)state.set(name,observeFixtureState(boundObservation,name,value));
  // The fixture owns private state. Migrate legacy case premises by removing
  // their state keys, never by copying a supplied map or service method into
  // a real instance. Remaining unsupported premises stay visible as RED.
  for(const name of state.keys())delete canonical[name];
  if (!sharedState) {
  state.set("internalCapabilities",caps);
  if (!state.has("botOutsideWrites")) state.set("botOutsideWrites",new BotOutsideWrites(store,turnOutsideRead));
  state.set("registry",new ProviderRegistry([]));
  state.set("coordinationBudget",new CoordinationBudget(join(home,"coordination.json")));
  state.set("callSpeech",new CallSpeechCoordinator((session,botId) => callSourceVisible(store,session,botId)));
  state.set("turnAttribution",createTurnAttribution({
    stamp: context.production("turnAttribution.stamp"),
    unstamp: context.production("turnAttribution.unstamp"),
  }));
  cleanups.push(async () => {
    caps.revokeAll();
    const proofCaps=state.get("internalCapabilities");
    if (proofCaps instanceof InternalCapabilities) proofCaps.revokeAll();
    for (const value of state.values()) if (value instanceof Map || value instanceof Set) value.clear();
    (state.get("callSpeech") as CallSpeechCoordinator).invalidateAll();
    await (state.get("registry") as ProviderRegistry).disposeAll();
    store.stopSeqStamps();
  });
  state.set("store",store);
  state.set("ownerStartedRuns",new Map());
  }
  canonical.store = store;
  // Historical case scopes used a `{kind:"owner"}` placeholder. Admission now
  // captures the actual authenticated local principal and its real audience.
  delete canonical.connectorThread;
  // Retired positive fixture placeholders are removed, rather than authorized
  // as overrides. The extractor resolves and executes the real declarations.
  delete canonical.refuseAppChild;
  delete canonical.roomAskRefusedStatus;
  delete canonical.imageLibraryOwnerAudience;
  delete canonical.roomRequestStillOwnerAudience;
  for (const name of state.keys()) delete canonical[name];
  for(const name of ["ASK_USER_REFUSED","WIDGET_REFUSED"])if(Object.hasOwn(options.scope,name))canonical[name]=options.scope[name];
  const bootUnit=sharedState?.get("_fixtureBootUnit") as DispatchUnit|undefined;
  const requestEdges=new Set(["database","transaction","req","res","originalResponse","method","path","url","readBody","body","consumingHttpWriter","ASK_USER_REFUSED","WIDGET_REFUSED"]);
  // Ordinary request bindings reuse this world's actual boot collaborators.
  // A changed app I/O edge or additional observer retains the complete rebind
  // path, so its callbacks still see precisely that supplied I/O/observation.
  const requestOnly=!!bootUnit&&!options.admission&&canonical.database===state.get("_fixtureDatabase")&&canonical.transaction===state.get("_fixtureTransaction")&&Object.keys(canonical).every(name=>requestEdges.has(name));
  let verifier: Parameters<typeof installClaimVerifier>[0] = requestOnly?bootUnit!.verifyDecisionClaim:() => undefined;
  state.set("issueDecisionClaim",installClaimVerifier(proof => verifier(proof)));
  const ports: StatePort[] = privatePorts([...state.keys()].map(name => ({ name, fresh: () => state.get(name), current:()=>state.get(name), update:value=>{state.set(name,observeFixtureState(boundObservation,name,value));}, reason: "Fresh per-case real authority state; only extracted production writers seed records." })),state);
  const exposed = [...new Set(requestOnly?options.expose??[]:["verifyDecisionClaim","makeDecisionProvenance","beginInternalTurn","internalToken","recordOwnerStarted",...(options.expose ?? []),...requiredProduction,...requiredValues])];
  // Same-file authority functions always come from the selected production
  // declarations, never a previously extracted function from another scope.
  for (const name of exposed) if(!casePortFor(resolveCaseDeclaration(source,name)))delete canonical[name];
  const callback = (qualified: string): string => {
    const cached = callbackSources.get(source) ?? new Map<string,string>();
    callbackSources.set(source,cached);
    const previous = cached.get(qualified);
    if (previous !== undefined) return previous;
    const remember = (text:string):string => { cached.set(qualified,text);return text; };
    const parts = qualified.split(".");
    let selected: ts.Node | undefined = callbackRoots(source).get(parts[0]);
    for (const property of parts.slice(1)) {
      if (/^\$\d+$/.test(property)) {
        if (!selected || !(ts.isNewExpression(selected) || ts.isCallExpression(selected))) throw new Error(`FIXTURE_POLICY_CALLBACK_MISSING ${qualified}`);
        selected = selected.arguments?.[Number(property.slice(1))];
        continue;
      }
      while (selected && (ts.isParenthesizedExpression(selected) || ts.isAsExpression(selected) || ts.isSatisfiesExpression(selected))) selected = selected.expression;
      if (selected && (ts.isNewExpression(selected) || ts.isCallExpression(selected))) selected = selected.arguments?.find(ts.isObjectLiteralExpression);
      if (!selected || !ts.isObjectLiteralExpression(selected)) throw new Error(`FIXTURE_POLICY_CALLBACK_MISSING ${qualified}`);
      const found: ts.ObjectLiteralElementLike[] = selected.properties.filter(node => !!node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === property);
      if (found.length !== 1) throw new Error(`FIXTURE_POLICY_CALLBACK_MISSING ${qualified}`);
      selected = ts.isPropertyAssignment(found[0]) ? found[0].initializer : found[0];
    }
    if (selected && (ts.isArrowFunction(selected) || ts.isFunctionExpression(selected))) return remember(selected.getText(source));
    if (selected && ts.isMethodDeclaration(selected)) return remember(selected.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword) ? selected.getText(source).replace(/^async\s+/,"async function ") : `function ${selected.getText(source)}`);
    if (selected && (ts.isIdentifier(selected) || ts.isPropertyAccessExpression(selected))) return remember(selected.getText(source));
    throw new Error(`FIXTURE_POLICY_CALLBACK_MISSING ${qualified}`);
  };
  const productionProperties = exposed.map(name => name.includes(".") ? `${JSON.stringify(name)}: ${callback(name)}` : name).join(",");
  // The public production origin calculator consumes authenticated fixture
  // admission facts. Its actual dispatch writer seeds the second turn ledger
  // before beginInternalTurn, just as the ordinary engine dispatch does.
  const fixtureOrigin = `(botId,dispatchClaimId,ownerStarted,storedOrigin,appChild) => { const botOrigin = deriveBotTurnOrigin({botId,generation:dispatchClaimId,ownerStarted,storedOrigin,appChild,hops:[]}); ${origin} }`;
  // The real email call rechecks the audience registered at dispatch. Execute
  // both its actual calculation and writer; a fixture-supplied map or predicate
  // would bypass the same authority that the route is meant to exercise.
  const audience = requestOnly ? "" : sourceRecipe(source,"owner-surface",()=>{
    let calculation="",writer="";
    const visit=(node:ts.Node):void=>{
      if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>ts.isIdentifier(declaration.name)&&declaration.name.text==="surfacesForOwner"))calculation=node.getText(source);
      if(ts.isExpressionStatement(node)&&node.getText(source)==="ownerSurfacesByThread.set(threadId,surfacesForOwner);")writer=node.getText(source);
      ts.forEachChild(node,visit);
    };
    visit(source);
    if(!calculation||!writer)throw new Error("FIXTURE_AUDIENCE_WRITER_MISSING");
    return `${calculation}\n${writer}`;
  });
  const bootProperties=requestOnly?"":`, _fixtureInitializeOrigin:${fixtureOrigin}, _fixtureInitializeAudience:(threadId,opts)=>{${audience}}, reader:${reader},denials:${denials},producers:${producers}`;
  const expression = `(() => { ${[...pure].map(([name,text])=>`const ${name} = ${text};`).join("\n")} return ({dispatch: ${options.expression}${productionProperties?`, ${productionProperties}`:""}${bootProperties}}); })()`;
  // A legacy case's copied predicate is never rebound, even on refusal paths.
  // CASE_PORTS retains only reviewed edges; real module code resolves normally.
  const bindingSource=extractFunction({file,text:source.text,select:()=>"() => {}"}).source;
  for(const statement of bindingSource.statements) {
    const names:string[]=[];
    if((ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement))&&statement.name)names.push(statement.name.text);
    if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)
      if(ts.isIdentifier(declaration.name)&&declaration.initializer&&(ts.isArrowFunction(declaration.initializer)||ts.isFunctionExpression(declaration.initializer)))names.push(declaration.name.text);
    if(ts.isImportDeclaration(statement)&&statement.importClause) {
      const clause=statement.importClause;if(clause.name)names.push(clause.name.text);
      if(clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings))names.push(clause.namedBindings.name.text);
      if(clause.namedBindings&&ts.isNamedImports(clause.namedBindings))names.push(...clause.namedBindings.elements.map(item=>item.name.text));
    }
    for(const name of names)if(Object.hasOwn(canonical,name)&&!casePortFor(resolveCaseDeclaration(bindingSource,name)))delete canonical[name];
  }
  const extracted = extractFunction({file,text:source.text,select:()=>expression});
  const codeNames=new Set<string>();
  for(const statement of bindingSource.statements) {
    if((ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement))&&statement.name)codeNames.add(statement.name.text);
    if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)
      if(ts.isIdentifier(declaration.name)&&declaration.initializer&&(ts.isArrowFunction(declaration.initializer)||ts.isFunctionExpression(declaration.initializer)||ts.isIdentifier(declaration.initializer)||ts.isPropertyAccessExpression(declaration.initializer)))codeNames.add(declaration.name.text);
  }
  for(const statement of bindingSource.statements)if(ts.isImportDeclaration(statement)&&statement.importClause) {
    const clause=statement.importClause;if(clause.name)codeNames.add(clause.name.text);
    if(clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings))codeNames.add(clause.namedBindings.name.text);
    if(clause.namedBindings&&ts.isNamedImports(clause.namedBindings))for(const item of clause.namedBindings.elements)codeNames.add(item.name.text);
  }
  for(const name of Object.keys(canonical)) {
    const port=casePortFor(resolveCaseDeclaration(bindingSource,name));
    if(!port || port.category==="OBSERVER"&&!vi.isMockFunction(canonical[name]))throw overrideRefused(name,resolveCaseDeclaration(bindingSource,name),bindingSource);
  }
  const result = await extracted.preflight(canonical,{ports:ports.filter(port=>!codeNames.has(port.name))});
  const value: DispatchUnit = result.value;
  const productionUnit=requestOnly?bootUnit!:value;
  state.set("_fixtureProductionUnit",productionUnit);
  if(!sharedState)state.set("_fixtureBootUnit",value);
  if(boundObservation?.requested.has("botCalls.warn")&&!boundObservation.bound.has("botCalls.warn")) {
    const real=value["botCalls.warn"];if(typeof real!=="function")throw new Error("FIXTURE_POLICY_DEPENDENCY_MISSING botCalls.warn");
    const spy=vi.fn(real),guarded=observePort("botCalls.warn",spy,real),owner=Object.freeze({warn:guarded});
    const observed=new Map<string,Function>([["botCalls.warn",guarded]]);state.set("_fixtureObservedProduction",observed);
    boundObservation.bound.set("botCalls.warn",{owner,guarded,view:observationView(spy,"botCalls.warn")});
  }
  for (const name of requiredProduction) {
    if (typeof productionUnit[name] !== "function") throw new Error(`FIXTURE_POLICY_DEPENDENCY_MISSING ${name}`);
  }
  verifier = value.verifyDecisionClaim??productionUnit.verifyDecisionClaim;
  installProvenanceReader(productionUnit.reader);
  const admission = options.admission;
  if (admission?.provenance) {
    const provenanceGeneration = admission.provenanceGeneration ?? admission.generation;
    const ownerTyped = provenanceGeneration === admission.generation && admission.roomOwnerOnly && admission.initiator.k === "owner-typed";
    const provenance = value.makeDecisionProvenance(admission.botId,admission.threadId,provenanceGeneration,admission.initiator,admission.roomOwnerOnly);
    value._fixtureInitializeOrigin(admission.botId,admission.generation,ownerTyped,ownerTyped?"owner":undefined,!admission.roomOwnerOnly);
    value.beginInternalTurn(provenance,admission.botId,admission.threadId,admission.generation,claim?.depth ?? 0,claim?.skillAuthoring === true,
      undefined,undefined,!admission.roomOwnerOnly,admission.roomOwnerOnly,ownerTyped);
    value._fixtureInitializeAudience(admission.threadId,{origin:ownerTyped?"desktop":"unproven",notOwnerAudience:!admission.roomOwnerOnly});
    if (ownerTyped) value.recordOwnerStarted(state.get("ownerStartedRuns"),admission.generation,admission.botId);
  }
  if (options.preserveCapabilities && callerCaps) {
    // Registration uses an independent real registry because begin() retires
    // prior tokens. The caller's existing proof must remain the same object.
    // Both registries enforce real class methods; no check is replaced. The
    // fresh owner/provenance records above come only from beginInternalTurn.
    state.set("internalCapabilities",callerCaps);
    // The real owner row starts with no tokens. Populate its agents token
    // through the production writer against the caller's still-live registry.
    if (admission?.provenance) value.internalToken(admission.botId,admission.threadId,admission.generation,"agents");
  } else if (admission?.provenance && claim) {
    if (claim.kind === "turn-release") {
      if (!releaseControl) throw new Error("FIXTURE_RELEASE_CONTROL_MISSING");
      headers.authorization = `Bearer ${caps.mintReleaseControl(releaseControl.binding,releaseControl.instanceId)}`;
    } else headers.authorization = `Bearer ${value.internalToken(claim.botId,claim.threadId,claim.generation,claim.kind ?? requiredInternalKind(String(canonical.path)))}`;
  }
  // Diagnostics identify resolved private ports without exposing their values.
  // The one retained assertion view is a fresh deep snapshot, never a live map.
  for(const [name,resolution]of extracted.free)if(resolution.step==="state" || !Object.hasOwn(result.bound,name) && resolution.step==="import")Object.defineProperty(result.bound,name,{
    enumerable:true,get:()=>name==="decisionAuthorities"?diagnosticSnapshot(state.get(name)):undefined,
  });
  const publicUnit:DispatchUnit=Object.create(null);
  for(const [name,member]of Object.entries({...productionUnit,...value}))if(typeof member==="function"&&name!=="_fixtureInitializeOrigin"&&name!=="_fixtureInitializeAudience")publicUnit[name]=member;
  publicUnit.reader=Object.freeze(productionUnit.reader);
  publicUnit.denials=Object.freeze(productionUnit.denials);
  Object.freeze(publicUnit);
  const binding={dispatch:value.dispatch,bound:result.bound,free:extracted.free,unit:publicUnit};
  privateStates.set(binding,state);return binding;
}

// Analyze immutable code at fixture-module load; no initializer or policy is
// executed. Cases still admit every fresh port/value and run the real code.
preloadDeclarationAnalysis(new URL("../index.ts",import.meta.url));
