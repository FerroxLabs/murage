import { createHash } from 'node:crypto';
import { fuigoTargetFromPackage } from './prepare-fuigo.mjs';
import { describe, expect, it } from 'vitest';
import { checkTrustV3, TRUST_V3_CASES, REQUIRED_CASES, TRUST_SOURCE_AREAS } from './fuigo-trust-evidence-v3.mjs';
import { trustV3Fixture, clauseFixture } from './fuigo-trust-evidence-v3.fixture.mjs';
const edit = (fixture, file, change) => {
  const value = JSON.parse(fixture.folder.get(file)); change(value); fixture.folder.set(file, Buffer.from(JSON.stringify(value)));
};
const primary = f => f.row.trustV3.cases['picked-primary'].processes[0];
describe('schema 3 semantic clauses', () => {
  it('a schema-2 header cannot make a complete schema-3 packet ready', () => {
    const f = trustV3Fixture();
    expect(() => checkTrustV3({ ...f.row, schema: 2 }, f.folder, f.expected)).toThrow(/clause:schema/);
  });
  it('accepts complete synthetic semantic controls (never a real qualification packet)', () => {
    const f = trustV3Fixture(); expect(checkTrustV3(f.row, f.folder, f.expected).cases).toBe(TRUST_V3_CASES.length);
  });
  it('T-TRUST-F06-artifact-identity: internally consistent artifacts cannot select the release SHA they certify', () => {
    const f = trustV3Fixture();
    expect(() => checkTrustV3(f.row, f.folder, { ...f.expected, murageSha: 'd'.repeat(40) })).toThrow(/expected release identity differs/);
  });
  it('a governed Ask row acknowledges the exact supplied policy', () => {
    const f = trustV3Fixture(), p = f.row.trustV3.cases['lower-ask'].processes[1];
    p.policySha256 = 'd'.repeat(64);
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/policy acknowledgement/);
  });
  it('a recorded Stop may leave its pending prompt unanswered without waiving other RPCs', () => {
    const f = trustV3Fixture(), p = f.row.trustV3.cases.stop.processes[0];
    const lines = f.folder.get(p.transcript).toString().trim().split('\n'); lines.pop();
    f.folder.set(p.transcript, Buffer.from(lines.join('\n')));
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).not.toThrow();
  });
  it('malformed structured evidence fails with a clause instead of a parser crash', () => {
    const f = trustV3Fixture(); f.folder.set(f.row.trustV3.artifacts, Buffer.from('null'));
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/artifact manifest: object required/);
  });
  it.each(TRUST_V3_CASES)('requires case %s', id => {
    const f = trustV3Fixture(); delete f.row.trustV3.cases[id]; expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(id);
  });
  it.each(['package', 'binary', 'policy', 'capture-driver', 'source-review', 'source-bundle'])('recomputes actual %s artifact bytes', role => {
    const f = trustV3Fixture(); f.folder.set(`artifact-${role}`, Buffer.from('replaced artifact')); expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(`${role}: actual artifact digest differs`);
  });
  it.each([
    ['duration', (f, p) => { const lines = f.folder.get(p.transcript).toString().trim().split('\n').map(JSON.parse); delete lines[3].msg.result.duration; f.folder.set(p.transcript, Buffer.from(lines.map(JSON.stringify).join('\n'))); }, /process-duration/],
    ['write order', (f, p) => edit(f, p.observation, o => { o.replyWrittenAt = '2035-01-01T00:00:00Z'; }), /write callback/],
    ['origin', (f, p) => edit(f, p.authority, a => { a.origin = 'webhook'; }), /owner proof/],
    ['actor', (f, p) => edit(f, p.authority, a => { a.actor = 'other'; }), /owner proof/],
    ['level label', (f, p) => edit(f, p.authority, a => { a.generation = 'another-generation'; }), /actor\/level receipt/],
    ['picked key', (f, p) => { for (const file of [p.stores.murage.before, p.stores.murage.after]) edit(f, file, s => { s.folders['/fixture/other'] = s.folders['/fixture/workspace']; delete s.folders['/fixture/workspace']; }); }, /picked record/],
    ['persistence', (f, p) => { f.folder.set(p.stores.seed.after, Buffer.from('a new grant')); }, /seed store changed/],
    ['store home', (f, p) => { p.stores.own.home = '/fixture/another-home'; }, /home\/read window/],
    ['after next invocation', (f, p) => edit(f, p.observation, o => { o.nextInvocationAt = o.createdAt; }), /home\/read window/],
    ['missing marker', (f, p) => edit(f, p.modelInputs, m => { m.bytes = 'ordinary input'; }), /first-turn marker absent/],
    ['hidden partial RPC', (f, p) => { const lines = f.folder.get(p.transcript).toString().trim().split('\n'); lines.pop(); f.folder.set(p.transcript, Buffer.from(lines.join('\n'))); }, /partial or duplicate RPC/],
    ['model input process', (f, p) => edit(f, p.modelInputs, m => { m.processId = 'another-process'; }), /another process\/turn/],
    ['non-wipe output', (f, p) => { f.row.trustV3.cases['picked-primary'].commandMarker = 'unobserved-command-marker'; }, /command output/],
  ])('rejects %s with a named clause', (_name, change, clause) => {
    const f = trustV3Fixture(); change(f, primary(f)); expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(clause);
  });
  it('rejects configuration bytes in an unpicked row', () => {
    const f = trustV3Fixture(), p = f.row.trustV3.cases.unpicked.processes[0]; edit(f, p.modelInputs, m => { m.bytes = p.marker; });
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/rejected configuration marker/);
  });
  it('rejects a process grant for an unpicked request', () => {
    const f = trustV3Fixture(), p = f.row.trustV3.cases.unpicked.processes[0];
    const lines = f.folder.get(p.transcript).toString().trim().split('\n').map(JSON.parse); lines[3].msg.result = { outcome: 'trust', scope: 'configAndCommands', duration: 'process' };
    f.folder.set(p.transcript, Buffer.from(lines.map(JSON.stringify).join('\n')));
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/configuration must be rejected/);
  });
});

