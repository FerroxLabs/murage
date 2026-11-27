// Owner: sc-safety-rd (isolated service state and constructor recipes).
// Owner: production index callbacks and imported classes (all policy).
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexSourceData } from "./internal-source-data.ts";
import { UnifiedBrowserController } from "../browser-control.ts";
import { BrowserModeTransition } from "../browser-mode-transition.ts";
import { BrowserLifecycleGate } from "../browser-lifecycle-gate.ts";
import { createOwnerSettlementRegistry } from "../skill-switch-settlement.ts";
import { createSkillSwitchExecutor } from "../skill-switch-executor.ts";
import { SetupAtSettle } from "../setup-at-settle.ts";
import { OwnerLimitContinuations,LimitApplications } from "../owner-limit-continuation.ts";
import { BotOutsideWrites } from "../bot-outside-writes.ts";
import { turnOutsideRead } from "../email/external-marks.ts";
import { cardAttention } from "../approval-attention.ts";
import { createOwnerStopTerminals } from "../owner-stop-terminal.ts";
import { bootSettled } from "../after-listen.ts";
import { ConversationDeletions } from "../conversation-deletion.ts";
import { AttachmentList } from "../storage-attachments.ts";
import { guardedWriter } from "../database.ts";
import { createOwnerPresence } from "../owner-presence.ts";
import type { InternalPortContext } from "./internal-port-context.ts";
import type { StatePort } from "./source-extract.ts";
import { registerPortConstructor } from "./port-integrity.ts";

// Capture imported constructor and ancestor methods before any case hook.
for (const Constructor of [UnifiedBrowserController, BrowserModeTransition, BrowserLifecycleGate, SetupAtSettle, BotOutsideWrites, OwnerLimitContinuations,LimitApplications]) if (typeof Constructor === "function") registerPortConstructor(Constructor);

let source: ts.SourceFile | undefined;
const cleanups: Array<()=>void|Promise<void>>=[];
export async function closeDispatchStatePorts(): Promise<void> {
  for(const close of cleanups.splice(0).reverse()) await close();
}
/** Select callback identities, never evaluate the initializer. Data properties
 * must be explicitly supplied by the recipe; unknown source shapes refuse. */
