// Owner: sc-safety-rd (isolated service state and constructor recipes).
// Owner: production index callbacks and imported classes (all policy).
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexSourceData } from "./internal-source-data.ts";
import { UnifiedBrowserController } from "../browser-control.ts";
import { BrowserModeTransition } from "../browser-mode-transition.ts";
import { BrowserLifecycleGate } from "../browser-lifecycle-gate.ts";
import { SetupAtSettle } from "../setup-at-settle.ts";
import { OwnerLimitContinuations,LimitApplications } from "../owner-limit-continuation.ts";
import { BotOutsideWrites } from "../bot-outside-writes.ts";
import { turnOutsideRead } from "../email/external-marks.ts";
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
    port("cardMilestones",()=>new Map<string,number>()),
    port("ledgerLeasesByAdmission",()=>new WeakMap<object,unknown>()),
    port("ledgerProviderInstances",()=>new WeakMap<object,string>()),
    port("recallWaits",()=>new Map<string,AbortController>()),
    port("limitApplications",()=>new LimitApplications(context.database)),
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
