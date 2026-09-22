import { database } from "./database.ts";
import { isWorkspaceOwner } from "./human-principals.ts";
import { readProcedureBundle } from "./procedure-bundles.ts";
import { backgroundMemoryAudience } from "./memory/policy.ts";
import { procedureCandidateHash, validateProcedureEvaluationReceipt, type ProcedureEvaluationReceipt, type ProcedureReviewHost, type ProcedureReviewSnapshot, type ProcedureReviewTarget } from "./memory/procedure-review.ts";
import { routineInstructionRevision, type Routine, type RoutineInstructionPromotion, type RoutineManager } from "./routines.ts";
import type { Store } from "./store.ts";

type Audience = NonNullable<ReturnType<typeof backgroundMemoryAudience>>;
type Evidence = NonNullable<Routine["instructionHistory"]>[number]["evidence"];
export interface ProcedureHostOptions {
  store: Store;
  routines: () => RoutineManager | null;
  validateEvidence(audience: Audience, evidence: NonNullable<Evidence>): boolean;
  skills: {
    current(botId: string, name: string, audience: Audience): { revision: string; sha256: string } | null;
    publish(snapshot: ProcedureReviewSnapshot, receipt: ProcedureEvaluationReceipt, audience: Audience): void;
    wasPublished(snapshot: ProcedureReviewSnapshot, receipt: ProcedureEvaluationReceipt, audience: Audience): boolean;
  };
  evaluate?: ProcedureReviewHost["evaluate"];
  automaticFailureRetry?:boolean;
  evaluatorAvailable?:ProcedureReviewHost["evaluatorAvailable"];
  evaluationReadiness?:ProcedureReviewHost["evaluationReadiness"];
  onPublished?:(snapshot:ProcedureReviewSnapshot,receipt:ProcedureEvaluationReceipt,current:{revision:string;sha256:string})=>void;
}
const routineBase = (routine: Routine) => JSON.stringify([routineInstructionRevision(routine), routine.updatedAt]);
const handles = (snapshot: ProcedureReviewSnapshot) => snapshot.evidence.map(({ kind, id, revision, scopeId }) => ({ kind, id, revision, scopeId }));

/** The production bridge selects artifacts from trusted task pins. Neither the
 * evaluator nor a memory-tool caller chooses a bot, audience or publication API. */
