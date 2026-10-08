import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, encodeFrame, runNativeHost, readHostConfig, authProof } from './browser-extension-host.mjs';

test('split header/body and coalesced frames decode once in order', () => {
  const got = []; const decoder = new FrameDecoder(value => got.push(value));
  const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: '✓' })]);
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(got, [{ a: 1 }, { b: '✓' }]);
  const all = []; new FrameDecoder(value => all.push(value)).push(bytes); assert.deepEqual(all, got);
});
test('zero and oversized lengths reject before body allocation', () => {
  for (const length of [0, 1048577, 0xffffffff]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(length);
    assert.throws(() => new FrameDecoder(() => {}).push(header), /invalid_frame_length/);
  }
});
test('invalid JSON, UTF-8, primitives and truncated frames reject', () => {
  for (const body of [Buffer.from('{'), Buffer.from('null'), Buffer.from('[]'), Buffer.from([0xff])]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    assert.throws(() => new FrameDecoder(() => {}).push(Buffer.concat([header, body])));
  }
  const decoder = new FrameDecoder(() => {}); decoder.push(Buffer.from([1])); assert.throws(() => decoder.end(), /truncated/);
  assert.throws(() => encodeFrame({ x: 'x'.repeat(1048576) }), /length/);
});
function fixture() {
  const input = new PassThrough(), output = new PassThrough();
  const socket = new EventEmitter(); socket.writableLength = 0; socket.sent = [];
  socket.write = data => { socket.sent.push(data); return true; }; socket.pause = () => {}; socket.resume = () => {}; socket.destroy = () => {};
  const got = []; output.on('data', data => new FrameDecoder(value => got.push(value)).push(data));
  runNativeHost({ input, output, config: { socketPath: '/unused', token: 'a'.repeat(64) }, connect: () => socket });
  return { input, output, socket, got };
}
test('offline reports only bounded framed global error and does not forward requests', async () => {
  const f = fixture(); f.input.write(encodeFrame({ command: 'held' })); f.socket.emit('error', Error('sensitive path'));
  await once(f.output, 'end'); assert.equal(f.got.length, 1); assert.equal(f.got[0].error.code, 'host_offline'); assert.equal(f.socket.sent.length, 0);
  assert.equal(JSON.stringify(f.got).includes('sensitive'), false);
});
test('mutual challenge authenticates before forwarding and loss never replays', async () => {
  const f = fixture(); const nonce = 'b'.repeat(64);
  f.input.write(encodeFrame({ type: 'hello' }));
  f.socket.emit('data', encodeFrame({ type: 'host.challenge', version: 1, nonce }));
  let auth; new FrameDecoder(value => { auth = value; }).push(f.socket.sent[0]);
  assert.equal(auth.proof, authProof('a'.repeat(64), 'host', nonce, auth.nonce));
  f.socket.emit('data', encodeFrame({ type: 'host.authenticated', version: 1, proof: authProof('a'.repeat(64), 'broker', nonce, auth.nonce) }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.socket.sent.length, 2);
  f.socket.emit('data', encodeFrame({ type: 'result' })); f.socket.emit('close');
  await once(f.output, 'end'); assert.deepEqual(f.got.map(x => x.type), ['result', 'host.error']); assert.equal(f.got[1].error.code, 'host_lost');
});
test('wrong broker proof fails without releasing buffered browser input', async () => {
  const f = fixture(); f.input.write(encodeFrame({ secret: 'not-forwarded' }));
  f.socket.emit('data', encodeFrame({ type: 'host.challenge', version: 1, nonce: 'b'.repeat(64) }));
  f.socket.emit('data', encodeFrame({ type: 'host.authenticated', version: 1, proof: 'c'.repeat(64) }));
  await once(f.output, 'end'); assert.equal(f.got[0].error.code, 'authentication_failed'); assert.equal(f.socket.sent.length, 1);
});
test('config rejects public mode, symlink and unsupported Windows ownership', () => {
  const root = fs.mkdtempSync(path.resolve('.native-host-')); fs.chmodSync(root, 0o700);
  try {
    const file = path.join(root, 'config.json'); fs.writeFileSync(file, '{}', { mode: 0o644 });
    if (process.platform === 'win32') {
      // Windows has no POSIX mode bits or uid; the default path reads only through the private-storage helper,
      // which fails closed when the helper is absent or the file was not written privately by it.
      assert.throws(() => readHostConfig(file), /windows_browser_helper_missing|windows_browser_private_storage_unavailable/);
    } else {
      assert.throws(() => readHostConfig(file), /unsafe_config/);
      const link = path.join(root, 'link'); fs.symlinkSync(file, link); assert.throws(() => readHostConfig(link));
    }
    assert.throws(() => readHostConfig(file, { platform: 'win32', verifyWindowsOwnership: () => false }), /windows_acl_unverified/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('standalone entrypoint stdout contains exactly one framed safe error', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./browser-extension-host-entry.mjs', import.meta.url)), '/missing-fixture-only/config.json']);
  assert.equal(child.status, 0); assert.equal(child.stderr.length, 0);
  const messages = []; const decoder = new FrameDecoder(value => messages.push(value)); decoder.push(child.stdout); decoder.end();
  assert.equal(messages.length, 1); assert.equal(messages[0].error.code, 'host_unavailable');
});
