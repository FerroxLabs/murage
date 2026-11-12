import { featureOffErrors } from './feature-off.mjs';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
// Independent all-surface accounting. Input is a row-window snapshot read by
// the fixture observer, not a candidate verdict or its card counter.
import { classifyRequest, hashInput } from './oracle-class.mjs';
export const SURFACES = ['taps', 'registrations', 'records', 'messages', 'queues', 'electron', 'mirrors'];
export function observe(scenario, snapshot) {
 const errors = [...(snapshot.errors ?? [])]; const fail = why => errors.push(why);
 for (const field of SURFACES) if (!Array.isArray(snapshot[field])) fail(`missing surface: ${field}`);
 if (!snapshot.complete) fail('incomplete surface snapshot');
 if (errors.length) return { verdict: 'FAIL', errors };
 const { taps, registrations, records, messages, queues, electron, mirrors } = snapshot;
 if (scenario.expected === 'OFF_WITH_LINE') {
  errors.push(...featureOffErrors(scenario,snapshot));
  if (taps.some(t=>t.type==='request'||t.type==='answer') || registrations.length || records.length || queues.length || electron.length || mirrors.length)
   fail('disabled capability reached tool or approval surfaces');
 }
 const identity = r => JSON.stringify([r.generation, r.requestId ?? r.request_id]);
 for (const scripted of scenario.requests ?? []) {
  if (!taps.some(t => t.type === 'request' && t.engine === scripted.engine && t.tool === scripted.tool
    && t.inputHash === (scripted.inputHash ?? hashInput(scripted.input)))) fail('declared request missing');
 }
 const seen = new Set();
 const expected = new Map();
 for (const request of taps.filter(t => t.type === 'request')) {
  const key = identity(request);
  if (seen.has(key)) { fail('duplicate engine request'); continue; } seen.add(key);
  const cls = classifyRequest(scenario, request);
  if (!cls) fail('unmatched actual request'); else expected.set(key, cls);
  if (registrations.filter(r => identity(r) === key).length !== 1) fail('request registration count');
  const answers = taps.filter(t => t.type === 'answer' && identity(t) === key && t.state === 'accepted');
  if (answers.length !== 1) fail('request answer count');
  if (cls === 'question' && records.filter(r => identity(r) === key && r.why === 'question').length !== 1) fail('question record mismatch');
  const permission = records.filter(r => identity(r) === key && r.why !== 'question');
  if (['run','permission-rule','owner-deny'].includes(cls) && (answers.length !== 1 || answers[0].behavior !== 'allow')) fail('RUN requires an accepted allow receipt');
  if (['permission-rule','owner-deny'].includes(cls) && permission.length) fail('stored permission rule has permission record');
  if (cls === 'run' && permission.length) fail('RUN request has permission record');
  if (['deny','wipe','base'].includes(cls) && (permission.length !== 1 || permission[0].why !== cls)) fail('expected permission record mismatch');
 }
 for (const answer of taps.filter(t => t.type === 'answer')) if (!seen.has(identity(answer))) fail('answer without request');
 for (const r of registrations) if (!seen.has(identity(r))) fail('registration without request');
 const ids = new Map(records.map(r => [r.id, r]));
 if (ids.size !== records.length) fail('duplicate approval record');
 let credentials = 0, questions = 0, permissions = 0;
 const presented = new Set();
 for (const message of messages) {
  if (['secret','mcpSignIn','connector'].includes(message.kind)) {
   credentials++; if (message.card !== undefined && message.card !== null) fail('credential carries card'); continue;
  }
  if (message.kind !== 'options' || !message.card) continue;
  // Onboarding widgets have no permission action.
  if (message.card.intake || message.card.setup) continue;
  const r = ids.get(message.card.approvalId);
  if (!r || r.chat_message_id !== message.id) { fail('presentation without matching record'); continue; }
  if (presented.has(r.id)) fail('duplicate presentation'); presented.add(r.id);
  if (r.why === 'question') questions++; else if (['deny','wipe','base'].includes(r.why)) permissions++; else fail('unknown record class');
 }
 for (const r of records) {
  if (!presented.has(r.id)) fail('record without presentation');
  if (r.why === 'question' && expected.get(identity(r)) !== 'question') fail('question without independently matched request');
  if (r.why !== 'question' && !expected.has(identity(r))) fail('permission without independently matched request');
 }
 for (const [surface, rows] of [['queue',queues],['electron',electron],['mirror',mirrors]]) {
  const unique = new Set();
  for (const row of rows) {
   if (!ids.has(row.approvalId)) fail(`${surface} without record`);
   const key = JSON.stringify([row.approvalId, row.destination ?? row.kind ?? '']);
   if (unique.has(key)) fail(`duplicate ${surface}`); unique.add(key);
  }
 }
 return { verdict: errors.length ? 'FAIL' : 'PASS', errors, permissions, questions, credentials, requests: seen.size };
}
export function checkContainment(report, expected = {}) {
 try {
  const pin = readFileSync(new URL('./egress/allowlist.sha256',import.meta.url),'utf8').trim();
  const sha = expected.candidateSha ?? execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  const r=report, n=r.network;
  if(r.schema!==1 || r.producedBy!=='attest.mjs' || r.host?.inContainer!==false || !r.host?.name || !Number.isInteger(r.host.pid))return false;
  if(r.candidateSha!==sha || r.allowlistHash!==pin || !n?.internal)return false;
  if(JSON.stringify([...n.containers].sort())!==JSON.stringify([r.proxy,r.probe].sort()))return false;
  if(JSON.stringify(r.probeNetworks)!==JSON.stringify([n.name]))return false;
  if(JSON.stringify(r.probeDns)!==JSON.stringify(['127.0.0.1']))return false;
  if(r.control?.reason!=='connected' || !r.control.ip || !['ENETUNREACH','EHOSTUNREACH'].includes(r.direct?.reason))return false;
  if(r.denied?.reason!==403 || r.positive?.reason!==200 || !['ENOTFOUND','EAI_AGAIN','ECONNREFUSED'].includes(r.lookup?.reason))return false;
  if(!(r.runStart<=r.runEnd && r.runEnd-r.runStart<120000))return false;
  for(const x of [r.control,r.direct,r.denied,r.positive,r.lookup]) if(!(r.runStart<=x.at && x.at<=x.end && x.end<=r.runEnd))return false;
  return true;
 } catch {return false;}
}