describe('K15 section 2.10 frozen Q1–Q5 clause manifest', () => {
  it('every-clause-has-valid-and-invalid-fixture', () => {
    const clauses = ['rpc-order', 'key-binding', 'process-identity', 'authority-receipt', 'command-effect',
      'primary-positive', 'unpicked-negative', 'restart', 'version-fallback', 'level-drop',
      'withheld', 'stop', 'retained', 'artifact', 'release-identity'];
    expect(Object.isFrozen(REQUIRED_CASES)).toBe(true);
    expect(REQUIRED_CASES.map(entry => entry.clause)).toEqual(clauses);
    expect(REQUIRED_CASES.map(entry => entry.schema2Origin)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', ...Array(10).fill(null)]);
    for (const entry of REQUIRED_CASES) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.keys(entry).sort()).toEqual(['clause', 'schema2Origin', 'validFixture', 'invalidFixture', 'test'].sort());
      expect(entry.test).toBe('every-clause-has-valid-and-invalid-fixture');
      const valid = clauseFixture(entry.validFixture), invalid = clauseFixture(entry.invalidFixture);
      expect(() => checkTrustV3(valid.row, valid.folder, valid.expected), entry.validFixture).not.toThrow();
      expect(() => checkTrustV3(invalid.row, invalid.folder, invalid.expected), entry.invalidFixture)
        .toThrow(new RegExp(`clause:${entry.clause}(?::|$)`));
    }
  });
});

