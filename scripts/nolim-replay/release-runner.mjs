// Sequential J1 execution. The candidate binding is supplied by the integrated
// production fixture, not by the labeler or corpus. No commands are executed.
import { availability, replayDecide } from './replay-decide.mjs';
import { checkReplay, digest } from './release-check.mjs';
export async function replayCards({ rows, labels, labelBytes, committedLabelHash, candidateSha, baseline, production, liveRows = [], controls = [], release = true }) {
 const results = [];
 for (const row of rows) {
  const label = labels.find(l => l.key.threadId === row.key.threadId && l.key.requestId === row.key.requestId);
  try {
   const d = await replayDecide({ ...row, label }, production);
   const record = d.ref ? await production.readRecord(d.ref.approvalId) : undefined;
   // The baseline wrapper's original verdict is what parity compares. Tickets,
   // newly added evidence, keys and timing are never compared to the old type.
   const original = production.baseResultFor(row.key);
   results.push({ key: row.key, candidateSha, status: 'judged', kind:d.kind, featureOff:d.featureOff, holds:d.holds??0, refusals:d.refusals??(['refuse','deny','hold','cancel'].includes(d.kind)?1:0), cards: d.kind === 'card' ? 1 : 0, questions: d.kind === 'question' ? 1 : 0,
    ran:d.kind==='run', silentDenies:d.silentDenies??0,
    ...(d.featureOff?.ownerLines?{explanationLines:d.featureOff.ownerLines.length,offLine:d.featureOff.ownerLines.join('\n')} : row.capabilitySnapshot?.enabled===false?{explanationLines:d.message?.trim()?d.message.trim().split(/\r?\n/).length:0,offLine:d.message}:{}),
    why: record?.why, evidence: (record?.evidence ?? []).map(e => ({ kind: e.kind, cls: e.cls, source: e.source, spanHash: e.span ? digest(e.span) : undefined })),
    parityDigest: original === undefined ? null : digest(production.canonicalBase(original)) });
  } catch (error) {
   const state = availability({ ...row, label });
   results.push({ key: row.key, candidateSha, status: 'unavailable',
    reason: state.reason ?? error.message, shape: state.shape, inputShape: state.inputShape, requiredLiveRow: state.requiredLiveRow });
  }
 }
 return { ...checkReplay({ candidateSha, rows, labels, labelBytes, committedLabelHash, results, baseline, liveRows, controls, release }), results };
}
