// Capture/artifact/source producer: MAIN. Semantic checker consumer: TRUST-V2-d.
// Proves consistency and behavior on the independently selected package, not
// authenticity against a malicious author of all capture inputs.
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FUIGO_TARGET_OSES, fuigoTargetFromPackage } from './prepare-fuigo.mjs';

export const TRUST_V3_CASES = Object.freeze([
  'picked-primary', 'unpicked', 'unknown-key', 'restart', 'session-load', 'old-version', 'unknown-version', 'legacy-unscoped',
  'lower-ask', 'lower-ask-reject', 'saved-decline', 'descendant-decline', 'unreadable', 'incomplete-seed', 'unsafe-key',
  'ineligible-guest', 'ineligible-other-human', 'ineligible-webhook', 'ineligible-delegation', 'ineligible-unproven',
  'prewarm', 'stop', 'wipe-control', 'forget-pool', 'hidden-topology', 'cloud-routed', 'cloud-unrouted', 'managed-desk', 'stock-package',
]);
export const TRUST_SOURCE_AREAS = Object.freeze(['request-handlers', 'duration', 'persistence', 'session-new-instructions', 'session-load-instructions', 'process-lifetime', 'reject-isolation']);
export const REQUIRED_CASES = Object.freeze([
  ['rpc-order', 'Q1'], ['key-binding', 'Q2'], ['process-identity', 'Q3'],
  ['authority-receipt', 'Q4'], ['command-effect', 'Q5'], ['primary-positive', null],
  ['unpicked-negative', null], ['restart', null], ['version-fallback', null],
  ['level-drop', null], ['withheld', null], ['stop', null], ['retained', null],
  ['artifact', null], ['release-identity', null],
].map(([clause, schema2Origin]) => Object.freeze({ clause, schema2Origin,
  validFixture: `${clause}:valid`, invalidFixture: `${clause}:invalid`,
  test: 'every-clause-has-valid-and-invalid-fixture',
})));
const caseClause = id => ({
  'picked-primary': 'primary-positive', unpicked: 'unpicked-negative', 'unknown-key': 'unpicked-negative',
  restart: 'restart', 'session-load': 'restart', 'old-version': 'version-fallback',
  'unknown-version': 'version-fallback', 'legacy-unscoped': 'version-fallback', 'lower-ask': 'level-drop', 'lower-ask-reject': 'level-drop',
  stop: 'stop', 'forget-pool': 'retained', 'hidden-topology': 'retained',
  'cloud-routed': 'retained', 'cloud-unrouted': 'retained', 'managed-desk': 'retained',
  'stock-package': 'artifact', 'wipe-control': 'retained',
})[id] ?? 'withheld';
const ROLES = Object.freeze(['package', 'binary', 'policy', 'capture-driver', 'source-review', 'source-bundle']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = Object.freeze({ outcome: 'reject' });
const processTrust = Object.freeze({ outcome: 'trust', scope: 'configAndCommands', duration: 'process' });
const requireThat = (value, detail, clause = 'artifact') => { if (!value) throw new Error(`trust-v3: clause:${clause}: ${detail}`); };
const json = (folder, name, detail, clause = 'artifact') => {
  requireThat(typeof name === 'string' && Buffer.isBuffer(folder.get(name)), `${detail}: missing raw file`, clause);
  let value;
  try { value = JSON.parse(folder.get(name).toString('utf8')); } catch { throw new Error(`trust-v3: clause:${clause}: ${detail}: invalid JSON`); }
  requireThat(value && typeof value === 'object' && !Array.isArray(value), `${detail}: object required`, clause);
  return value;
};
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;

/** An expected release is supplied independently by the integration gate. A
 * receipt cannot select the SHA, targets, transformations or digests it proves. */
export function checkTrustArtifactIdentity(row, folder, expected) {
  requireThat(expected && typeof expected.murageSha === 'string' && /^[a-f0-9]{40}$/.test(expected.murageSha), 'independent expected release identity is required', 'release-identity');
  requireThat(row.murageSha === expected.murageSha && row.packageVersion === expected.packageVersion, 'expected release identity differs', 'release-identity');
  requireThat(typeof row.target === 'string' && typeof row.os === 'string', 'explicit package target mapping is required');
  requireThat(FUIGO_TARGET_OSES[row.target] === row.os, 'explicit package target mapping differs');
  const manifest = json(folder, row.trustV3?.artifacts, 'artifact manifest');
  requireThat(typeof expected.sourceRevision === 'string' && /^[a-f0-9]{40}$/.test(expected.sourceRevision) && typeof expected.checkerRevision === 'string' && /^[a-f0-9]{40}$/.test(expected.checkerRevision), 'exact source/checker revisions required', 'release-identity');
  const wanted = expected.targets?.[row.target];
  requireThat(wanted, 'expected target is missing', 'release-identity');
  requireThat(manifest.sourceRevision === row.peeledTag, 'source manifest differs from the running Fuigo pin');
  requireThat(FUIGO_TARGET_OSES[fuigoTargetFromPackage(manifest.fuigoPackage)] === row.os
    && fuigoTargetFromPackage(manifest.fuigoPackage) === row.target, 'explicit package name maps to another target');
  requireThat(manifest.murageSha === expected.murageSha && manifest.packageVersion === expected.packageVersion && manifest.target === row.target, 'package manifest identity differs');
  requireThat(manifest.sourceRevision === expected.sourceRevision && manifest.checkerRevision === expected.checkerRevision, 'source or checker revision differs');
  for (const role of ROLES) {
    const artifact = manifest.artifacts?.[role];
    requireThat(artifact && Buffer.isBuffer(folder.get(artifact.file)), `${role}: actual artifact is missing`);
    const digest = hash(folder.get(artifact.file));
    requireThat(digest === artifact.sha256 && digest === wanted[role], `${role}: actual artifact digest differs`);
  }
  requireThat(row.policySha256 === wanted.policy, 'actual governed policy digest differs');
  const binary = manifest.artifacts.binary;
  requireThat(binary.sha256 === row.binarySha256, 'actual running packaged binary digest differs');
  // The capture always hashes actual packaged bytes. A signing transformation
  // additionally pins its upstream input, with no digest normalization.
  if (wanted.binaryTransformation) {
    requireThat(binary.transformation?.upstreamSha256 === row.upstreamBinarySha256
      && binary.transformation?.packagedSha256 === binary.sha256
      && isDeepStrictEqual(binary.transformation, wanted.binaryTransformation), 'packaged binary transformation is not pinned');
  } else requireThat(!binary.transformation, 'unexpected packaged binary transformation');
  const review = json(folder, manifest.artifacts['source-review'].file, 'source review');
  requireThat(review.sourceRevision === expected.sourceRevision, 'source review is not for the actual pin');
  requireThat(TRUST_SOURCE_AREAS.every(area => typeof review.areas?.[area] === 'string' && review.areas[area].trim().length > 0), 'source review omits a required trust contract area');
  return manifest;
}

function captureView(folder, file, stopped) {
  const demand = (value, detail) => requireThat(value, detail, 'rpc-order');
  const bytes = folder.get(file);
  demand(Buffer.isBuffer(bytes), 'case transcript is missing');
  const records = [];
  for (const line of bytes.toString('utf8').split('\n').filter(line => line.trim())) {
    let record;
    try { record = JSON.parse(line); } catch { throw new Error('trust-v3: clause:rpc-order: case transcript is invalid JSON'); }
    demand(record && typeof record === 'object' && !Array.isArray(record) && record.seq === records.length + 1 && Number.isFinite(time(record.t)) && ['in', 'out'].includes(record.dir) && record.msg && typeof record.msg === 'object' && !Array.isArray(record.msg) && !record.tail, 'complete ordered raw RPC records required');
    if (records.length) demand(time(record.t) >= time(records.at(-1).t), 'RPC clock moved backwards');
    records.push(record);
  }
  const requests = [], replies = new Map(), pending = new Map();
  for (const record of records) {
    const { id, method } = record.msg;
    if (id === undefined) continue;
    demand(typeof id === 'string' || Number.isSafeInteger(id), 'invalid RPC id');
    if (method !== undefined) {
      demand(typeof method === 'string', 'invalid RPC method');
      const key = `${record.dir}:${typeof id}:${id}`;
      demand(!pending.has(key), 'hidden partial or duplicate RPC');
      pending.set(key, record); requests.push(record);
    } else {
      const key = `${record.dir === 'in' ? 'out' : 'in'}:${typeof id}:${id}`, request = pending.get(key);
      demand(request && (Object.hasOwn(record.msg, 'result') !== Object.hasOwn(record.msg, 'error')), 'orphan or duplicate RPC reply');
      replies.set(request, [record]); pending.delete(key);
    }
  }
  for (const request of pending.values()) demand(stopped && time(request.t) <= time(stopped.stoppedAt)
    && time(stopped.exitedAt) >= time(stopped.stoppedAt)
    && ['session/prompt', 'fuigo/folder_trust/request', '_fuigo/folder_trust/request'].includes(request.msg.method), 'hidden partial or duplicate RPC');
  const replyTo = request => replies.get(request) ?? [];
  const trust = requests.filter(r => ['fuigo/folder_trust/request', '_fuigo/folder_trust/request'].includes(r.msg.method));
  demand(trust.every(r => r.dir === 'out') && requests.filter(r => ['session/new', 'session/load', 'session/prompt'].includes(r.msg.method)).every(r => r.dir === 'in'), 'RPC request direction differs');
  const prompt = requests.find(r => r.msg.method === 'session/prompt');
  const session = requests.find(r => ['session/new', 'session/load'].includes(r.msg.method));
  demand(session, 'actual session cwd is missing');
  const results = records.filter(r => r.msg.method === 'session/update').map(r => r.msg.params?.update);
  return { records, requests, replyTo, trust, prompt, session, results };
}

function checkCase(id, spec, folder, row, expected) {
  const clause = caseClause(id), demand = (value, detail, kind = clause) => requireThat(value, detail, kind);
  demand(spec && Array.isArray(spec.processes) && spec.processes.length > 0, `${id}: complete process evidence is required`);
  demand(typeof spec.commandMarker === "string" && spec.commandMarker.length >= 16, `${id}: command marker is required`);
  const views = [], lowerAsk = id === 'lower-ask' || id === 'lower-ask-reject';
  for (const [processIndex, process] of spec.processes.entries()) {
    demand(process && typeof process === 'object' && !Array.isArray(process), `${id}: process object is required`);
    demand(!(row.modelFailures ?? []).some(failure => failure.file === process.transcript), `${id}: model failure cannot establish a required step`);
    const observed = json(folder, process.observation, `${id}: process observation`, 'process-identity');
    const view = captureView(folder, process.transcript, id === 'stop' ? observed : undefined);
    demand(time(observed.createdAt) <= time(view.session.t) && (!observed.exitedAt || time(observed.exitedAt) >= time(view.records.at(-1).t)), `${id}: capture is outside the observed process lifetime`, 'process-identity');
    demand(observed.source === 'capture-driver' && Number.isSafeInteger(observed.pid) && observed.pid > 0 && typeof observed.createdAt === 'string'
      && Number.isFinite(time(observed.createdAt))
      && ['instanceId', 'generation', 'threadId', 'turnId'].every(key => typeof observed[key] === 'string' && observed[key].length > 0), `${id}: actual process creation identity is missing`, 'process-identity');
    demand(typeof observed.version === 'string', `${id}: actual running version is missing`);
    const historical = ['old-version', 'unknown-version', 'legacy-unscoped'].includes(id);
    if (historical) {
      const bytes = folder.get(process.compatibilityBinary);
      demand(Buffer.isBuffer(bytes) && hash(bytes) === observed.binarySha256 && observed.binarySha256 === expected.targets[row.target].compatibility?.[observed.version], `${id}: exact compatibility artifact is missing`);
    } else demand(observed.version === row.fuigoVersion && observed.binarySha256 === row.binarySha256, `${id}: actual running version/binary differs from the package`);
    const authority = json(folder, process.authority, `${id}: authority receipt`, 'authority-receipt');
    demand(authority.source === 'decision-host' && authority.instanceId === observed.instanceId && authority.threadId === observed.threadId && authority.generation === observed.generation
      && authority.turnId === observed.turnId && ['owner', 'owner-routine', 'other', 'unproven'].includes(authority.actor)
      && ['ask', 'auto', 'full', 'unlimited'].includes(authority.level), `${id}: selected actor/level receipt is not bound to the turn`, 'authority-receipt');
    demand(typeof observed.cwd === 'string' && typeof observed.key === 'string' && typeof observed.home === 'string'
      && observed.cwd === view.session.msg.params?.cwd && observed.key === process.key, `${id}: actual session cwd/key differs`, 'key-binding');
    demand(Array.isArray(observed.argv) && !observed.argv.includes('--trust'), `${id}: automatic launch grant`);
    const positive = ['picked-primary', 'restart', 'session-load', 'cloud-routed', 'cloud-unrouted', 'stock-package', 'wipe-control'].includes(id) || id === 'lower-ask' && processIndex === 0;
    const negative = !positive;
    if (!id.startsWith('ineligible-') && (!lowerAsk || processIndex === 0)) demand(['owner', 'owner-routine'].includes(authority.actor)
      && ['owner-typed', 'owner-channel-dm', 'routine-run', 'routine-wake'].includes(authority.origin) && authority.level === 'unlimited', `${id}: No limits flag is not owner proof`, 'authority-receipt');
    for (const request of view.trust) {
      const answer = view.replyTo(request)[0];
      demand(request.msg.params?.workspace === observed.key, `${id}: request key differs from the actual key`, 'key-binding');
      if (!answer && id === 'stop') continue;
      demand(!observed.stoppedAt || time(answer.t) < time(observed.stoppedAt), `${id}: reply after Stop`);
      if (positive) {
        demand(/^\d+\.\d+\.\d+$/.test(observed.version ?? '') && observed.version.split('.').map(Number).some((part, n, all) => n === 0 ? part > 1 : n === 1 ? all[0] === 1 && part > 0 : all[0] === 1 && all[1] === 0 && part >= 38), `${id}: verified supported process-duration version is required`);
        demand(authority.level === 'unlimited' && request.msg.params?.scope === 'configAndCommands'
          && isDeepStrictEqual(answer.msg.result, processTrust), `${id}: exact picked process-duration reply is required`);
        demand(view.prompt && answer.seq < view.prompt.seq && observed.replyWrittenAt && time(observed.replyWrittenAt) >= time(answer.t) && time(observed.replyWrittenAt) <= time(view.prompt.t), `${id}: reply write callback must precede first prompt`);
      } else if (negative) demand(isDeepStrictEqual(answer.msg.result, reject), `${id}: configuration must be rejected`);
    }
    if (positive || negative && !['stop', 'prewarm'].includes(id)) demand(view.trust.length > 0, `${id}: no actual trust request/reply`);
    const model = json(folder, process.modelInputs, `${id}: actual model input`, clause);
    demand(model.processId === `${observed.pid}:${observed.createdAt}` && model.turnId === observed.turnId && typeof model.bytes === 'string', `${id}: model input belongs to another process/turn`);
    demand(typeof process.marker === 'string' && process.marker.length >= 16, `${id}: instruction marker is missing`);
    if (positive) demand(model.bytes.includes(process.marker), `${id}: authorized first-turn marker absent`);
    if (negative) demand(!model.bytes.includes(process.marker), `${id}: rejected configuration marker reached the model`);
    const stores = process.stores;
    demand(stores && ['murage', 'own', 'seed'].every(kind => stores[kind]), `${id}: exact before/after stores are required`);
    let saved;
    for (const kind of ['murage', 'own', 'seed']) {
      const pair = stores[kind], before = folder.get(pair?.before), after = folder.get(pair?.after);
      demand(Buffer.isBuffer(before) && Buffer.isBuffer(after) && before.equals(after), `${id}: ${kind} store changed`);
      demand(pair.home === observed.home && pair.processId === `${observed.pid}:${observed.createdAt}`
        && time(pair.beforeAt) <= time(view.session.t) && time(pair.afterAt) >= time(view.records.at(-1).t)
        && (!observed.nextInvocationAt || time(pair.afterAt) < time(observed.nextInvocationAt)), `${id}: ${kind} snapshot home/read window differs`);
      if (kind === 'murage') saved = json(folder, pair.before, `${id}: saved choices`, clause);
    }
    if (positive) demand(saved?.folders?.[observed.key]?.source === 'picker'
      && saved.folders[observed.key].decision === 'trust' && saved.folders[observed.key].consent !== 2, `${id}: exact picked record is missing`);
    const completed = view.results.filter(update => update?.sessionUpdate === 'tool_call_update' && update.status === 'completed');
    if (authority.level === 'unlimited' && ['owner', 'owner-routine'].includes(authority.actor) && !['stop', 'prewarm', 'wipe-control'].includes(id)) {
      demand(completed.some(update => JSON.stringify(update.content ?? null).includes(spec.commandMarker)), `${id}: actual non-wipe command output is missing`, 'command-effect');
      demand(!view.requests.some(r => r.msg.method === 'session/request_permission') && observed.cards === 0 && observed.refusals === 0, `${id}: ordinary No limits command gained a card or refusal`, 'command-effect');
    }
    if (id === 'prewarm') demand(observed.prewarm === true && !view.prompt, `${id}: idle/prewarm sent a prompt`);
    if (id === 'wipe-control') demand(view.requests.some(r => r.msg.method === 'session/request_permission') && observed.cards > 0 && !completed.length, `${id}: wipe must hold before execution`);
    if (id === 'descendant-decline') {
      const path = row.os === 'windows' ? win32 : posix;
      demand(Object.entries(saved?.folders ?? {}).some(([key, record]) => { const relative = path.relative(observed.key, key); return record?.decision === 'reject' && relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }), `${id}: covered descendant decline is missing`);
    }
    if (id === 'saved-decline') demand(saved?.folders?.[observed.key]?.decision === 'reject', `${id}: saved decline is missing`);
    if (id === 'unpicked' || id === 'unknown-key') demand(saved?.folders?.[observed.key]?.source !== 'picker', `${id}: negative is actually an exact picked key`);
    if (id === 'unreadable') demand(observed.authorityRead?.error && observed.authorityRead.path, `${id}: actual unreadable authority capture is missing`);
    if (id === 'incomplete-seed') demand(observed.seedProjection?.complete === false && observed.seedProjection.rejectCount > 1024
      && Object.values(saved?.folders ?? {}).filter(record => record?.decision === 'reject').length === observed.seedProjection.rejectCount, `${id}: actual incomplete decline projection is missing`);
    if (id === 'cloud-routed' || id === 'cloud-unrouted') demand(observed.destination === 'cloud-home' && observed.providerRouted === (id === 'cloud-routed'), `${id}: actual Cloud route differs`);
    if (id === 'hidden-topology') demand(observed.cwd !== observed.key && Object.values(saved?.folders ?? {}).some(record => record?.folder === observed.cwd && record?.decision === 'reject'), `${id}: hidden topology decline control is missing`);
    if (id === 'unsafe-key') demand(observed.key === '/' || /^[A-Za-z]:[\\/]$/.test(observed.key) || /[\u0000-\u001f\u007f]/u.test(observed.key), `${id}: unsafe-key control was replaced with a safe key`);
    if (id === 'managed-desk') demand(observed.managedDesk === observed.cwd, `${id}: actual managed desk is missing`);
    if (id.startsWith('ineligible-')) demand(({ 'ineligible-guest': ['guest'], 'ineligible-other-human': ['other-human'], 'ineligible-webhook': ['webhook'], 'ineligible-delegation': ['delegation'], 'ineligible-unproven': ['unproven'] })[id]?.includes(authority.origin), `${id}: ineligible origin control was replaced with an owner`);
    if (id === 'old-version' || id === 'legacy-unscoped') demand(/^1\.0\.(?:[0-9]|[12][0-9]|3[0-7])$/.test(observed.version ?? ''), `${id}: historical compatibility binary is missing`);
    if (id === 'unknown-version') demand(!/\d+\.\d+\.\d+/.test(observed.version ?? ''), `${id}: unknown-version control is missing`);
    if (lowerAsk && processIndex > 0) demand(authority.level === 'ask' && observed.cards > 0 && view.requests.some(request => request.msg.method === 'session/request_permission'
      && view.records.some(record => record.seq > view.replyTo(request)[0]?.seq && record.msg.params?.update?.status === 'completed'
        && JSON.stringify(record.msg.params.update.content ?? null).includes(spec.commandMarker))), `${id}: actual lower-level command checking is missing`);
    if (id === 'stop') demand(observed.successNotices === 0 && observed.stoppedAt && !view.records.some(r => r.msg.method === 'session/prompt' && time(r.t) >= time(observed.stoppedAt)), `${id}: prompt after Stop`);
    if (id === 'session-load') demand(view.session.msg.method === 'session/load', `${id}: no actual session/load`);
    if (id === 'stock-package') demand(observed.artifact === 'stock-package' && !observed.alterations?.length, `${id}: final stock package smoke is missing`);
    if (authority.level === 'ask') demand(typeof process.policySha256 === 'string' && process.policySha256.length === 64 && process.policySha256 === expected.targets[row.target].policy && view.records.some(r => r.msg.result?._meta?.['fuigo/permissionPolicy']?.sha256 === process.policySha256), `${id}: wrong or absent policy acknowledgement`);
    views.push({ observed, authority, view, process });
  }
  if (['restart', 'session-load', 'lower-ask', 'lower-ask-reject', 'forget-pool', 'old-version', 'unknown-version'].includes(id)) {
    demand(views.length >= 2, `${id}: a fresh process control is required`);
    for (let index = 1; index < views.length; index++) {
      const old = views[index - 1], fresh = views[index];
      demand(old.observed.threadId === fresh.observed.threadId && old.observed.turnId !== fresh.observed.turnId
      && old.observed.generation !== fresh.observed.generation, `${id}: lifecycle controls must follow the same thread into a fresh turn`);
      if (['restart', 'session-load'].includes(id) || lowerAsk) demand(['murage', 'own', 'seed'].every(kind =>
        folder.get(old.process.stores[kind].after).equals(folder.get(fresh.process.stores[kind].before))), `${id}: a grant survived the process transition`);
      demand(`${old.observed.pid}:${old.observed.createdAt}` !== `${fresh.observed.pid}:${fresh.observed.createdAt}`
      && old.observed.exitedAt && time(old.observed.exitedAt) <= time(fresh.observed.createdAt), `${id}: old process survives or was reused`, lowerAsk ? 'level-drop' : 'process-identity');
    }
  }
}

export function checkTrustV3(row, folder, expected) {
  requireThat(folder instanceof Map, 'raw artifact/capture folder is required', 'artifact');
  requireThat(row?.schema === 3, 'schema 3 is mandatory for current release readiness', 'schema');
  requireThat(row.modelFailures === undefined || Array.isArray(row.modelFailures) && row.modelFailures.every(f => f && typeof f.file === 'string' && typeof f.reason === 'string'), 'model failure inventory must be an array', 'rpc-order');
  checkTrustArtifactIdentity(row, folder, expected);
  for (const id of TRUST_V3_CASES) {
    try { checkCase(id, row.trustV3?.cases?.[id], folder, row, expected); }
    catch (error) { throw new Error(`${id}: ${error.message}`); }
  }
  return { os: row.os, murageSha: expected.murageSha, cases: TRUST_V3_CASES.length };
}
