import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTempDirSync } from '../server/testing/cleanup.ts';
import { writeTapShim } from './fuigo-trust-capture.mjs';

const TAP = fileURLToPath(new URL('./fuigo-trust-tap.mjs', import.meta.url));
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

// A stand-in agent on the far side of the tap: answers session/new with its pid, asks folder trust, then answers the prompt.
const AGENT = `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('fuigo 1.0.48\\n'); process.exit(0); }
let held = '';
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
process.stdin.on('data', chunk => {
  held += chunk;
  for (let at = held.indexOf('\\n'); at >= 0; at = held.indexOf('\\n')) {
    const line = held.slice(0, at); held = held.slice(at + 1);
    let msg; try { msg = JSON.parse(line); } catch { process.stdout.write('agent-saw-non-json\\n'); continue; }
    if (msg.method === 'session/new') { send({ id: msg.id, result: { sessionId: 's1', _meta: { pid: process.pid } } }); send({ id: 'trust-1', method: '_fuigo/folder_trust/request', params: { workspace: msg.params.cwd, scope: 'configAndCommands' } }); }
    else if (msg.method === 'session/new-then-close-stdin') { send({ id: 'trust-1', method: '_fuigo/folder_trust/request', params: { workspace: msg.params.cwd, scope: 'configAndCommands' } }); process.stdin.destroy(); import('node:fs').then(fs => { try { fs.closeSync(0); } catch {} }); setTimeout(() => process.exit(0), 400); }
    else if (msg.method === 'session/prompt') { send({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', status: 'completed' } } }); send({ id: msg.id, result: { stopReason: 'end_turn' } }); }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-tap-')); dirs.push(dir);
  // An absolute interpreter, as a native fuigo needs no PATH (the version probe runs with a stripped env).
  const real = join(dir, 'agent.mjs'); writeFileSync(real, AGENT.replace('#!/usr/bin/env node', `#!${process.execPath}`)); chmodSync(real, 0o755);
  return { dir, real };
};
/** Plays Murage: writes each chunk after the agent output so far contains `waitFor` (and `pauseMs` later, so pipe
 * writes stay separate chunks), collects every stdout byte. */
const drive = ({ dir, real }, steps) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [TAP, 'agent', 'stdio'], { env: { ...process.env, MURAGE_TRUST_TAP_REAL: real, MURAGE_TRUST_TAP_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '', step = 0, paused = false;
  const next = () => {
    while (!paused && step < steps.length && out.includes(steps[step].waitFor ?? '')) {
      if (steps[step].pauseMs) { paused = true; setTimeout(() => { paused = false; child.stdin.write(steps[step++].write); next(); }, steps[step].pauseMs); return; }
      child.stdin.write(steps[step++].write);
    }
    if (!paused && step === steps.length) child.stdin.end();
  };
  child.stdout.on('data', chunk => { out += chunk; next(); });
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', reject);
  child.on('close', code => resolve({ code, out, err }));
  next();
});
const captures = dir => readdirSync(dir).filter(name => name.startsWith('proc-')).sort();
const line = msg => `${JSON.stringify(msg)}\n`;
const NEW = { id: 1, method: 'session/new', params: { cwd: '/fixture/workspace' } };
const REPLY = { id: 'trust-1', result: { outcome: 'trust', scope: 'configAndCommands', duration: 'process' } };
const PROMPT = { id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'fixture command' }] } };

describe('W-TAP1 the tap records the real stdio RPC in checker order and forwards every byte', () => {
  it('ordered raw records, exact passthrough, process identity and the reply write time', async () => {
    const s = setup();
    const run = await drive(s, [{ write: line(NEW) }, { waitFor: 'trust-1', write: line(REPLY) }, { write: line(PROMPT) }, { waitFor: 'end_turn', write: '' }]);
    expect(run.code, run.err).toBe(0);
    const [transcriptFile, observationFile] = captures(s.dir);
    const records = readFileSync(join(s.dir, transcriptFile), 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text));
    expect(records.map(r => [r.seq, r.dir, r.msg.method ?? `reply:${r.msg.id ?? ''}`])).toEqual([
      [1, 'in', 'session/new'], [2, 'out', 'reply:1'], [3, 'out', '_fuigo/folder_trust/request'], [4, 'in', 'reply:trust-1'],
      [5, 'in', 'session/prompt'], [6, 'out', 'session/update'], [7, 'out', 'reply:2']]);
    expect(records.every((r, n) => n === 0 || Date.parse(r.t) >= Date.parse(records[n - 1].t)), 'RPC clock never moves backwards').toBe(true);
    expect(records[0].msg).toEqual(NEW); expect(records[3].msg).toEqual(REPLY); expect(records[4].msg).toEqual(PROMPT);
    expect(run.out, 'Murage receives exactly the agent bytes').toBe(records.filter(r => r.dir === 'out').map(r => line(r.msg)).join(''));
    const observed = JSON.parse(readFileSync(join(s.dir, observationFile), 'utf8'));
    expect(observed).toMatchObject({ source: 'capture-driver', pid: records[1].msg.result._meta.pid, cwd: '/fixture/workspace', exitCode: 0, faults: [],
      binarySha256: createHash('sha256').update(readFileSync(s.real)).digest('hex') });
    expect(observed.argv.includes('--trust'), 'no automatic launch grant').toBe(false);
    expect(Date.parse(observed.replyWrittenAt) >= Date.parse(records[3].t) && Date.parse(observed.replyWrittenAt) <= Date.parse(records[4].t),
      'replyWrittenAt is the trust reply write callback, before the prompt').toBe(true);
    expect(Date.parse(observed.createdAt) <= Date.parse(records[0].t) && Date.parse(observed.exitedAt) >= Date.parse(records.at(-1).t), 'capture inside the process lifetime').toBe(true);
  });
});

