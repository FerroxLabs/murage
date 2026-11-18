import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
import { spawn } from 'node:child_process';
export function execute(file, argv, env, cwd, timeout = 20000) {
  return new Promise(resolve => {
    const child = spawn(file, [...argv], withHideInherit({ env, cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }));
    let timedOut = false, error = false, overflow = false;
    const overflowed = { stdout: false, stderr: false };
    const streams = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const collect = (stream, chunk) => {
      const previous = streams[stream];
      if (previous.length + chunk.length > 65536) { overflow = true; overflowed[stream] = true; error = true; }
      streams[stream] = Buffer.concat([previous, chunk.subarray(0, Math.max(0, 65536 - previous.length))]);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Exact owned process group, never a name/pattern kill.
      try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeout);
    child.stdout.on('data', x => collect('stdout', x));
    child.stderr.on('data', x => collect('stderr', x));
    child.on('error', () => { error = true; });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, stdout: streams.stdout.toString('utf8'), stderr: streams.stderr.toString('utf8'), timedOut, error, overflow, signal, stdoutOverflow: overflowed.stdout, stderrOverflow: overflowed.stderr }); });
  });
}