function callbacks<T extends object>(context: InternalPortContext,name:string,data:Partial<T>):T {
  source ??= ts.createSourceFile("index.ts",readFileSync(new URL("../index.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true);
  let initializer:ts.Expression|undefined;
  for(const statement of source.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)
    if(ts.isIdentifier(declaration.name)&&declaration.name.text===name)initializer=declaration.initializer;
  const object=initializer&&(ts.isNewExpression(initializer)||ts.isCallExpression(initializer))?initializer.arguments?.find(ts.isObjectLiteralExpression):undefined;
  if(!object)throw new Error(`FIXTURE_POLICY_CALLBACK_MISSING ${name}`);
  const result:Record<string,unknown>={...data};
  for(const property of object.properties){
    if(!property.name||!(ts.isIdentifier(property.name)||ts.isStringLiteral(property.name)))throw new Error(`FIXTURE_POLICY_CALLBACK_MISSING ${name}`);
    const key=property.name.text;if(Object.hasOwn(result,key))continue;
    if(ts.isPropertyAssignment(property)&&(ts.isArrowFunction(property.initializer)||ts.isFunctionExpression(property.initializer)))result[key]=context.production(`${name}.${key}`);
    else if(ts.isMethodDeclaration(property))result[key]=context.production(`${name}.${key}`);
    else if(ts.isShorthandPropertyAssignment(property))result[key]=context.production(property.name.text);
    else if(ts.isPropertyAssignment(property)&&ts.isIdentifier(property.initializer))result[key]=context.production(property.initializer.text);
    else throw new Error(`FIXTURE_POLICY_CALLBACK_DATA_MISSING ${name}.${key}`);
  }
  return result as T;
}

export function dispatchStatePorts(context:InternalPortContext):StatePort[]{
  const port=<T>(name:string,create:()=>T,close?:(value:T)=>void|Promise<void>):StatePort=>({name,reason:"Complete real service with extracted production callbacks and private fixture storage.",fresh:()=>{
    const value=create();context.state.set(name,value);if(close)cleanups.push(()=>close(value));return value;
  }});
  const required=<T>(name:string):T=>{if(!context.state.has(name))throw new Error(`FIXTURE_SCOPE_UNRESOLVED ${name}`);return context.state.get(name) as T;};
  return[
    port("skillOwnerSettlement", createOwnerSettlementRegistry),
    port("skillSetupFlights", () => new Set<string>()),
    port("executeSkillSwitch", () => createSkillSwitchExecutor(
      required<ReturnType<typeof createOwnerSettlementRegistry>>("skillOwnerSettlement"),
      { automatic: context.production("skillAutomaticPolicy"), owner: context.production("skillOwnerPolicy") },
    )),
    port("cardMilestones",()=>new Map<string,number>()),
    // 1.0.22 presence-restart: the module-level owner presence and the restart-keep state are real instances/containers
    // (no warm pool is wired in the fixture, so presence has no away listeners); appClosing starts open as at boot.
    port("ownerPresence",()=>createOwnerPresence()),
    port("ownerTurnPresence",()=>new Map<string,()=>void>()),
    port("ownerTurnsKeptForNextStart",()=>new Set<string>()),
    port("preparationHolds",()=>new Set<string>()),
    port("startsKeptAtClose",()=>new Set<string>()),
    port("queuedOwnerStartsPending",()=>new Map<string,{botId:string;seqs:number[]}>()),
    port("ownerSendsStarting",()=>new Map<number,string>()),
    port("appClosing",()=>false),
    port("ENGINE_START_WAIT_MS",()=>indexSourceData("ENGINE_START_WAIT_MS")),
    port("ledgerLeasesByAdmission",()=>new WeakMap<object,unknown>()),
    port("ledgerProviderInstances",()=>new WeakMap<object,string>()),
    port("recallWaits",()=>new Map<string,AbortController>()),
    // design1019-approval-attention: the module-level attention service is the real cardAttention, its ports the
    // production callbacks selected from index.ts (never the initializer); scopes and cards live in this fixture only.
    port("approvalAttention",()=>cardAttention(callbacks<Parameters<typeof cardAttention>[0]>(context,"approvalAttention",{}))),
    // 1.0.20 stop-chip: the module-level owner Stop terminal is the real createOwnerStopTerminals with the production callbacks from index.ts.
    port("stopWithoutEngineTurn",()=>createOwnerStopTerminals(callbacks<Parameters<typeof createOwnerStopTerminals>[0]>(context,"stopWithoutEngineTurn",{}))),
    port("limitApplications",()=>new LimitApplications(context.database)),
    // claimsmalls Stop settlement: finishDirectAttemptEffects retries a generation's owed writes by a real Set, wakes the
    // queued sends through the real guarded writer over the extracted drainQueuedSends, and asks the real deletion service
    // (production callbacks, this fixture's data directory and database) whether the thread is being deleted.
    port("directEffectRetries",()=>new Set<string>()),
    port("wakeAfterDirectCleanup",()=>guardedWriter("direct-attempt-cleanup",context.production("drainQueuedSends"))),
    port("conversationDeletions",()=>new ConversationDeletions(callbacks<ConstructorParameters<typeof ConversationDeletions>[0]>(context,"conversationDeletions",{
      dataDir:context.dataDir,database:context.database,bootSettled,
    })),deletions=>deletions.dispose()),
    port("DELETION_HOLD_WAIT_MS",()=>indexSourceData("DELETION_HOLD_WAIT_MS")),
    port("storageAttachmentList",()=>new AttachmentList(callbacks<ConstructorParameters<typeof AttachmentList>[0]>(context,"storageAttachmentList",{
      dir:join(context.dataDir,"attachments"),database:context.database,
    }))),
    port("ownerLimitContinuations",()=>new OwnerLimitContinuations(context.production("ownerLimitSnapshotCurrent"))),
    port("routineRequestSourceSchema",()=>indexSourceData("routineRequestSourceSchema")),
    port("routineRequestEnvelopeSchema",()=>indexSourceData("routineRequestEnvelopeSchema")),
    port("webhookRequestEnvelopeSchema",()=>indexSourceData("webhookRequestEnvelopeSchema")),
    port("botOutsideWrites",()=>new BotOutsideWrites(context.store,turnOutsideRead,{
      settled:context.production("botOutsideWrites.settled"),
      reviewNeeded:context.production("botOutsideWrites.reviewNeeded"),
      reviewed:context.production("botOutsideWrites.reviewed"),
      dropped:context.production("botOutsideWrites.dropped"),
      dispatch:context.production("botOutsideWrites.dispatch"),
      validate:context.production("botOutsideWrites.validate"),
    })),
    port("setupAtSettle",()=>new SetupAtSettle(required<BotOutsideWrites>("botOutsideWrites").ledger)),
    port("unifiedBrowser",()=>new UnifiedBrowserController(callbacks<ConstructorParameters<typeof UnifiedBrowserController>[0]>(context,"unifiedBrowser",{
      stateFile:join(context.dataDir,"browser-control.json"),ownerMigration:{realm:"original-installation",cloudHome:false},
      createNative:()=>{throw new Error("FIXTURE_IO_NOT_CONFIGURED native browser");},
    } satisfies Partial<ConstructorParameters<typeof UnifiedBrowserController>[0]>)),value=>value.close()),
    port("browserChoices",()=>new BrowserModeTransition(callbacks<ConstructorParameters<typeof BrowserModeTransition>[0]>(context,"browserChoices",{
      lifecycle:required<BrowserLifecycleGate>("browserLifecycle"),sessions:required<UnifiedBrowserController>("unifiedBrowser").sessionGate,
    }))),
  ];
}
