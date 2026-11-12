import { featureOffErrors } from './feature-off.mjs';
import { checkContainment } from './observe.mjs';
import { scenarios, engineSpecs } from './scenarios.mjs';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Only product message/card events count. Runtime request.opened is NOT a shown card. */
export class CardLedger {
  cards = new Map();
  threadCards = new Map();
  errors = [];
  errorThreads = [];
  problems(ids) { return this.errors.filter((_, i) => ids.includes(this.errorThreads[i])); }
  observe(threadId, message) {
    if (message?.kind !== 'options' || !message.card) return;
    // New-seat intake and first-launch setup are product onboarding, not tool approval events.
    if (!message.card.requestId && (message.card.intake || message.card.setup)) return;
    if (!message.card || typeof message.card.requestId !== 'string' || !message.card.requestId) {
      this.errors.push('options event without a card requestId'); this.errorThreads.push(threadId);
      return;
    }
    if (typeof threadId !== 'string' || !threadId) { this.errors.push('card without threadId'); this.errorThreads.push(threadId); return; }
    const c = message.card;
    const key = `${threadId}:${c.requestId}`;
    const old = this.cards.get(key);
    if (!this.threadCards.has(threadId)) this.threadCards.set(threadId, new Set());
    this.threadCards.get(threadId).add(key);
    this.cards.set(key, { ...old, threadId, requestId: c.requestId, approvalId: c.approvalId ?? old?.approvalId, messageId: message.id,
      at: old?.at ?? message.at, reason: c.decisionWhy ?? c.why ?? c.cardClass?.reason ?? old?.reason ?? 'unclassified',
      initiator: c.cardClass?.noLimits?.initiator ?? old?.initiator,
      origin: c.cardClass?.origin ?? old?.origin, unattended: c.cardClass?.unattended ?? old?.unattended,
      routineId: c.cardClass?.routine?.routineId ?? old?.routineId,
      n2: c.cardClass?.noLimits?.n2 ?? old?.n2,
      tool: c.tool ?? old?.tool, answered: c.answered ?? old?.answered,
      why: c.decisionWhy ?? c.why ?? old?.why, evidence: c.evidence ?? old?.evidence,
      question: !!c.questions, folderTrust: !!c.folderTrust });
  }
  correlate(records, window = {}) {
    const index = new Map();
    const identity = (approvalId,threadId,requestId,messageId) => JSON.stringify([approvalId,threadId,requestId,messageId]);
    for (const record of records) {
      if (window.threadId && record.thread_id !== window.threadId) continue;
      const key = identity(record.id,record.thread_id,record.request_id,record.chat_message_id), list = index.get(key) ?? [];
      list.push(record); index.set(key,list);
    }
    const keys = window.threadId ? this.threadCards.get(window.threadId) ?? [] : this.cards.keys();
    const messages = window.messageIds ? new Set(window.messageIds) : undefined;
    for (const key of keys) {
      const card = this.cards.get(key);
      if (messages && !messages.has(card.messageId)) continue;
      if (Number.isFinite(card.at) && (card.at < (window.start ?? -Infinity) || card.at > (window.end ?? Infinity))) continue;
      // Keep the four-field join exact, including duplicate-record rejection.
      const matches = index.get(identity(card.approvalId,card.threadId,card.requestId,card.messageId)) ?? [];
      if(matches.length!==1)continue;
      const record=matches[0];let evidence;try{evidence=JSON.parse(record.evidence);}catch{continue;}
      if(!['engine','service'].includes(record.source_kind)||!['base','wipe','deny','question'].includes(record.why)||!Array.isArray(evidence.items))continue;
      if(card.why && card.why!==record.why){this.errors.push('card metadata disagrees with approval record');this.errorThreads.push(card.threadId);continue;}
      this.cards.set(key,{...card,why:record.why,reason:record.why,evidence:evidence.items,initiator:evidence.initiator,recordId:record.id});
    }
  }
  bindRegistration(threadId,message,record) {
    const card=message?.card,key=`${threadId}:${card?.requestId}`,old=this.cards.get(key);
    if(!old||!record||record.id!==card.approvalId||record.thread_id!==threadId||record.chat_message_id!==message.id||record.request_id!==(card.requestRef??card.requestId))throw Error('permission presentation lacks exact durable record');
    const payload=JSON.parse(record.evidence);
    if(!['base','wipe','deny','question'].includes(record.why)||!Array.isArray(payload.items))throw Error('invalid durable permission evidence');
    this.cards.set(key,{...old,why:record.why,reason:record.why==='base'?'no-grant':'always-ask',evidence:payload.items,
      unattended:record.actor_kind==='other'||record.actor_kind==='unproven',question:record.why==='question'||old.question});
  }
  event(frame) {
    if (frame?.kind === 'message' || frame?.kind === 'message.patch') this.observe(frame.threadId, frame.message);
  }
  forThreads(ids) { return [...new Set(ids)].flatMap(id=>[...(this.threadCards.get(id)??[])].map(key=>this.cards.get(key))); }
}
export function judgeScenario(spec, observation) {
  const errors = [...(observation.errors ?? [])];
  if (!['RUN','CARD','OFF_WITH_LINE'].includes(spec.expected)) errors.push('unsupported expectation');
  if (!observation.complete) errors.push('incomplete observation');
  if (!observation.actionProven) errors.push('requested action not proven');
  if (!observation.ended) errors.push('turn did not finish successfully');
  if (observation.accounting?.verdict === 'FAIL') errors.push(...(observation.accounting.errors ?? ['Independent policy accounting failed']));
  if (spec.requiresAsk && observation.effectiveLevel !== 'ask') errors.push('thread did not remain at Ask');
  if (spec.permissionExplicit && observation.botPermissionExplicit !== true) errors.push('stored owner explicit bot setting not proven');
  if (spec.missingOrigin && observation.missingOriginProven !== true) errors.push('missing-origin ingress not proven');
  if (spec.permissionRule && (observation.permissionRuleWitness?.ruleInstalled !== true || observation.permissionRuleWitness?.source !== spec.id || observation.permissionRuleWitness?.actionExecuted !== true))
    errors.push('stored permission rule installation or execution unproven');
  if (spec.permissionRule && (observation.messages??[]).some(m=>m.kind==='options'&&m.card)) errors.push('stored permission rule showed a card message');
  const allCards = observation.cards ?? [];
  const questions = allCards.filter(c => c.question || c.why === 'question');
  let cards = allCards.filter(c => !c.question && c.why !== 'question');
  const refusals = refusalSignals(observation);
  const featureOff = spec.expected === 'OFF_WITH_LINE';
  if (featureOff) errors.push(...featureOffErrors(spec, observation));
  if (refusals.length && spec.expected !== 'CARD') errors.push(`refusal or silent deny: ${refusals.length}`);
  if (spec.id === 'switch-ask-to-nolimits') {
    const change = observation.switch;
    if (!Number.isFinite(change?.at) || !Number.isFinite(change?.nativeAck?.at) || change.nativeAck.at < change.at) errors.push('native switch acknowledgement missing');
    cards = cards.filter(c => {
      // Unknown timestamps cannot be excluded from the post-switch window.
      if (!Number.isFinite(c.at) || c.at >= change?.at) return true;
      if (c.why !== 'base' || !c.answered || !/^allowed/i.test(c.answered)) errors.push('pre-switch BASE card did not settle allowed');
      return false;
    });
  }
  if (spec.expected === 'RUN' && (spec.permissionRule ? allCards : cards).length) errors.push(`expected zero cards, saw ${cards.length}`);
  if (spec.expected === 'CARD' && cards.length !== 1) errors.push('exactly one card required');
  if (spec.expected === 'CARD') {
    for (const card of cards) {
      if (card.question || card.folderTrust || card.reason === 'unclassified') errors.push('a non-permission card cannot satisfy expected CARD');
      if (spec.actor === 'non-owner' && !spec.missingOrigin && card.unattended !== true && !['guest','other-human'].includes(card.initiator?.k)) errors.push('non-owner card lacks independent non-owner attribution');
      if (spec.actor === 'routine' && !card.routineId) errors.push('routine card lacks product routine attribution');
    }
  }
  if (spec.why) for (const card of cards) {
    if (card.why !== spec.why || !Array.isArray(card.evidence) || (spec.why !== 'base' && !card.evidence.some(e => e.kind === spec.why && (!spec.cls || (e.cls ?? e.class) === spec.cls) && (!spec.denySource || e.source === spec.denySource)))) errors.push('card decision evidence does not match independent expectation');
  }
  if (spec.rule && !spec.why) {
    for (const card of cards) {
      // A wrong card (question, setup, unreadable, etc.) cannot satisfy a wipe/deny cell.
      const decisions = (observation.decisions ?? []).filter(d => d.threadId === card.threadId && d.requestId === card.requestId && d.decision === 'card-shown');
      if (!decisions.some(d => d.source === 'always-ask' && (spec.allowedRules ?? [spec.rule]).includes(d.rule))) errors.push(`card ${card.requestId} is not ${spec.rule}`);
    }
  }
  const eligible = spec.level === 'unlimited' && (!['guest', 'non-owner'].includes(spec.actor) || spec.permissionExplicit === true);
  const nonwipeCardCount = eligible ? Math.max(cards.filter(c => spec.why !== 'wipe' || c.why !== 'wipe').length,observation.accounting?.nonwipeCards??0) : 0;
  return { ...spec, ...observation, cards: allCards, cardCount: cards.length, nonwipeCardCount,
    offWithLineCount: featureOff && !errors.length ? 1 : 0,
    refusalCount: spec.expected === 'CARD' ? 0 : refusals.length+(eligible?observation.accounting?.hiddenHolds??0:0), questionCount: questions.length, errors, verdict: errors.length ? 'FAIL' : 'PASS' };
}
// Successful turn completion alone cannot hide a refused request. Inspect
// structured receipts and the product's fixed refusal line as separate evidence.
export function refusalSignals(observation) {
  return [
    ...(observation.refusals ?? []),
    ...(observation.holds > 0 ? [{kind:'hold'}] : []),
    ...(observation.decisions ?? []).filter(d => /refus|denied|blocked|hold|cancel/i.test(d.decision ?? '')),
    ...(observation.events ?? []).filter(e =>
      /refus|denied|blocked|hold|held|cancel/i.test(`${e.type ?? ''} ${e.stopReason ?? ''}`)
      || e.type === 'request.resolved' && ['deny', 'reject', 'cancel'].includes(e.behavior)
      || e.type === 'item.completed' && e.itemType === 'tool' && e.ok === false),
    ...(observation.messages ?? []).filter(m => m.role === 'bot' && /Murage could not confirm this request\. Nothing was run\.|OUTSIDE_WRITE_REFUSAL/.test(m.text ?? '')),
  ];
}
export function completeMatrix(rows, engines, specs = scenarios) {
  const result = [...rows];
  for (const engine of engines) for (const spec of specs) {
    if (!rows.some(r => r.engine === engine.id && r.id === spec.id)) result.push({ ...spec, engine: engine.id,
      verdict: 'FAIL', skipped: false, cards: [], cardCount: 0, nonwipeCardCount: 0, refusalCount: 0,
      errors: [`FAILED: ${engine.reason ?? 'row did not run'}`] });
  }
  return result;
}
export function machineSummary({ rows, replay }) {
  const sum = key => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
  return `GNL-RESULT rows=${rows.length+(replay?.rows??0)+(replay?.controls?.rows??0)} pass=${rows.filter(r => r.verdict === 'PASS').length+(replay?.pass??0)+(replay?.controls?.pass??0)} nonwipe_cards=${sum('nonwipeCardCount')+(replay?.nonwipe_cards??0)} refusals=${sum('refusalCount')+(replay?.refusals??0)} skipped=${rows.filter(r => r.skipped || r.verdict === 'SKIP' || r.verdict === 'UNPROVEN').length+(replay?.skipped??0)+(replay?.controls?.skipped??0)}`;
}
export function summarize(rows) {
  const classes = {};
  for (const row of rows) {
    const key = `${row.actor}/${row.level}/${row.rule ?? row.expected}`;
    const c = classes[key] ??= { scenarios: 0, cards: 0, failed: 0, reasons: {} };
    c.scenarios++; c.cards += row.cardCount; c.failed += row.verdict !== 'PASS' ? 1 : 0;
    for (const card of row.cards) c.reasons[card.reason] = (c.reasons[card.reason] ?? 0) + 1;
  }
  return classes;
}

