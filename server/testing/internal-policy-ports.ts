// Owner: sc-safety-rd (isolated policy-service construction and teardown).
// Owner: production modules/index.ts (all policy decisions and state writers).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnWriteHolds, type OwnWriteHost } from "../own-write-holds.ts";
import { ownWriteCommit } from "../outside-own.ts";
import { currentRestoreGeneration } from "../send-store.ts";
import { BotCallAuthority } from "../bot-call-authority.ts";
import { createBotCallsRuntime, type BotCallsRuntimeDeps } from "../bot-calls-runtime.ts";
import { initializeBotCalls } from "../bot-calls-schema.ts";
import { createCalendarCheck, type CalendarCheckDeps } from "../bot-calls-calendar.ts";
import { BrowserTurnExecution } from "../browser-turn-execution.ts";
import { IndependentThreadRuns, MAX_CONCURRENT_BOT_THREADS } from "../independent-thread-runs.ts";
import { ConnectedAppReceipts } from "../connected-app-receipts.ts";
import { SqliteReceiptStore } from "../connected-app-journal.ts";
import { createWorkAdmission, type WorkAdmission, type WorkAdmissionDeps } from "../work-admission.ts";
import { createProjectBudgetGate } from "../project-budgets.ts";
import { createProjectCardExecutor } from "../project-card-executor.ts";
import { PROJECT_CARD_RUNS_INSTALL_CAP } from "../project-defaults.ts";
import { type CompletionHooks } from "../room-requests.ts";
import { WriterRootClaims } from "../writer-roots.ts";
import { initializeMobilePush } from "../mobile-push-store.ts";
import { PushOutbox } from "../mobile-push-outbox.ts";
import type { BotRecord } from "../store.ts";
import type { StatePort } from "./source-extract.ts";
import type { InternalPortContext } from "./internal-port-context.ts";
import { removeTempDir } from "./cleanup.ts";
import { registerPortConstructor } from "./port-integrity.ts";

// Capture imported constructor and ancestor methods before any case hook.
for (const Constructor of [OwnWriteHolds, BotCallAuthority, BrowserTurnExecution, IndependentThreadRuns, MAX_CONCURRENT_BOT_THREADS, ConnectedAppReceipts, SqliteReceiptStore, PROJECT_CARD_RUNS_INSTALL_CAP, WriterRootClaims, PushOutbox]) if (typeof Constructor === "function") registerPortConstructor(Constructor);

const cleanups:Array<()=>void|Promise<void>>=[];
export async function closePolicyFixturePorts():Promise<void>{
  const errors:unknown[]=[];
  for(const close of cleanups.splice(0).reverse())try{await close();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,"FIXTURE_POLICY_CLEANUP_FAILED");
}
const unavailable=(edge:string):never=>{throw new Error(`FIXTURE_IO_NOT_CONFIGURED ${edge}`);};

/** Full production instances. Cross-service ownership uses the same context
 * state as the extracted dispatcher. production() registers real index.ts
 * declarations during construction, then resolves those declarations only
 * after preflight has validated the complete unit. No initializer is read or
 * evaluated here, and no authority method is substituted by a fixture stub.
 */