export function createProcedureReviewHost(options: ProcedureHostOptions) {
  const store = options.store;
  const roster = () => ({ bots: store.bots, groups: store.groups });
  const audience = (botId: string, threadId: string) => {
    try { return backgroundMemoryAudience(botId, threadId, roster()); } catch { return null; }
  };
  const contextsForThread = (threadId: string): Audience[] => {
    const room = store.groups.find(group => group.threadId === threadId || group.tasks?.some(task => task.threadId === threadId));
    const bots = room ? store.bots.filter(bot => room.memberIds.includes(bot.id)) : store.bots.filter(bot => bot.threadId === threadId || bot.tasks?.some(task => task.threadId === threadId));
    return bots.map(bot => audience(bot.id, threadId)).filter((value): value is Audience => value !== null);
  };
  const contextsForScope = (scopeId: string): Audience[] => {
    const scope = database().prepare("SELECT kind,owner_key FROM memory_scopes WHERE id=?").get(scopeId);
    if (!scope) return [];
    if (scope.kind === "conversation") return contextsForThread(String(scope.owner_key));
    if (scope.kind === "room") {
      const room = store.groups.find(group => group.id === scope.owner_key);
      return room ? contextsForThread(room.threadId) : [];
    }
    const result: Audience[] = [];
    for (const bot of store.bots) {
      if (scope.kind === "bot" && bot.id !== scope.owner_key) continue;
      for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)])) {
        const context = audience(bot.id, threadId);
        if (context?.scopeIds.includes(scopeId)) { result.push(context); break; }
      }
    }
    return result;
  };
  const pinFor = (context: Audience) => {
    const room = store.groups.find(group => group.threadId === context.threadId || group.tasks?.some(task => task.threadId === context.threadId));
    return room ? store.groupTaskByThread(room.id, context.threadId)?.procedurePins?.[context.botId] : store.taskByThread(context.botId, context.threadId)?.procedurePin;
  };
  const evidenceCurrent = (context: Audience, evidence: Evidence) => {
    try { return options.validateEvidence(context, evidence ?? []); } catch { return false; }
  };
  const routineContexts = (routine: Pick<Routine, "botId" | "groupId" | "target">) => {
    if (routine.target === "room-goal") {
      const room = store.groups.find(group => group.id === routine.groupId);
      return room ? contextsForThread(room.threadId).filter(context => context.botId === routine.botId) : [];
    }
    const bot = store.bot(routine.botId);
    if (!bot) return [];
    for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)])) {
      const context = audience(bot.id, threadId);
      if (context && isWorkspaceOwner(context.humanPrincipal) && context.audienceKey === `bot:${bot.id}:owner`) return [context];
    }
    return [];
  };
  let authorizedRoutine: { snapshot: ProcedureReviewSnapshot; receipt: ProcedureEvaluationReceipt } | undefined;
  const currentInstructionRevision=(target:ProcedureReviewTarget)=>{
    const context=audience(target.ownerId,target.threadId);if(!context||context.scopeId!==target.scopeId)throw Error("PROCEDURE_TARGET_STALE");
    if(target.kind==="skill"){const current=options.skills.current(target.ownerId,target.artifactId,context);if(!current)throw Error("PROCEDURE_TARGET_STALE");return current;}
    const routine=options.routines()?.listRoutines().find(item=>item.id===target.artifactId);
    if(target.kind!=="routine"||!routine||routine.botId!==target.ownerId)throw Error("PROCEDURE_TARGET_STALE");
    return {revision:routineBase(routine),sha256:procedureCandidateHash(routine.prompt)};
  };
  const host: ProcedureReviewHost = {
    get automaticFailureRetry(){return options.automaticFailureRetry;},
    resolveTargets(trigger) {
      const threads = new Set<string>(trigger.threadId ? [trigger.threadId] : []);
      for (const item of trigger.evidence) {
        if (item.kind === "source") {
          const source = database().prepare("SELECT thread_id FROM memory_sources WHERE id=? AND revision=?").get(item.id, item.revision);
          if (source) threads.add(String(source.thread_id));
        }
      }
      const contexts = threads.size ? [...threads].flatMap(contextsForThread) : contextsForScope(trigger.scopeId);
      const targets = new Map<string, ProcedureReviewTarget>();
      for (const context of contexts) {
        if (!context.scopeIds.includes(trigger.scopeId)) continue;
        const pin = pinFor(context);
        if (!pin) continue; // Legacy/no-procedure tasks cannot supply an immutable target.
        const bundle = readProcedureBundle(context.botId, context.threadId, pin);
        for (const skill of bundle.imported) {
          if (!skill.editable || !skill.revision) continue;
          const current = options.skills.current(context.botId, skill.name, context);
          if (!current || current.revision !== skill.revision || current.sha256 !== skill.sha256) continue;
          const target: ProcedureReviewTarget = { kind: "skill", scopeId: context.scopeId, ownerId: context.botId, artifactId: skill.name, baseRevision: skill.revision, threadId: context.threadId, bundleId: pin.bundleId };
          targets.set(JSON.stringify([target.kind, target.scopeId, target.ownerId, target.artifactId, target.baseRevision]), target);
        }
        if (bundle.routine) {
          const routine = options.routines()?.listRoutines().find(item => item.id === bundle.routine!.id);
          if (routine && routine.botId === context.botId && routineInstructionRevision(routine) === bundle.routine.instructionRevision && routineContexts(routine).some(item => item.scopeId === context.scopeId)) {
            const target: ProcedureReviewTarget = { kind: "routine", scopeId: context.scopeId, ownerId: context.botId, artifactId: routine.id, baseRevision: routineBase(routine), threadId: context.threadId, bundleId: pin.bundleId };
            targets.set(JSON.stringify([target.kind, target.scopeId, target.artifactId, target.baseRevision]), target);
          }
        }
      }
      return [...targets.values()];
    },
    isTargetCurrent(target) {
      if (target.kind === "memory-policy") return false;
      const context = audience(target.ownerId, target.threadId);
      if (!context || context.scopeId !== target.scopeId) return false;
      const pin = pinFor(context);
      if (!pin || pin.bundleId !== target.bundleId) return false;
      try { readProcedureBundle(target.ownerId, target.threadId, pin); } catch { return false; }
      if (target.kind === "skill") return options.skills.current(target.ownerId, target.artifactId, context)?.revision === target.baseRevision;
      const routine = options.routines()?.listRoutines().find(item => item.id === target.artifactId);
      return Boolean(routine && routine.botId === target.ownerId && routineBase(routine) === target.baseRevision && routineContexts(routine).some(item => item.scopeId === target.scopeId));
    },
    canReadEvidence(reviewScopeId, evidenceScopeId, evidence) {
      return contextsForScope(reviewScopeId).some(context => evidenceCurrent(context, [{ ...evidence, scopeId: evidenceScopeId }]));
    },
    canPublish(snapshot) {
      const context = audience(snapshot.target.ownerId, snapshot.target.threadId);
      return Boolean(context && context.scopeId === snapshot.target.scopeId && evidenceCurrent(context, handles(snapshot)) && host.isTargetCurrent(snapshot.target));
    },
    get evaluate() { return options.evaluate; },
    get evaluatorAvailable(){return options.evaluatorAvailable;},
    get evaluationReadiness(){return options.evaluationReadiness;},
    wasPublished(snapshot, receipt) {
      if (snapshot.target.kind === "memory-policy") return false;
      try { if (validateProcedureEvaluationReceipt(snapshot, receipt).decision !== "accepted") return false; } catch { return false; }
      const context = audience(snapshot.target.ownerId, snapshot.target.threadId);
      if (!context || context.scopeId !== snapshot.target.scopeId || !evidenceCurrent(context, handles(snapshot))) return false;
      if (snapshot.target.kind === "skill") {const published=options.skills.wasPublished(snapshot, receipt, context);if(published)options.onPublished?.(snapshot,receipt,currentInstructionRevision(snapshot.target));return published;}
      const routine = options.routines()?.listRoutines().find(item => item.id === snapshot.target.artifactId);
      const version = routine?.instructionHistory?.find(item => item.id === routine.instructionRevision);
      const published=Boolean(routine && version?.evaluationReceiptId === receipt.id && procedureCandidateHash(routine.prompt) === receipt.candidateHash);
      if(published)options.onPublished?.(snapshot,receipt,currentInstructionRevision(snapshot.target));return published;
    },
    publish(snapshot, input) {
      const receipt = validateProcedureEvaluationReceipt(snapshot, input);
      if (receipt.decision !== "accepted" || !host.canPublish(snapshot)) throw new Error("PROCEDURE_PUBLICATION_REVOKED");
      const context = audience(snapshot.target.ownerId, snapshot.target.threadId)!;
      if (snapshot.target.kind === "skill") {options.skills.publish(snapshot, receipt, context);options.onPublished?.(snapshot,receipt,currentInstructionRevision(snapshot.target));return;}
      const manager = options.routines(), routine = manager?.listRoutines().find(item => item.id === snapshot.target.artifactId);
      if (!manager || !routine) throw new Error("PROCEDURE_TARGET_STALE");
      authorizedRoutine = { snapshot, receipt };
      try {
        manager.promoteInstructions(routine.id, { expectedRevision: routineInstructionRevision(routine), expectedUpdatedAt: routine.updatedAt, prompt: receipt.candidate, evaluationReceiptId: receipt.id, evidence: handles(snapshot) });
        options.onPublished?.(snapshot,receipt,currentInstructionRevision(snapshot.target));
      } finally { authorizedRoutine = undefined; }
    },
  };
  return {
    host,
    currentInstructionRevision,
    readInstruction(target:ProcedureReviewTarget):string {
      if(!host.isTargetCurrent(target))throw Error("PROCEDURE_TARGET_STALE");
      if(target.kind==="routine")return options.routines()!.listRoutines().find(item=>item.id===target.artifactId)!.prompt;
      if(target.kind!=="skill")throw Error("PROCEDURE_TARGET_STALE");
      const bundle=readProcedureBundle(target.ownerId,target.threadId,{schema:1,bundleId:target.bundleId});
      const imported=bundle.imported.find(item=>item.name===target.artifactId&&item.revision===target.baseRevision&&item.editable);
      const payload=bundle.files.find(item=>item.path===`skills/${target.artifactId}/SKILL.md`);
      if(!imported||!payload||payload.sha256!==imported.sha256)throw Error("PROCEDURE_TARGET_STALE");
      const bytes=Buffer.from(payload.bytes,"base64"),text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
      if(procedureCandidateHash(text)!==payload.sha256)throw Error("PROCEDURE_TARGET_STALE");return text;
    },
    validateRoutinePromotion(routine: Readonly<Routine>, proposal: Readonly<RoutineInstructionPromotion>) {
      const approved = authorizedRoutine;
      return Boolean(approved && approved.snapshot.target.artifactId === routine.id && approved.snapshot.target.baseRevision === routineBase(routine) && approved.receipt.id === proposal.evaluationReceiptId && approved.receipt.candidate === proposal.prompt && JSON.stringify(handles(approved.snapshot)) === JSON.stringify(proposal.evidence) && host.canPublish(approved.snapshot));
    },
    validateRoutineEvidence(context: Pick<Routine, "botId" | "groupId" | "target">, evidence: NonNullable<Evidence>) {
      return routineContexts(context).some(audience => evidenceCurrent(audience, evidence));
    },
  };
}
