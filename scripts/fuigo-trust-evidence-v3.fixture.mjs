// Synthetic semantic controls only. These bytes never establish real readiness.
import { createHash } from 'node:crypto';
import { fixtureRuns, toFiles, WANT } from './fuigo-bump-fixture.mjs';
import { checkRealTurns } from './fuigo-bump.mjs';
import { FUIGO_TARGET_OSES } from './prepare-fuigo.mjs';
import { TRUST_V3_CASES, TRUST_SOURCE_AREAS } from './fuigo-trust-evidence-v3.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function trustV3Fixture(target = 'linux-x64') {
  const os = FUIGO_TARGET_OSES[target], root = os === 'windows' ? `C:\\fixture\\${target}` : target === 'linux-x64' ? '/fixture' : `/fixture/${target}`;
  const path = name => `${root}${os === 'windows' ? '\\' : '/'}${name}`;
  const folder = new Map(), expected = { murageSha: 'a'.repeat(40), packageVersion: '1.0.20', sourceRevision: 'b'.repeat(40), checkerRevision: 'c'.repeat(40), targets: { [target]: {} } };
  const put = (name, value) => { folder.set(name, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); return name; };
  const manifest = { murageSha: expected.murageSha, packageVersion: expected.packageVersion, sourceRevision: expected.sourceRevision, checkerRevision: expected.checkerRevision, target, fuigoPackage: `@fuigo/${target}`, artifacts: {} };
  for (const role of ['package', 'binary', 'policy', 'capture-driver', 'source-review', 'source-bundle']) {
    const file = put(`artifact-${role}`, role === 'source-review' ? { sourceRevision: expected.sourceRevision, areas: Object.fromEntries(TRUST_SOURCE_AREAS.map(area => [area, `reviewed ${area}`])) } : `fixture ${role}${['binary', 'package'].includes(role) ? ` ${target}` : ''}`);
    const sha256 = hash(folder.get(file)); manifest.artifacts[role] = { file, sha256 }; expected.targets[target][role] = sha256;
  }
  const row = { schema: 3, peeledTag: expected.sourceRevision, fuigoVersion: '1.0.62', os, target, murageSha: expected.murageSha, packageVersion: expected.packageVersion, binarySha256: manifest.artifacts.binary.sha256, policySha256: manifest.artifacts.policy.sha256,
    trustV3: { artifacts: put('manifest.json', manifest), cases: {} } };
  expected.targets[target].compatibility = {};
  for (const version of ['1.0.37', 'unknown']) { const file = put(`compatibility-${version}`, `fixture binary ${version} ${target}`); expected.targets[target].compatibility[version] = hash(folder.get(file)); }
  let n = 0;
  for (const id of TRUST_V3_CASES) {
    const processes = [];
    const pair = ['restart', 'session-load', 'lower-ask', 'lower-ask-reject', 'forget-pool', 'old-version', 'unknown-version'].includes(id);
    for (let index = 0; index < (pair ? 2 : 1); index++) {
      const prefix = `${id}-${index}`, key = id === 'unsafe-key' ? os === 'windows' ? 'C:\\' : '/' : path('workspace'), marker = `configuration-${target}-${prefix}-marker`, commandMarker = `command-${target}-${id}-marker`;
      const at = 1900000000000 + n++ * 10000, stamp = offset => new Date(at + offset).toISOString();
      const observed = { source: 'capture-driver', pid: n, createdAt: stamp(0), exitedAt: stamp(9000), threadId: `thread-${target}-${id}`, turnId: `turn-${target}-${prefix}`, instanceId: target, generation: `generation-${prefix}`, cwd: id === 'hidden-topology' ? path('linked-checkout') : key, key, home: path('home'), argv: ['agent', 'stdio'], cards: id === 'wipe-control' || id.startsWith('lower-ask') && index > 0 ? 1 : 0, refusals: 0,
        replyWrittenAt: stamp(400), version: id === 'unknown-version' ? 'unknown' : ['old-version', 'legacy-unscoped'].includes(id) ? '1.0.37' : '1.0.62', ...(id === 'stop' ? { stoppedAt: stamp(650), successNotices: 0 } : {}),
        artifact: 'stock-package', alterations: [],
        ...(id === 'prewarm' ? { prewarm: true } : {}),
        ...(id === 'unreadable' ? { authorityRead: { error: 'EACCES', path: path('home/trusted_folders.toml') } } : {}),
        ...(id === 'incomplete-seed' ? { seedProjection: { complete: false, rejectCount: 1025 } } : {}),
        ...(id.startsWith('cloud-') ? { destination: 'cloud-home', providerRouted: id === 'cloud-routed' } : {}),
        ...(id === 'managed-desk' ? { managedDesk: key } : {}) };
      observed.binarySha256 = ['old-version', 'unknown-version', 'legacy-unscoped'].includes(id) ? expected.targets[target].compatibility[observed.version] : row.binarySha256;
      const authority = { source: 'decision-host', instanceId: observed.instanceId, threadId: observed.threadId, turnId: observed.turnId, generation: observed.generation,
        origin: ({ 'ineligible-guest': 'guest', 'ineligible-other-human': 'other-human', 'ineligible-webhook': 'webhook', 'ineligible-delegation': 'delegation', 'ineligible-unproven': 'unproven' })[id] ?? 'owner-typed',
        actor: id.startsWith('ineligible-') && id !== 'ineligible-webhook' ? 'other' : 'owner', level: id.startsWith('lower-ask') && index > 0 ? 'ask' : 'unlimited' };
      const positive = ['picked-primary', 'restart', 'session-load', 'cloud-routed', 'cloud-unrouted', 'stock-package', 'wipe-control'].includes(id) || id === 'lower-ask' && index === 0;
      const records = [];
      const push = (offset, dir, msg) => records.push({ seq: records.length + 1, t: stamp(offset), dir, msg });
      push(100, 'in', { id: 1, method: id === 'session-load' ? 'session/load' : 'session/new', params: { cwd: observed.cwd } });
      push(200, 'out', { id: 1, result: { sessionId: 'fixture-session', _meta: { 'fuigo/permissionPolicy': { sha256: expected.targets[target].policy } } } });
      push(300, 'out', { id: 2, method: '_fuigo/folder_trust/request', params: { workspace: key, scope: 'configAndCommands' } });
      push(400, 'in', { id: 2, result: positive ? { outcome: 'trust', scope: 'configAndCommands', duration: 'process' } : { outcome: 'reject' } });
      if (id !== 'prewarm') push(500, 'in', { id: 3, method: 'session/prompt', params: { sessionId: 'fixture-session', prompt: [{ type: 'text', text: 'fixture command' }] } });
      if (id.startsWith('lower-ask') && index > 0 || id === 'wipe-control') {
        push(550, 'out', { id: 4, method: 'session/request_permission', params: { options: [{ optionId: 'allow', kind: 'allow_once' }] } });
        push(560, 'in', { id: 4, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
      }
      if (!['prewarm', 'wipe-control'].includes(id)) push(600, 'out', { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', status: 'completed', content: [{ type: 'text', text: commandMarker }] } } });
      if (id !== 'prewarm') push(700, 'out', { id: 3, result: { stopReason: 'end_turn' } });
      const stores = {};
      for (const kind of ['murage', 'own', 'seed']) {
        const text = kind === 'murage' ? JSON.stringify({ version: 1, folders: ['unpicked', 'unknown-key', 'lower-ask-reject'].includes(id) ? {} : { [key]: { source: id === 'saved-decline' || id === 'hidden-topology' ? 'card' : 'picker', decision: id === 'saved-decline' || id === 'hidden-topology' ? 'reject' : 'trust', folder: observed.cwd, decidedAt: 1 } } }) : '';
        stores[kind] = { before: put(`${prefix}-${kind}-before`, text), after: put(`${prefix}-${kind}-after`, text), home: observed.home,
          processId: `${observed.pid}:${observed.createdAt}`, beforeAt: stamp(0), afterAt: stamp(800) };
      }
      if (id === 'descendant-decline') for (const file of [stores.murage.before, stores.murage.after]) { const saved = JSON.parse(folder.get(file)); saved.folders[key + (os === 'windows' ? '\\' : '/') + 'declined-child'] = { decision: 'reject', source: 'card', folder: key + (os === 'windows' ? '\\' : '/') + 'declined-child', decidedAt: 1 }; put(file, saved); }
      if (id === 'incomplete-seed') for (const file of [stores.murage.before, stores.murage.after]) {
        const saved = JSON.parse(folder.get(file));
        for (let decline = 0; decline < 1025; decline++) saved.folders[path(`declined-${decline}`)] = { decision: 'reject', source: 'card' };
        put(file, saved);
      }
      processes.push({ key, marker, ...(['old-version', 'unknown-version', 'legacy-unscoped'].includes(id) ? { compatibilityBinary: `compatibility-${observed.version}` } : {}), policySha256: expected.targets[target].policy, transcript: put(`${prefix}-rpc`, records.map(record => JSON.stringify(record)).join('\n') + '\n'),
        observation: put(`${prefix}-observation`, observed), authority: put(`${prefix}-authority`, authority), stores,
        modelInputs: put(`${prefix}-model`, { processId: `${observed.pid}:${observed.createdAt}`, turnId: observed.turnId, bytes: positive ? marker : 'ordinary input' }) });
    }
    row.trustV3.cases[id] = { processes, commandMarker: `command-${target}-${id}-marker` };
  }
  return { row, folder, expected };
}

export const editJson = (fixture, file, change) => {
  const value = JSON.parse(fixture.folder.get(file)); change(value);
  fixture.folder.set(file, Buffer.from(JSON.stringify(value)));
};
const editRpc = (f, p, change) => {
  const records = f.folder.get(p.transcript).toString().trim().split('\n').map(JSON.parse);
  change(records); f.folder.set(p.transcript, Buffer.from(records.map(JSON.stringify).join('\n') + '\n'));
};
// Independently enumerated fixture IDs ensure a removed manifest clause stays observable.
const INVALID = Object.freeze({
  'rpc-order': f => editRpc(f, f.row.trustV3.cases['picked-primary'].processes[0], records => { records[3].seq = 99; }),
  'key-binding': f => editJson(f, f.row.trustV3.cases['picked-primary'].processes[0].observation, o => { o.cwd = '/fixture/other'; }),
  'process-identity': f => editJson(f, f.row.trustV3.cases.restart.processes[0].observation, o => { delete o.createdAt; }),
  'authority-receipt': f => editJson(f, f.row.trustV3.cases['picked-primary'].processes[0].authority, a => { a.generation = 'another-generation'; }),
  'command-effect': f => { f.row.trustV3.cases['picked-primary'].commandMarker = 'unobserved-command-marker'; },
  'primary-positive': f => editRpc(f, f.row.trustV3.cases['picked-primary'].processes[0], records => { delete records[3].msg.result.duration; }),
  'unpicked-negative': f => editJson(f, f.row.trustV3.cases.unpicked.processes[0].modelInputs, m => { m.bytes = f.row.trustV3.cases.unpicked.processes[0].marker; }),
  restart: f => { f.row.trustV3.cases.restart.processes.pop(); },
  'version-fallback': f => { f.folder.set('compatibility-1.0.37', Buffer.from('another binary')); },
  'level-drop': f => editJson(f, f.row.trustV3.cases['lower-ask'].processes[1].authority, a => { a.level = 'auto'; }),
  withheld: f => { f.folder.set(f.row.trustV3.cases['saved-decline'].processes[0].stores.seed.after, Buffer.from('persisted grant')); },
  stop: f => editJson(f, f.row.trustV3.cases.stop.processes[0].observation, o => { o.stoppedAt = o.createdAt; }),
  retained: f => editJson(f, f.row.trustV3.cases['cloud-routed'].processes[0].observation, o => { o.destination = 'own-local-home'; }),
  artifact: f => { f.folder.set('artifact-package', Buffer.from('replaced artifact')); },
  'release-identity': f => { f.expected.murageSha = 'd'.repeat(40); },
});
export function clauseFixture(name) {
  const [clause, kind] = name.split(':');
  if (!Object.hasOwn(INVALID, clause) || !['valid', 'invalid'].includes(kind)) throw new Error('unknown clause fixture');
  const fixture = trustV3Fixture();
  if (kind === 'invalid') INVALID[clause](fixture);
  return fixture;
}

/** Complete synthetic packets retain every historical case and add the v3 facts. */
export function trustReleaseFixture(targets) {
  const runs = fixtureRuns(), expected = { targets: {} };
  const files = targets ? targets.map((target, index) => {
    const file = toFiles({ run: runs[FUIGO_TARGET_OSES[target]] })[0];
    const date = `2026-12-${String(index + 1).padStart(2, '0')}`, nonce = (index + 1).toString(16).padStart(16, '0');
    const move = text => text.replaceAll(file.row.nonce, nonce).replace(/2026-11-0[123]/g, date).replace(/2026110[123]/g, date.replaceAll('-', ''));
    const row = JSON.parse(move(JSON.stringify(file.row)));
    // The base run streams its marker in pieces, so the moved nonce goes in whole (as fuigo-bump-fixture does for its moved runs).
    const whole = (name, text) => {
      if (!file.row.files.transcripts.includes(name)) return text;
      const records = text.trim().split('\n').map(JSON.parse);
      const chunks = records.filter(record => record.msg?.params?.update?.sessionUpdate === 'agent_message_chunk');
      if (chunks.map(record => record.msg.params.update.content.text).join('').includes(`MARK-${file.row.nonce}`)) {
        for (const record of chunks) record.msg.params.update.content.text = '';
        chunks[0].msg.params.update.content.text = `MARK-${file.row.nonce}`;
      }
      return records.map(record => JSON.stringify(record)).join('\n') + '\n';
    };
    return { name: `${target}.json`, row, folder: new Map([...file.folder].map(([name, bytes]) => [move(name), Buffer.from(move(whole(name, bytes.toString())))])) };
  }) : toFiles(runs);
  let want;
  for (const [index, file] of files.entries()) {
    const f = trustV3Fixture(targets?.[index] ?? file.row.target);
    Object.assign(expected, { ...f.expected, targets: { ...expected.targets, ...f.expected.targets } });
    const oldBinary = WANT.assets[file.row.target].binarySha256;
    const replace = text => text.replaceAll(WANT.version, f.row.fuigoVersion)
      .replaceAll(WANT.packageVersion, f.row.packageVersion).replaceAll(WANT.murageSha, expected.murageSha)
      .replaceAll(WANT.peeledTag, expected.sourceRevision).replaceAll(oldBinary, f.row.binarySha256);
    const driver = JSON.parse(file.folder.get(file.row.files.driver));
    for (const [name, bytes] of file.folder) {
      let text = replace(bytes.toString());
      if (file.row.files.transcripts.includes(name)) {
        const records = text.trim().split('\n').map(JSON.parse);
        for (const record of records) if (record.msg?.id === 3 && record.msg.method === undefined)
          record.msg.result._meta = { 'fuigo/permissionPolicy': { sha256: f.row.policySha256 } };
        const completed = records.findIndex(r => r.msg?.params?.update?.sessionUpdate === 'tool_call_update' && r.msg.params.update.status === 'completed');
        if (driver.processes[name]?.level === 'ask' && completed >= 0 && !records.some(r => r.msg?.method === 'session/request_permission')) {
          const result = records[completed], command = result.msg.params.update.rawOutput?.command;
          records.splice(completed, 0,
            { t: result.t, dir: 'out', msg: { id: 99, method: 'session/request_permission', params: { sessionId: result.msg.params.sessionId, toolCall: { kind: 'execute', toolCallId: result.msg.params.update.toolCallId, rawInput: { command } }, options: [{ optionId: 'allow-once', kind: 'allow_once' }] } } },
            { t: result.t, dir: 'in', msg: { id: 99, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } } });
        }
        text = records.map((record, index) => JSON.stringify({ ...record, seq: index + 1 })).join('\n') + '\n';
      }
      file.folder.set(name, Buffer.from(text));
    }
    Object.assign(file.row, f.row);
    file.row.steps.g1 = { processes: [file.row.steps.g2.processes[0]] };
    for (const [name, bytes] of f.folder) { file.folder.set(name, bytes); file.row.files.other.push(name); }
    file.row.sha256 = Object.fromEntries([...file.folder].map(([name, bytes]) => [name, hash(bytes)]));
    want = { version: f.row.fuigoVersion, peeledTag: expected.sourceRevision, murageSha: expected.murageSha,
      packageVersion: expected.packageVersion, policySha256: f.row.policySha256 };
  }
  want.assets = Object.fromEntries(Object.entries(expected.targets).map(([target, value]) => [target, { binarySha256: value.binary, tarballSha256: '0'.repeat(64) }]));
  files.sort((a, b) => (a.name < b.name ? -1 : 1)); // the CLI reads the captures folder in name order
  const receipt = { schema: 3, ...want, fuigoVersion: want.version, real_turns: checkRealTurns(files, want) };
  return { files, expected, receipt };
}