export function policyFixturePorts(context:InternalPortContext):StatePort[]{
  const instances=new Map<string,unknown>();
  const value=<T>(name:string):T=>{
    const found=context.state.get(name)??instances.get(name);
    if(found===undefined)throw new Error(`FIXTURE_POLICY_STATE_MISSING ${name}`);
    return found as T;
  };
  const port=<T>(name:string,create:()=>T,reason:string,close?:(instance:T)=>void|Promise<void>):StatePort=>({name,reason,fresh:()=>{
    if(instances.has(name))return instances.get(name);
    const instance=create();instances.set(name,instance);context.state.set(name,instance);
    if(close)cleanups.push(()=>close(instance));return instance;
  }});
  const directRuns=()=>{
    const existing=context.state.get("directRuns");
    if(existing instanceof IndependentThreadRuns)return existing as IndependentThreadRuns<BotRecord>;
    const runs=new IndependentThreadRuns<BotRecord>();context.state.set("directRuns",runs);return runs;
  };
  const validOwn=context.production<OwnWriteHost["valid"]>("validOwnWrite");
  const prepareOwn=context.production<OwnWriteHost["prepare"]>("prepareOwnWrite");
  const projectOwn=context.production<OwnWriteHost["project"]>("ownWriteHolds.project");
  const deliverOwn=context.production<NonNullable<OwnWriteHost["deliver"]>>("ownWriteHolds.deliver");
  const rootClaims=new WriterRootClaims();
  let workAdmission:WorkAdmission;
  const completionHooks=context.value<CompletionHooks>("roomCompletionHooks");
  const makeAdmission=()=>workAdmission??=createWorkAdmission({
    restoreReview:context.production<WorkAdmissionDeps["restoreReview"]>("workAdmission.restoreReview"),
    flags:context.production<WorkAdmissionDeps["flags"]>("workAdmission.flags"),
    threadRunning:context.production<WorkAdmissionDeps["threadRunning"]>("workAdmission.threadRunning"),
    speakingInRoom:context.production<WorkAdmissionDeps["speakingInRoom"]>("workAdmission.speakingInRoom"),
    directThreads:context.production<WorkAdmissionDeps["directThreads"]>("workAdmission.directThreads"),
    maxThreads:MAX_CONCURRENT_BOT_THREADS,installCardCap:PROJECT_CARD_RUNS_INSTALL_CAP,
    rootCounters:context.production<WorkAdmissionDeps["rootCounters"]>("workAdmission.rootCounters"),
    askWouldDeadlock:context.production<WorkAdmissionDeps["askWouldDeadlock"]>("workAdmission.askWouldDeadlock"),
    reachable:context.production<WorkAdmissionDeps["reachable"]>("workAdmission.reachable"),
    dependencyOpen:context.production<WorkAdmissionDeps["dependencyOpen"]>("workAdmission.dependencyOpen"),
    authorize:context.production<NonNullable<WorkAdmissionDeps["authorize"]>>("workAdmission.authorize"),
    spendHold:context.production<NonNullable<WorkAdmissionDeps["spendHold"]>>("workAdmission.spendHold"),
    claimWriterRoot:context.production<WorkAdmissionDeps["claimWriterRoot"]>("workAdmission.claimWriterRoot"),
    botName:context.production<NonNullable<WorkAdmissionDeps["botName"]>>("workAdmission.botName"),now:Date.now,
  });
  return [
    port("botCallAuthority",()=>new BotCallAuthority(context.store),"Full real bot-call approval authority against the case's complete Store."),
    port("browserExecutions",()=>new BrowserTurnExecution(directRuns()),"Full real browser reservation and suspension policy sharing the actual direct-run registry."),
    port("connectedAppReceipts",()=>{
      const directory=mkdtempSync(join(tmpdir(),"fixture-connected-receipts-"));cleanups.push(()=>removeTempDir(directory));
      return new ConnectedAppReceipts(Date.now,new SqliteReceiptStore(join(directory,"receipts.db")),(thread,generation)=>context.capabilities.providerTurnOf(thread,generation));
    },"Full receipt policy with a private real SQLite journal; journal closes every operation."),
    port("ownWriteHolds",()=>new OwnWriteHolds({
      db:context.database,restoreToken:()=>currentRestoreGeneration(context.database()),valid:validOwn,prepare:prepareOwn,stamp:keys=>ownWriteCommit(keys,200),
      project:projectOwn,deliver:deliverOwn,
    }),"Full durable own-write state machine; validation and preparation are the actual extracted production functions."),
    port("writerRootClaims",()=>rootClaims,"Real shared writer-root claim registry used by the actual admission callback."),
    port("workAdmission",makeAdmission,"Full production admission arbiter with real roster, thread, writer-root and source authorization checks.",instance=>{for(const claim of instance.liveTurns({}))claim.release();}),
    port("projectBudgetGate",()=>{
      const admission=makeAdmission();context.state.set("workAdmission",admission);
      type Hooks=NonNullable<Parameters<typeof createProjectBudgetGate>[1]>;
      const gate=createProjectBudgetGate(context.database(),{
        enabled:context.production<NonNullable<Hooks["enabled"]>>("projectBudgetGate.enabled"),
        running:context.production<NonNullable<Hooks["running"]>>("projectBudgetGate.running"),
        line:context.production<NonNullable<Hooks["line"]>>("projectBudgetGate.line"),
        changed:context.production<NonNullable<Hooks["changed"]>>("projectBudgetGate.changed"),
        stop:context.production<NonNullable<Hooks["stop"]>>("projectBudgetGate.stop"),
      });admission.setBudgetGate(gate);return gate;
    },"Real SQLite budget policy including all live/pending usage and budget-driven Stop; installed into the real arbiter."),
    port("projectCardExecutor",()=>{
      type Deps=Parameters<typeof createProjectCardExecutor>[0];
      return createProjectCardExecutor({
        db:context.database,admission:makeAdmission(),now:Date.now,
        ready:context.production<NonNullable<Deps["ready"]>>("projectCardExecutor.ready"),
        redeliver:context.production<NonNullable<Deps["redeliver"]>>("projectCardExecutor.redeliver"),
        authorize:context.production<NonNullable<Deps["authorize"]>>("projectCardExecutor.authorize"),
        open:context.production<Deps["open"]>("projectCardExecutor.open"),
        context:context.production<Deps["context"]>("projectCardExecutor.context"),
        usable:context.production<Deps["usable"]>("projectCardExecutor.usable"),
        desk:context.production<Deps["desk"]>("projectCardExecutor.desk"),
        writerRoot:context.production<Deps["writerRoot"]>("projectCardExecutor.writerRoot"),
        get hooks(){return completionHooks();},
        changed:context.production<Deps["changed"]>("projectCardExecutor.changed"),
        wake:context.production<NonNullable<Deps["wake"]>>("projectCardExecutor.wake"),
        start:()=>unavailable("project card engine start"),
      });
    },"Full card executor with actual admission, generation, owner audience and writer-root checks; engine launch is an external fail-closed edge.",instance=>instance.stop()),
    port("botCalls",()=>{
      initializeBotCalls(context.database());initializeMobilePush(context.database());
      const outbox=()=>value<PushOutbox>("pushOutbox");
      const deps:BotCallsRuntimeDeps={db:context.database,outbox:{ringCall:input=>outbox().ringCall(input),noteCall:input=>outbox().noteCall(input),resolveCall:(...args)=>outbox().resolveCall(...args),dropCallNotes:bot=>outbox().dropCallNotes(bot),sendNow:id=>outbox().sendNow(id)},
        card:context.production<BotCallsRuntimeDeps["card"]>("botCalls.card"),
        warn:context.production<NonNullable<BotCallsRuntimeDeps["warn"]>>("botCalls.warn"),
        world:{
          quietHours:context.production<BotCallsRuntimeDeps["world"]["quietHours"]>("botCalls.world.quietHours"),
          noLimits:context.production<NonNullable<BotCallsRuntimeDeps["world"]["noLimits"]>>("botCalls.world.noLimits"),
          voiceReady:context.production<BotCallsRuntimeDeps["world"]["voiceReady"]>("botCalls.world.voiceReady"),
          ringingDevice:context.production<BotCallsRuntimeDeps["world"]["ringingDevice"]>("botCalls.world.ringingDevice"),
          factValid:context.production<BotCallsRuntimeDeps["world"]["factValid"]>("botCalls.world.factValid"),
          calendar:createCalendarCheck({
            mode:context.production<CalendarCheckDeps["mode"]>("botCalls.world.calendar.$0.mode"),
            inventory:async()=>unavailable("calendar inventory network"),relay:async()=>unavailable("calendar provider network"),
          }),
        },
        hint:context.production<BotCallsRuntimeDeps["hint"]>("botCalls.hint"),
        threadRunning:context.production<BotCallsRuntimeDeps["threadRunning"]>("botCalls.threadRunning"),
        senderOf:context.production<BotCallsRuntimeDeps["senderOf"]>("botCalls.senderOf"),
        turnEndedAt:context.production<BotCallsRuntimeDeps["turnEndedAt"]>("botCalls.turnEndedAt"),
        // This fixture has no outbound push transport or background send timer.
        startOutbox:()=>{},
      };
      return createBotCallsRuntime(deps);
    },"Full call policy/runtime with real saved settings, provenance, durable machine and card writer; network sends remain explicitly unconfigured.",instance=>instance.stop()),
  ];
}
