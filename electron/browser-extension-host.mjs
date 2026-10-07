// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { readPrivateWindowsJson } from './browser-extension-windows.mjs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Deliberately stricter than Chrome's 64 MiB inbound limit.
export const MAX_NATIVE_FRAME = 1024 * 1024;
export function encodeFrame(message, max = MAX_NATIVE_FRAME) {
  const body = Buffer.from(JSON.stringify(message));
  if (!body.length || body.length > max) throw Error('invalid_frame_length');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export class FrameDecoder {
  constructor(onMessage, max = MAX_NATIVE_FRAME) { this.onMessage = onMessage; this.max = max; this.header = Buffer.alloc(4); this.offset = 0; this.body = null; }
  push(chunk) {
    while (chunk.length) {
      const target = this.body ?? this.header;
      const count = Math.min(target.length - this.offset, chunk.length);
      chunk.copy(target, this.offset, 0, count); this.offset += count; chunk = chunk.subarray(count);
      if (this.offset !== target.length) continue;
      this.offset = 0;
      if (!this.body) {
        const length = this.header.readUInt32LE();
        if (!length || length > this.max) throw Error('invalid_frame_length');
        this.body = Buffer.alloc(length);
      } else {
        const body = this.body; this.body = null;
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('invalid_frame_json');
        this.onMessage(message);
      }
    }
  }
  end() { if (this.body || this.offset) throw Error('truncated_frame'); }
}
export function authProof(token, role, serverNonce, hostNonce) {
  return createHmac('sha256', token).update(`murage-native-v1:${role}:${serverNonce}:${hostNonce}`).digest('hex');
}
function equalProof(actual, expected) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
export function readHostConfig(configPath, { platform = process.platform, uid = process.getuid?.(), verifyWindowsOwnership } = {}) {
  if (!path.isAbsolute(configPath)) throw Error('invalid_config');
  if (platform === 'win32' && process.platform === 'win32' && !verifyWindowsOwnership) {
    const config = readPrivateWindowsJson(configPath);
    if (config?.version !== 1 || !/^[a-f0-9]{64}$/.test(config.token) || !/^\\\\\.\\pipe\\murage-browser-[a-f0-9]{64}$/.test(config.socketPath)) throw Error('invalid_config');
    return config;
  }
  const parent = fs.lstatSync(path.dirname(configPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('unsafe_config');
  if (platform === 'win32') {
    if (!verifyWindowsOwnership?.(configPath)) throw Error('windows_acl_unverified');
  } else if (parent.uid !== uid || (parent.mode & 0o077)) throw Error('unsafe_config');
  const fd = fs.openSync(configPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let config;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (platform !== 'win32' && (stat.uid !== uid || (stat.mode & 0o077)))) throw Error('unsafe_config');
    config = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  if (config.version !== 1 || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token) || typeof config.socketPath !== 'string') throw Error('invalid_config');
  if (platform !== 'win32') {
    if (!path.isAbsolute(config.socketPath) || path.dirname(config.socketPath) !== path.dirname(configPath)) throw Error('unsafe_socket');
    const socket = fs.lstatSync(config.socketPath);
    if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077)) throw Error('unsafe_socket');
  } else if (!config.socketPath.startsWith('\\\\.\\pipe\\murage-browser-')) throw Error('unsafe_socket');
  return config;
}

/** No reconnect or replay: any loss closes this native session. stdout is frames only. */
export function runNativeHost({ input = process.stdin, output = process.stdout, config, connect = net.createConnection, handshakeTimeoutMs = 5000 } = {}) {
  const socket = connect({ path: config.socketPath });
  let stopped = false, authenticated = false, serverNonce, hostNonce;
  let timer;
  const cleanup = () => { clearTimeout(timer); input.pause(); input.removeListener('data', onInput); socket.destroy(); };
  const fail = (code) => {
    if (stopped) return; stopped = true; cleanup();
    output.end(encodeFrame({ type: 'host.error', version: 1, error: { code, message: 'Browser connection ended. Reconnect explicitly; previous actions are not replayed.' } }));
  };
  const write = (destination, message, source) => {
    if (stopped) return;
    if (destination.writableLength > MAX_NATIVE_FRAME * 2) return fail('backpressure');
    if (!destination.write(encodeFrame(message))) source.pause();
  };
  const browserDecoder = new FrameDecoder(message => {
    if (!authenticated) return fail('handshake_required');
    write(socket, message, input);
  });
  const upstreamDecoder = new FrameDecoder(message => {
    if (!authenticated) {
      if (!serverNonce && message.type === 'host.challenge' && message.version === 1 && /^[a-f0-9]{64}$/.test(message.nonce)) {
        serverNonce = message.nonce; hostNonce = randomBytes(32).toString('hex');
        write(socket, { type: 'host.authenticate', version: 1, nonce: hostNonce, proof: authProof(config.token, 'host', serverNonce, hostNonce) }, input);
      } else if (serverNonce && message.type === 'host.authenticated' && message.version === 1 && equalProof(message.proof, authProof(config.token, 'broker', serverNonce, hostNonce))) {
        authenticated = true; clearTimeout(timer); input.resume();
      } else fail('authentication_failed');
      return;
    }
    write(output, message, socket);
  });
  function onInput(chunk) { try { browserDecoder.push(chunk); } catch { fail('invalid_frame'); } }
  input.pause(); input.on('data', onInput);
  input.on('end', () => { try { browserDecoder.end(); } catch { return fail('invalid_frame'); } stopped = true; cleanup(); output.end(); });
  input.on('error', () => fail('input_error'));
  socket.on('data', chunk => { try { upstreamDecoder.push(chunk); } catch { fail('invalid_upstream_frame'); } });
  socket.on('error', () => fail(authenticated ? 'host_lost' : 'host_offline'));
  socket.on('close', () => fail(authenticated ? 'host_lost' : 'host_offline'));
  socket.on('drain', () => { if (authenticated && !stopped) input.resume(); });
  output.on('drain', () => { if (!stopped) socket.resume(); });
  output.on('error', () => { stopped = true; cleanup(); });
  timer = setTimeout(() => fail('authentication_timeout'), handshakeTimeoutMs); timer.unref?.();
  return { stop: () => fail('host_stopped') };
}