describe('artifact and source-review boundaries', () => {
  it('G10: the actual pinned source review is mandatory', () => {
    const f = trustV3Fixture(); f.folder.delete('artifact-source-review');
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/clause:artifact/);
  });
  it.each(TRUST_SOURCE_AREAS)('requires source review area %s on the actual revision', area => {
    const f = trustV3Fixture();
    edit(f, 'artifact-source-review', review => { delete review.areas[area]; });
    const digest = createHash('sha256').update(f.folder.get('artifact-source-review')).digest('hex');
    f.expected.targets[f.row.target]['source-review'] = digest;
    edit(f, f.row.trustV3.artifacts, manifest => { manifest.artifacts['source-review'].sha256 = digest; });
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/clause:artifact: source review omits/);
  });
  it.each(['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64'])('uses the exact package mapping for %s', target => {
    const f = trustV3Fixture(target);
    expect(fuigoTargetFromPackage(`@fuigo/${target}`)).toBe(target);
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).not.toThrow();
    edit(f, f.row.trustV3.artifacts, manifest => { manifest.fuigoPackage += '-extra'; });
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/clause:artifact/);
  });
  it('binds signing transformations to both exact binaries', () => {
    const f = trustV3Fixture(), transformation = { upstreamSha256: 'e'.repeat(64), packagedSha256: f.row.binarySha256, kind: 'fixture-signing' };
    f.expected.targets[f.row.target].binaryTransformation = transformation;
    f.row.upstreamBinarySha256 = transformation.upstreamSha256;
    edit(f, f.row.trustV3.artifacts, manifest => { manifest.artifacts.binary.transformation = transformation; });
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).not.toThrow();
    f.row.upstreamBinarySha256 = 'f'.repeat(64);
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/clause:artifact/);
  });
  it('does not promote a partial or runaway process into a required step', () => {
    const f = trustV3Fixture(), p = primary(f);
    f.row.modelFailures = [{ file: p.transcript, reason: 'open-at-close' }];
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/clause:primary-positive.*model failure/);
  });
  it('a same PID with a new creation identity is a fresh process', () => {
    const f = trustV3Fixture(), [old, fresh] = f.row.trustV3.cases.restart.processes;
    const previous = JSON.parse(f.folder.get(old.observation)), next = JSON.parse(f.folder.get(fresh.observation));
    edit(f, fresh.observation, o => { o.pid = previous.pid; });
    edit(f, fresh.modelInputs, model => { model.processId = `${previous.pid}:${next.createdAt}`; });
    for (const pair of Object.values(fresh.stores)) pair.processId = `${previous.pid}:${next.createdAt}`;
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).not.toThrow();
    edit(f, old.observation, o => { o.exitedAt = next.exitedAt; });
    expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/clause:process-identity.*old process survives/);
  });
});

it('malformed raw records and process clocks fail their named clauses', () => {
  const rpc = trustV3Fixture(), clock = trustV3Fixture(), output = trustV3Fixture();
  rpc.folder.set(primary(rpc).transcript, Buffer.from('null\n'));
  expect(() => checkTrustV3(rpc.row, rpc.folder, rpc.expected)).toThrow(/clause:rpc-order/);
  edit(clock, primary(clock).observation, observed => { observed.createdAt = { toString: null }; });
  expect(() => checkTrustV3(clock.row, clock.folder, clock.expected)).toThrow(/clause:process-identity/);
  const p = primary(output), records = output.folder.get(p.transcript).toString().trim().split('\n').map(JSON.parse);
  for (const record of records) if (record.msg.params?.update?.status === 'completed') delete record.msg.params.update.content;
  output.folder.set(p.transcript, Buffer.from(records.map(JSON.stringify).join('\n')));
  expect(() => checkTrustV3(output.row, output.folder, output.expected)).toThrow(/clause:command-effect/);
});

it('an incomplete projection count alone cannot replace the raw saved declines', () => {
  const f = trustV3Fixture(), p = f.row.trustV3.cases['incomplete-seed'].processes[0];
  for (const file of [p.stores.murage.before, p.stores.murage.after]) edit(f, file, saved => {
    saved.folders = Object.fromEntries(Object.entries(saved.folders).filter(([, record]) => record.decision !== 'reject'));
  });
  expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/clause:withheld.*incomplete decline projection/);
});
it.each(['lower-ask', 'lower-ask-reject'])('%s has no surviving configuration marker after lowering to Ask', id => {
  const f = trustV3Fixture(), p = f.row.trustV3.cases[id].processes[1];
  edit(f, p.modelInputs, model => { model.bytes = p.marker; });
  expect(() => checkTrustV3(f.row, f.folder, f.expected)).toThrow(/clause:level-drop.*rejected configuration marker/);
});
