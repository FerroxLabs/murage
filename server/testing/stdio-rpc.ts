// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture transport owner: c4-misc-a. Bound fixture owner: c3-drivers; consuming admission owner: sfx-fixture.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** An owned fixture RPC ends when its real transport ends. Rejection lets the
 * caller's finally stop its load generators rather than outliving a test timeout.
 */
export function fixtureStdioRpc(child: ChildProcessWithoutNullStreams, notification?: (frame: any) => void) {
  const pending = new Map<number, { resolve(frame: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let ended = false;
  const fail = () => {
    ended = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('fixture RPC transport ended')); }
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let frame: any;
    try { frame = JSON.parse(line); } catch { fail(); return; }
    const request = pending.get(frame.id);
    if (request) { pending.delete(frame.id); clearTimeout(request.timer); request.resolve(frame); }
    else notification?.(frame);
  });
  child.once('exit', fail); child.once('error', fail);
  child.stdin.on('error', fail); child.stdout.once('end', fail);
  return {
    request(id: number, method: string, params: unknown = {}, timeoutMs = 30_000): Promise<any> {
      if (ended || child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error('fixture RPC transport ended'));
      if (pending.has(id)) return Promise.reject(new Error('duplicate fixture RPC id'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('fixture RPC response deadline')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => { if (error) fail(); });
      });
    },
    close() {
      fail(); lines.close();
      child.off('exit', fail); child.off('error', fail);
      child.stdin.off('error', fail); child.stdout.off('end', fail);
    },
  };
}
