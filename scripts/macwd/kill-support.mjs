import assert from 'node:assert/strict';
import path from 'node:path';

export const killPhases = ['handoff-prepared', 'offline-claimed', 'capturing'];

export function resolveApp(input, exists) {
  const root = path.resolve(input);
  const app = root.endsWith('.app') ? root :
    ['dist/mac-arm64', 'dist/mac', 'release/mac-arm64', 'release/mac']
      .map(dir => path.join(root, dir, 'Murage.app')).find(exists);
  assert.ok(app && exists(path.join(app, 'Contents/MacOS/Murage')),
    'Build the dev tree with electron-builder --mac dir, or pass a .app path');
  return app;
}

// Installed only in the disposable qualification copy. The original save
// returns after writeFileAtomic(..., syncDir:true). Never write coordinator state.
export function installCommitStop(prototype, {target, committed, stop}) {
  const save = prototype.save;
  assert.equal(typeof save, 'function', 'coordinator durable save boundary required');
  prototype.save = function(state) {
    const result = save.call(this, state);
    if (killPhases.includes(state.job?.phase) && state.job.phase === target()) {
      committed(this.file(), state.job.phase);
      stop();
    }
    return result;
  };
  return () => { prototype.save = save; };
}

export function processTree(root, rows) {
  assert.ok(Number.isSafeInteger(root) && root > 1, 'owned root PID required');
  const found = new Set([root]);
  for (;;) {
    const before = found.size;
    for (const {pid, ppid} of rows) if (found.has(ppid) && pid > 1) found.add(pid);
    if (found.size === before) return [...found];
  }
}

export function parseProcesses(output) {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const [pid,ppid,stat] = line.trim().split(/\s+/);
    assert.ok(/^\d+$/.test(pid) && /^\d+$/.test(ppid) && stat, 'invalid ps row');
    return {pid:Number(pid),ppid:Number(ppid),stat};
  });
}

export async function waitForKilledProcesses({pids, processes, inspectLease,
  timeoutMs = 15000, pollMs = 100, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const watched = new Set(pids);
  const deadline = now() + timeoutMs;
  for (;;) {
    // macOS still regards zombies as alive until launchd reaps them.
    const remaining = processes().filter(row => watched.has(row.pid));
    const lease = inspectLease();
    if (!remaining.length && lease.code !== 'LEASE_CHILD_BUSY') return;
    const left = deadline - now();
    if (left <= 0) {
      throw Error(`Timed out after ${timeoutMs}ms waiting for killed pids ${[...watched].join(',')}; remaining: ${remaining.map(row => `${row.pid}:${row.stat}`).join(',') || 'none'}; lease: ${JSON.stringify(lease)}`);
    }
    await sleep(Math.min(pollMs, left));
  }
}

export function compareDestination(destination, archives, readFile) {
  assert.ok(path.isAbsolute(destination), 'absolute backup destination required');
  assert.ok(archives.length, 'verified destination archive required');
  for (const [name, bytes] of archives) {
    assert.equal(path.basename(name), name, 'archive must be inside destination');
    assert.deepEqual(readFile(path.join(destination, name)), bytes,
      `backup destination archive changed: ${name}`);
  }
}

export function classifyWindow(url, code = '') {
  let parsed;try { parsed = new URL(url); } catch { return 'other'; }
  if (/\/recovery\/index\.html$/.test(parsed.pathname) ||
      code === 'STARTUP_FAILED' || code === 'LEASE_CHILD_BUSY') return 'recovery';
  if (/^https?:$/.test(parsed.protocol) || /\/dist\/index\.html$/.test(parsed.pathname)) return 'workspace';
  return 'other';
}
