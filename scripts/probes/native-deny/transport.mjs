// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseTranscript, digest } from './results.mjs';

const OUTPUT_LIMIT = 4 * 1024 * 1024;
export function startChild(binary, args, { env, cwd, timeoutMs = 120000, signal, targets = [] }) {
  const child = spawn(binary.command, [...binary.args, ...args], {
    env, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    detached: process.platform !== 'win32', windowsHide: true,
  });
  let stdout = '', stderr = '', bytes = 0, failure = null, done = false;
  const lineListeners = new Set();
  let pending = '';
  function stop() {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      // Only the exact PID that this invocation spawned, never a name match.
      const root = env.SystemRoot || env.WINDIR;
      if (root) spawnSync(join(root, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env, stdio: 'ignore', windowsHide: true, timeout: 10000 });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ??= 'PROCESS-CLEANUP'; }
    }
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
  const timer = setTimeout(() => { failure = 'TIMEOUT'; stop(); }, timeoutMs);
  const abort = () => { failure = 'INTERRUPTED'; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.stdin.on('error', () => { /* reported by close/error, never dump engine text */ });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const capture = (stream, chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > OUTPUT_LIMIT) { failure = 'OUTPUT-LIMIT'; stop(); return; }
    if (stream === 'stdout') {
      stdout += chunk;
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        for (const listener of lineListeners) listener(line);
      }
    } else stderr += chunk;
  };
  child.stdout.on('data', chunk => capture('stdout', chunk));
  child.stderr.on('data', chunk => capture('stderr', chunk));
  const completion = new Promise(resolve => {
    child.on('error', () => { failure = 'SPAWN-ERROR'; });
    child.on('close', (code, exitSignal) => {
      done = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      stop(); // kill any remaining members of our process group before fixture removal
      resolve({ stdout, stderr, code, exitSignal, failure, facts: parseTranscript(stdout, targets),
        trace: { stdoutSha256: digest(stdout), stderrSha256: digest(stderr), bytes } });
    });
  });
  if (signal?.aborted) abort();
  return { child, completion, stop, get done() { return done; }, onLine: listener => lineListeners.add(listener) };
}

export async function runCli(binary, args, options, input = '') {
  const proc = startChild(binary, args, options);
  proc.child.stdin.end(input);
  return proc.completion;
}

export function rpcClient(binary, args, options, onRequest = () => undefined) {
  const proc = startChild(binary, args, options);
  let sequence = 0;
  const pending = new Map(), events = [];
  const write = msg => { if (!proc.done) proc.child.stdin.write(`${JSON.stringify(msg)}\n`); };
  proc.onLine(line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && !msg.method) {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.code === -32000 && /auth|login/i.test(msg.error.message ?? '') ? 'SKIP-NO-AUTH' : 'RPC-ERROR'));
        else waiter.resolve(msg.result);
      }
    } else {
      events.push(msg);
      if (msg.id !== undefined && msg.method) {
        try {
          const result = onRequest(msg);
          write(result === undefined ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Probe does not implement this method' } } :
            { jsonrpc: '2.0', id: msg.id, result });
        } catch { proc.stop(); }
      }
    }
  });
  proc.completion.then(() => {
    for (const waiter of pending.values()) waiter.reject(new Error('RPC-CLOSED'));
    pending.clear();
  });
  return {
    events, proc, notify: (method, params = {}) => write({ jsonrpc: '2.0', method, params }),
    call(method, params) {
      if (proc.done) return Promise.reject(new Error('RPC-CLOSED'));
      const id = ++sequence;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); write({ jsonrpc: '2.0', id, method, params }); });
    },
    async close() { proc.stop(); return proc.completion; },
  };
}

// File operations requested through ACP are restricted to plain fixture files;
// no terminal capability is advertised (native shell must remain engine-owned).
export async function runAcp(binary, args, options, prompts, { permission, meta = {}, checkSession } = {}) {
  const asks = [];
  const client = rpcClient(binary, args, options, msg => {
    if (msg.method === 'session/request_permission') {
      const options = msg.params?.options ?? [];
      const index = asks.length;
      asks.push(msg.params);
      const allowed = permission?.(msg.params, index) === true;
      const selected = options.find(option => option.kind === (allowed ? 'allow_once' : 'reject_once'));
      return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    if (['fuigo/folder_trust/request', '_fuigo/folder_trust/request'].includes(msg.method)) return { outcome: 'trust', scope: 'configAndCommands', duration: 'process' };
    // No authenticate, login, filesystem or terminal fallback requests.
    return undefined;
  });
  let completed = false, failure = null, results = [];
  try {
    await client.call('initialize', { protocolVersion: 1, clientInfo: { name: 'native-deny-probe', version: '1.0.0' }, clientCapabilities: {} });
    const session = await client.call('session/new', { cwd: options.cwd, mcpServers: [], _meta: meta });
    if (typeof session?.sessionId !== 'string') throw new Error('ACP-SESSION');
    checkSession?.(session);
    for (const prompt of prompts) {
      const result = await client.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] });
      if (!['end_turn', 'max_turn_requests'].includes(result?.stopReason)) throw new Error('ACP-TURN-INCOMPLETE');
      results.push(result);
    }
    completed = true;
  } catch (error) { failure = error.message === 'SKIP-NO-AUTH' ? error.message : 'ACP-FAILED'; }
  const output = await client.close();
  return { ...output, failure: output.failure ?? failure, completed, asks, events: client.events, results };
}
