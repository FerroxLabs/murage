import { featureOffErrors } from '../no-limits-live/feature-off.mjs';
import { createHash } from 'node:crypto';
import { availability, parityRequired } from './replay-decide.mjs';
export const digest = x => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex');
export function checkReplay({ candidateSha, rows, labels, labelBytes, committedLabelHash, results, baseline, liveRows = [], controls = [], release = true }) {
 const errors = []; let nonwipe_cards=0,refusals=0,off_with_line=0;
 if(release && (controls.length!==3 || ['control-home','control-root','control-disk'].some(id=>controls.filter(c=>c.id===id&&c.candidateSha===candidateSha&&c.verdict==='PASS'&&c.cards===1&&c.why==='wipe'&&!(c.refusals??0)).length!==1))) errors.push('three passing candidate-bound wipe controls required');
 for (const row of results.filter(r => r.status === 'unavailable')) {
  if(release)errors.push('unavailable original row blocks release');
  if (!row.requiredLiveRow || !liveRows.some(l => l.id === row.requiredLiveRow && l.verdict === 'PASS' && l.actionProven === true && l.candidateSha === candidateSha)) errors.push('unavailable shape lacks passing J3 witness');
 }
 let boundLabels; try { boundLabels = JSON.parse(labelBytes); } catch { errors.push('labels are not JSON'); }
 if (digest(boundLabels ?? null) !== digest(labels)) errors.push('labels differ from committed bytes');
 if (!/^[a-f0-9]{40}$/.test(candidateSha)) errors.push('candidate sha missing');
 if (!/^[a-f0-9]{64}$/.test(committedLabelHash) || digest(labelBytes) !== committedLabelHash) errors.push('independent labels do not match committed hash');
 const required=release?257:140;
 if (rows.length !== required || labels.length !== required || results.length !== required || baseline.length !== required) errors.push(`all ${required} rows required`);
 const key = r => `${r.key.threadId}/${r.key.requestId}`;
 const keys = rows.map(key);
 if (new Set(keys).size !== rows.length) errors.push('duplicate requests');
 const by = values => new Map(values.map(r => [key(r), r]));
 const labelMap = by(labels), resultMap = by(results), baseMap = by(baseline);
 if ([labelMap, resultMap, baseMap].some(m => m.size !== rows.length || [...m.keys()].some(k => !keys.includes(k)))) errors.push('row sets differ');
 for (const row of rows) {
  const id = key(row), label = labelMap.get(id), got = resultMap.get(id), base = baseMap.get(id);
  if (!label || !got || !base) { errors.push('row missing'); continue; }
  if (base.sourceSha !== '292df98d80a1c55db3e6f232166fc05162b632ab') errors.push('wrong baseline');
  if (label.inputHash !== digest(row.fullToolInput) || label.independent !== true || !['owner','owner-routine','webhook','owner-channel','owner-phone','other','guest','non-owner'].includes(label.actor)) errors.push('invalid independent label');
  if (!['owner','owner-routine','webhook','owner-channel','owner-phone','other','guest','non-owner'].includes(label.actor)) { errors.push('actor label missing'); continue; }
  const rejected=['refuse','deny','hold','cancel'].includes(got.kind)||(got.refusals??0)>0||(got.holds??0)>0;
  if(rejected && (label.kind==='feature-off' || !parityRequired({...row,label}))){refusals++;errors.push('refusal or hold');}
  if(release && !['run','card','question'].includes(got.kind))errors.push('unknown or unavailable outcome');
  if(release && ((got.kind==='card')!==(got.cards>0)))errors.push('outcome and card count disagree');
  const rowAvailability = availability({ ...row, label });
  if (got.status === 'unavailable') {
   const unavailable = rowAvailability;
   if (!['none','deny','owner-deny','permission-rule','feature-off','wipe','question','needs-context'].includes(label.kind)) errors.push('invalid independent label');
   if (got.candidateSha !== candidateSha || unavailable.status !== 'unavailable' || got.reason !== unavailable.reason || got.requiredLiveRow !== unavailable.requiredLiveRow) errors.push('invalid unavailable classification');
   continue;
  }
  if (rowAvailability.status === 'unavailable') { errors.push('unavailable row was judged'); continue; }
  if (got.candidateSha !== candidateSha || got.status !== 'judged' || base.status !== 'judged') { errors.push('unavailable or wrong candidate'); continue; }
  if (label.inputHash !== digest(row.fullToolInput) || !['none','deny','owner-deny','permission-rule','feature-off','wipe','question'].includes(label.kind) || !['owner','owner-routine','webhook','owner-channel','owner-phone','other','guest','non-owner'].includes(label.actor) || label.independent !== true) errors.push('invalid independent label');
  if (!['owner','owner-routine','webhook','owner-channel','owner-phone','other','guest','non-owner'].includes(label.actor)) { errors.push('actor label missing'); continue; }
  if (!Number.isInteger(got.cards) || got.cards < 0) errors.push('card count unavailable');
  const cards=Math.max(got.cards??0,(got.messages??[]).filter(m=>m.kind==='options'&&m.card).length);
  if (label.kind === 'feature-off') {
    const issues=featureOffErrors({feature:label.feature},got);
    if(got.kind!=='off'||cards!==0||rejected||issues.length)errors.push('disabled feature ran, carded or lacks settings line');
    else off_with_line++;
    if(cards){nonwipe_cards+=cards;errors.push('non-wipe card');}
  } else if (parityRequired({ ...row, label })) {
    if (got.parityDigest !== base.parityDigest) errors.push('base parity mismatch');
  } else {
    if (label.kind !== 'wipe' && label.kind !== 'question' && (got.kind !== 'run' || got.actionExecuted === false)) errors.push('permission rule requires RUN');
    if(['deny','owner-deny','permission-rule'].includes(label.kind) && ((got.ran!==true&&got.actionExecuted!==true)||(got.refusals??0)!==0||(got.holds??0)!==0||(got.silentDenies??0)!==0))errors.push('stored permission rule must run');
    const count = label.kind==='wipe' ? 1 : 0;
    if(cards && (label.kind!=='wipe'||got.why!=='wipe')){nonwipe_cards+=cards;errors.push('non-wipe card');}
    if ((got.questions ?? 0) !== (label.kind === 'question' ? 1 : 0) || (label.kind === 'question' && got.why !== 'question')) errors.push('question record mismatch');
    if (cards !== count || (count && (got.why !== label.kind || !got.evidence?.some(e => e.kind === label.kind && e.cls === label.cls)))) errors.push('owner exception set mismatch');
  }
 }
 return { candidateSha, labelHash: committedLabelHash, rows: rows.length, releaseEligible:release, nonwipe_cards, refusals, off_with_line, skipped:results.filter(r=>r.status==='unavailable').length, verdict: errors.length ? 'FAIL' : 'PASS', errors: [...new Set(errors)] };
}
