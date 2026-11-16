// SPDX-License-Identifier: AGPL-3.0-or-later
// Standalone shipped Node/Electron client. No repository imports or transpilation.
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { connect } from 'node:net';

const MAX_REQUEST = 64 * 1024, MAX_GUARD = 256 * 1024;
const unavailable = 11;
function main() {
  if (process.argv.length !== 4 || process.argv[2] !== 'wipe-exec') return process.exit(unavailable);
  let guard, request;
  try {
    const file = process.env.MURAGE_WIPE_GUARD;
    if (!file || Buffer.byteLength(process.argv[3]) > MAX_REQUEST) throw Error();
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_GUARD || process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) throw Error();
      const bytes = Buffer.alloc(MAX_GUARD + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count > MAX_GUARD) throw Error();
      guard = JSON.parse(bytes.toString('utf8', 0, count));
    } finally { closeSync(fd); }
    request = JSON.parse(process.argv[3]);
    if (guard.v !== 1 || typeof guard.token !== 'string' || typeof guard.socket !== 'string' ||
      !request || typeof request !== 'object' || Array.isArray(request)) throw Error();
    // No TCP endpoints, remote Windows pipes, or secrets from the shim's argv.
    if (process.platform === 'win32' ? !/^\\\\\.\\pipe\\murage-wipe-[a-f0-9]+$/.test(guard.socket) : !guard.socket.startsWith('/')) throw Error();
    if (request.threadId !== guard.threadId) return process.exit(10);
    request.token = guard.token;
  } catch { return process.exit(unavailable); }
  const wire = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(wire) > MAX_REQUEST) return process.exit(10);
  let done = false, attempts = 0, retryTimer, socket, connectionTimer;
  const finish = code => {
    if (done) return;
    done = true;
    clearTimeout(connectionTimer); clearTimeout(retryTimer);
    socket?.destroy(); process.exitCode = code;
  };
  const attempt = () => {
    if (done) return;
    attempts++;
    const peer = connect(guard.socket); socket = peer;
    let bytes = 0, buffer = '', connected = false, failed = false;
    const connectionFailed = () => {
      if (done || failed) return;
      failed = true; clearTimeout(connectionTimer); peer.destroy();
      // Three bounded connection attempts; never retry an admitted owner wait.
      if (connected || attempts >= 3) return finish(unavailable);
      retryTimer = setTimeout(attempt, 100);
    };
    connectionTimer = setTimeout(connectionFailed, 3000);
    // Connected owner waits have no artificial deadline. App death ends the wait.
    peer.setEncoding('utf8');
    peer.once('connect', () => { connected = true; clearTimeout(connectionTimer); peer.write(wire); });
    peer.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4096) return finish(unavailable);
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end));
        if (reply.id !== request.id || !['allow', 'deny'].includes(reply.decision)) return finish(unavailable);
        finish(reply.decision === 'allow' ? 0 : 10);
      } catch { finish(unavailable); }
    });
    peer.once('error', connectionFailed);
    peer.once('close', connectionFailed);
  };
  attempt();
}
main();
