#!/usr/bin/env node
// Producer: MAIN capture hosts (q1024-trustcapture). Consumer: scripts/fuigo-trust-capture.mjs -> fuigo-trust-evidence-v3 captureView.
// The ACP stdio tap: Murage spawns this in place of fuigo (a PATH shim), it spawns the real binary and forwards every byte
// unchanged, and records each newline-delimited JSON-RPC message as { seq, t, dir, msg } (dir "in" = Murage -> Fuigo).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TRUST_METHODS = new Set(['fuigo/folder_trust/request', '_fuigo/folder_trust/request']);

/** Splits a byte stream into lines; complete lines only, the rest is held for the next chunk. */
const lineSplitter = onLine => {
  let held = Buffer.alloc(0);
  return {
    push(chunk) {
      held = Buffer.concat([held, chunk]);
      for (let at = held.indexOf(10); at >= 0; at = held.indexOf(10)) { onLine(held.subarray(0, at)); held = held.subarray(at + 1); }
    },
    rest: () => held,
  };
};

/** Runs the real binary behind the tap. Resolves with the observation once the child has exited and every record is on disk. */
export function runTap({ real, args = [], transcript, observation, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, now = () => new Date() }) {
  if (!real || !transcript || !observation) throw new Error('fuigo-trust-tap: real binary, transcript and observation paths are required');
  writeFileSync(transcript, '');
  const binarySha256 = createHash('sha256').update(readFileSync(real)).digest('hex');
  const observed = { source: 'capture-driver', argv: [real, ...args], binarySha256, faults: [] };
  const trustAsks = new Set();
  let seq = 0;
  const record = (dir, line) => {
    const text = line.toString('utf8');
    if (!text.trim()) return null;
    let msg;
    try { msg = JSON.parse(text); } catch { observed.faults.push({ dir, at: now().toISOString(), error: 'non-JSON line', bytes: text.length }); return null; }
    const entry = { seq: ++seq, t: now().toISOString(), dir, msg };
    appendFileSync(transcript, `${JSON.stringify(entry)}\n`);
    if (dir === 'out' && msg && TRUST_METHODS.has(msg.method)) trustAsks.add(msg.id);
    if (dir === 'in' && msg && msg.method === undefined && trustAsks.has(msg.id)) return 'trust-reply';
    if (dir === 'in' && msg && ['session/new', 'session/load'].includes(msg.method) && observed.cwd === undefined) observed.cwd = msg.params?.cwd;
    return null;
  };
  return new Promise((resolve, reject) => {
    const child = spawn(real, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    observed.pid = child.pid;
    // An agent that stops reading (EPIPE) or a Murage that stops reading must not crash the tap before the observation is written.
    child.stdin.on('error', error => observed.faults.push({ dir: 'in', at: now().toISOString(), error: error.code ?? error.message }));
    stdout.on?.('error', error => observed.faults.push({ dir: 'out', at: now().toISOString(), error: error.code ?? error.message }));
    observed.createdAt = now().toISOString();
    const fromAgent = lineSplitter(line => record('out', line));
    child.stdout.on('data', chunk => { fromAgent.push(chunk); stdout.write(chunk); });
    child.stderr.on('data', chunk => stderr.write(chunk));
    // A reply's write callback is the moment the agent can read it: replyWrittenAt is taken there, never at receipt.
    // Inbound lines are handled one at a time, and the line after a trust reply waits for that reply's write callback, so
    // every later inbound record (the first prompt included) is stamped after replyWrittenAt.
    let inbound = Promise.resolve();
    const forward = (line, ending) => new Promise(done => {
      // A failed write is a fault, never a delivered reply.
      if (record('in', line) === 'trust-reply') child.stdin.write(Buffer.concat([line, ending]), error => { if (!error) observed.replyWrittenAt ??= now().toISOString(); done(); });
      else { child.stdin.write(Buffer.concat([line, ending])); done(); }
    });
    const toAgent = lineSplitter(line => { inbound = inbound.then(() => forward(line, Buffer.from('\n'))); });
    const onInput = chunk => toAgent.push(chunk);
    stdin.on('data', onInput);
    stdin.on('end', () => { inbound = inbound.then(async () => { const rest = toAgent.rest(); if (rest.length) await forward(rest, Buffer.alloc(0)); child.stdin.end(); }); });
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => child.kill(signal));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      stdin.off('data', onInput);
      const rest = fromAgent.rest(); if (rest.length) record('out', rest);
      Object.assign(observed, { exitedAt: now().toISOString(), exitCode: code, exitSignal: signal });
      writeFileSync(observation, `${JSON.stringify(observed, null, 2)}\n`);
      resolve(observed);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // One file pair per agent process (version probes included), so no invocation ever overwrites another's capture.
  const { MURAGE_TRUST_TAP_REAL: real, MURAGE_TRUST_TAP_DIR: dir } = process.env;
  const base = dir && join(dir, `proc-${process.pid}-${Date.now()}`);
  runTap({ real, args: process.argv.slice(2), transcript: base && `${base}.jsonl`, observation: base && `${base}.observation.json` })
    .then(observed => { process.exitCode = observed.exitCode ?? 1; stdinRelease(); })
    .catch(error => { console.error(error.message); process.exitCode = 1; stdinRelease(); });
}
function stdinRelease() { process.stdin.pause(); process.stdin.unref?.(); }