describe('W-TAP2 framing: split chunks and non-JSON lines', () => {
  it('a message split across writes is one record; a non-JSON line is a fault, still forwarded', async () => {
    const s = setup(), text = line(NEW);
    const run = await drive(s, [{ write: text.slice(0, 20) }, { pauseMs: 150, write: text.slice(20) }, { pauseMs: 150, write: 'not json\n' }, { waitFor: 'agent-saw-non-json', write: '' }]);
    expect(run.code, run.err).toBe(0);
    const [transcriptFile, observationFile] = captures(s.dir);
    const records = readFileSync(join(s.dir, transcriptFile), 'utf8').split('\n').filter(Boolean).map(t => JSON.parse(t));
    expect(records.filter(r => r.dir === 'in').map(r => r.msg), 'split message recorded once and whole').toEqual([NEW]);
    expect(run.out.includes('agent-saw-non-json'), 'non-JSON bytes still reach the agent').toBe(true);
    expect(JSON.parse(readFileSync(join(s.dir, observationFile), 'utf8')).faults.map(f => [f.dir, f.error]), 'non-JSON lines are faults').toEqual([['in', 'non-JSON line'], ['out', 'non-JSON line']]);
  });
});

describe('W-TAP3 every agent process gets its own capture', () => {
  it('two invocations never overwrite each other', async () => {
    const s = setup();
    await drive(s, [{ write: line(NEW) }, { waitFor: 'trust-1', write: '' }]);
    await drive(s, [{ write: line(NEW) }, { waitFor: 'trust-1', write: '' }]);
    expect(captures(s.dir).length, 'two transcript + observation pairs').toBe(4);
  });
});

describe('W-TAP4 the PATH shim works under the stripped version-probe environment', () => {
  it('fuigo --version answers through the tap with an empty env, and a session through the shim is captured', async () => {
    const s = setup(), shim = writeTapShim({ real: s.real, dir: join(s.dir, 'cap'), shimDir: join(s.dir, 'bin') });
    const probe = spawnSync(shim, ['--version'], { env: {}, encoding: 'utf8' });
    expect(probe.stdout, probe.stderr).toBe('fuigo 1.0.48\n');
    const child = spawn(shim, ['agent', 'stdio'], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; if (out.includes('trust-1')) child.stdin.end(); });
    child.stdin.write(line(NEW));
    await new Promise(done => child.on('close', done));
    const transcripts = readdirSync(join(s.dir, 'cap')).filter(name => name.endsWith('.jsonl')).map(name => readFileSync(join(s.dir, 'cap', name), 'utf8')).filter(Boolean);
    expect(transcripts.map(text => text.split('\n').filter(Boolean).map(t => JSON.parse(t).msg.method ?? 'reply')), 'the session went through the tap').toEqual([['session/new', 'reply', '_fuigo/folder_trust/request']]);
  });
});

describe('W-TAP5 an agent that stops reading cannot crash the tap or fake a delivered reply', () => {
  it('EPIPE on the trust reply is a fault, no replyWrittenAt, and the observation is still written', async () => {
    const s = setup();
    const run = await drive(s, [{ write: line({ ...NEW, method: 'session/new-then-close-stdin' }) }, { waitFor: 'trust-1', pauseMs: 150, write: line(REPLY) }]);
    expect(run.code, run.err).toBe(0);
    const [, observationFile] = captures(s.dir);
    const observed = JSON.parse(readFileSync(join(s.dir, observationFile), 'utf8'));
    expect([observed.replyWrittenAt, observed.faults.map(f => [f.dir, f.error])], 'failed reply write is a fault, never delivered').toEqual([undefined, [['in', 'EPIPE']]]);
  });
});

describe('W-TAP6 a hangup reaches the agent through the tap', () => {
  it('SIGHUP to the tap is forwarded: the agent ends on SIGHUP and the observation is still written', async () => {
    const s = setup();
    const child = spawn(process.execPath, [TAP, 'agent', 'stdio'], { env: { ...process.env, MURAGE_TRUST_TAP_REAL: s.real, MURAGE_TRUST_TAP_DIR: s.dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; if (out.includes('trust-1')) child.kill('SIGHUP'); });
    child.stdin.write(line(NEW));
    const [code, signal] = await new Promise(done => child.on('close', (c, sig) => done([c, sig])));
    const observationFile = captures(s.dir).find(name => name.endsWith('.observation.json'));
    const observed = observationFile ? JSON.parse(readFileSync(join(s.dir, observationFile), 'utf8')) : {};
    expect([signal, observed.exitSignal], 'tap survives to record the agent ending on the forwarded SIGHUP').toEqual([null, 'SIGHUP']);
    expect(code).toBe(1);
  });
});