/** Release admission checks the exact matrix, not just its row count. */
export function releaseVerdict(report, release = false, {engineIds=engineSpecs.map(e=>e.id)} = {}) {
  // The old 1.0.18 high-level baseline pins superseded non-wipe prompts.
  // Fixed Ask/Auto/Full rows carry parity expectations; a supplied comparison
  // is still binding. A diagnostic egress probe is never an OS qualification.
  if (release && (report.fixture?.isolated !== true || report.replay?.verdict !== 'PASS' || report.mandatory?.verdict !== 'PASS'
    || engineIds.some(id=>report.mandatory.engineIds?.filter(x=>x===id).length!==1)
    || report.rows.some(r => r.accounting?.verdict !== 'PASS' || r.skipped))) return 'FAIL';
  if (report.baselineComparison && report.baselineComparison.verdict !== 'PASS') return 'FAIL';
  if (report.errors.length || report.rows.some(r => r.verdict !== 'PASS')) return 'FAIL';
  if (release && (report.engines.length !== engineIds.length || engineIds.some(id => report.engines.filter(x => x.id === id && x.status === 'PASS').length !== 1))) return 'FAIL';
  const engines = report.engines.filter(e => e.status !== 'SKIP');
  if (!engines.length || engines.some(e => e.status !== 'PASS')) return 'FAIL';
  const expected = new Set(engines.flatMap(e => scenarios.map(s => `${e.id}/${s.id}`)));
  const observed = report.rows.map(r => `${r.engine}/${r.id}`);
  return observed.length === expected.size && new Set(observed).size === expected.size && observed.every(k => expected.has(k)) ? 'PASS' : 'FAIL';
}
