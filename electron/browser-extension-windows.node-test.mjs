// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import { WindowsMuxDecoder, createWindowsBrowserServer, resolveWindowsBrowserHelper, writePrivateWindowsJson, windowsRegistrationAdapter } from './browser-extension-windows.mjs';
import { registrationPlan, browserRegistrationFamily } from '../scripts/browser-extension-host-registration.mjs';
import { buildBrowserExtensionWindows } from '../scripts/build-browser-extension-windows.mjs';
const frame = (kind, id, value = Buffer.alloc(0)) => { const bytes = Buffer.alloc(9 + value.length); bytes.writeUInt32LE(value.length + 5); bytes.writeUInt32LE(id, 4); bytes[8] = kind; value.copy(bytes, 9); return bytes; };
test('Windows helper missing and malformed pipe fail closed', () => {
  assert.throws(() => resolveWindowsBrowserHelper({ resources: '/fixture', exists: () => false }), /helper_missing/);
  assert.throws(() => createWindowsBrowserServer('untrusted', () => {}, { helper: '/fixture/helper' }), /invalid_windows_pipe_name/);
});
test('private config contents use bounded stdin, never helper argv', () => {
  let observed;
  writePrivateWindowsJson('C:\\private\\client.json', { token: 'fixture-secret' }, { helper: 'helper', exec: (command, args, options) => { observed = { command, args, options }; return Buffer.alloc(0); } });
  assert.equal(JSON.stringify(observed.args).includes('fixture-secret'), false);
  const bytes = observed.options.input; assert.equal(bytes.readUInt32LE(), bytes.length - 4); assert.equal(JSON.parse(bytes.subarray(4)).token, 'fixture-secret');
  assert.throws(() => writePrivateWindowsJson('C:\\private\\client.json', { value: 'x'.repeat(1048576) }, { helper: 'helper' }), /too_large/);
});
test('Windows mux parses split/coalesced packets and rejects oversized allocation', () => {
  const got = []; const parser = new WindowsMuxDecoder((kind, id, data) => got.push([kind, id, data.toString()]));
  for (const byte of Buffer.concat([frame(1, 4), frame(2, 4, Buffer.from('hello'))])) parser.push(Buffer.from([byte]));
  assert.deepEqual(got, [[1, 4, ''], [2, 4, 'hello']]);
  for (const size of [0, 4, 65542, 0xffffffff]) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(size); assert.throws(() => new WindowsMuxDecoder(() => {}).push(bytes), /invalid_windows_pipe_frame/); }
});
test('mock native helper exposes bounded separate channels and closes without replay', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); const writes = [];
  child.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(Buffer.from(chunk)); callback(); } });
  child.kill = () => { child.emit('close', 0); return true; };
  const sockets = [];
  const server = createWindowsBrowserServer('\\\\.\\pipe\\murage-browser-' + 'a'.repeat(64), socket => { socket.on('error', () => {}); sockets.push(socket); }, { helper: 'fixture', spawnImpl: () => child, parentPid: 123 });
  child.stdout.write(frame(4, 0)); await server.ready;
  child.stdout.write(Buffer.concat([frame(1, 1), frame(1, 2)])); assert.equal(sockets.length, 2);
  const read = once(sockets[1], 'data'); child.stdout.write(frame(2, 2, Buffer.from('second'))); assert.equal((await read)[0].toString(), 'second');
  await new Promise((resolve, reject) => sockets[0].write(Buffer.alloc(70000), error => error ? reject(error) : resolve()));
  const decoded = []; const parser = new WindowsMuxDecoder((kind, id, bytes) => decoded.push([kind, id, bytes.length])); for (const bytes of writes) parser.push(bytes);
  assert.deepEqual(decoded, [[1, 1, 65536], [1, 1, 4464]]);
  await server.close(); assert.ok(sockets.every(socket => socket.destroyed));
});
test('Windows build recipe is bounded to existing native toolchain; source security primitives present', async () => {
  assert.throws(() => buildBrowserExtensionWindows({ platform: 'darwin' }), /Windows x64/);
  const commands = [];
  const executable = buildBrowserExtensionWindows({ platform: 'win32', arch: 'x64', root: 'C:\\fixture', env: {}, exists: () => true, mkdir: () => {}, exec: (command, args) => { commands.push([command, args]); return commands.length === 1 ? 'C:\\BuildTools' : ''; } });
  assert.match(executable, /win32-x64\\murage-browser-host.exe$/); assert.match(commands[1][1][3], /native\\browser-extension\\transport.cpp/);
  const source = await fs.readFile(new URL('../native/browser-extension/transport.cpp', import.meta.url), 'utf8');
  for (const primitive of ['SE_DACL_PROTECTED', 'acl->AceCount==2', 'FILE_FLAG_FIRST_PIPE_INSTANCE', 'PIPE_REJECT_REMOTE_CLIENTS', 'GetNamedPipeClientProcessId', 'FILE_FLAG_OPEN_REPARSE_POINT', 'GetSecurityInfo', 'PROC_THREAD_ATTRIBUTE_HANDLE_LIST']) assert.ok(source.includes(primitive), primitive);
  assert.equal(source.includes('ShellExecute'), false);
});

test('Windows acceptor refuses the excess connection and keeps the broker and its sessions running (Astra 14)', async () => {
  // Source assertion only: the native helper compiles and runs on Windows alone, so this pins the shape of the
  // fix on every platform. Behavior (17th client refused, 16 sessions alive) is proved on a Windows machine.
  const source = await fs.readFile(new URL('../native/browser-extension/transport.cpp', import.meta.url), 'utf8');
  assert.equal(source.includes('need(connections.size()<16)'), false, 'a full table must not throw into the acceptor catch (which stops the broker)');
  assert.match(source, /full=connections\.size\(\)>=16/);
  assert.match(source, /if\(full\)\{DisconnectNamedPipe\(pipe->value\);/);
  // The refusal path continues the accept loop with a fresh pipe instance.
  assert.match(source, /if\(full\)\{[^}]*privateAcl\(pipe->value,sid\);continue;\}/);
});

test('Windows registration preserves exact approved fixture host for install and removal', () => {
  const calls = []; const adapter = windowsRegistrationAdapter('chrome', { helper: 'fixture-helper', exec: (_file, args) => { calls.push(args); return Buffer.alloc(0); } });
  const hostName = 'com.murage.fixture_unique_123', separator = String.fromCharCode(92);
  const registry = { key: ['HKCU', 'Software', 'Google', 'Chrome', 'NativeMessagingHosts', hostName].join(separator), value: ['C:', 'fixture', 'host.json'].join(separator) };
  const manifest = { name: hostName };
  adapter.installIfAbsentOrEqual(registry, manifest); adapter.removeIfEqual(registry, manifest);
  assert.deepEqual(calls, [['--register', 'chrome', hostName, registry.value], ['--unregister', 'chrome', hostName, registry.value]]);
  assert.equal(calls.some(args => args.includes('com.murage.browser')), false);
  for (const key of [registry.key.replace(['Google', 'Chrome'].join(separator), ['Microsoft', 'Edge'].join(separator)), registry.key.replace('HKCU', 'HKLM'), registry.key + separator + 'other', registry.key + '/other', registry.key + '*']) {
    assert.throws(() => adapter.installIfAbsentOrEqual({ ...registry, key }, manifest));
    assert.throws(() => adapter.removeIfEqual({ ...registry, key }, manifest));
  }
  assert.throws(() => adapter.installIfAbsentOrEqual(registry, { name: 'com.murage.browser' }), /manifest_name_mismatch/);
  assert.equal(calls.length, 2);
});

test('Chrome then Brave coexist; Brave and Chromium reuse one exact owned registry family', () => {
  const values = new Map(), separator = String.fromCharCode(92), hostName = 'com.murage.fixture_family';
  const paths = parts => parts.join(separator);
  const exec = (_helper, [operation, browser, name, value]) => {
    const key = (browser === 'brave' ? 'chromium' : browser) + ':' + name;
    if (operation === '--register') { if (values.has(key) && values.get(key) !== value) throw Error('foreign'); values.set(key, value); }
    else { if (values.get(key) !== value) throw Error('foreign'); values.delete(key); }
    return Buffer.alloc(0);
  };
  const plan = browser => { const family = browserRegistrationFamily(browser, 'win32'); return registrationPlan({ platform: 'win32', browser, home: paths(['C:', 'fixture']), hostName, launcherPath: paths(['C:', 'private', 'browser-native-' + family + '.exe']), manifestPath: paths(['C:', 'private', 'manifest-' + family + '.json']), productionIds: ['a'.repeat(32)] }); };
  const chrome = plan('chrome'), brave = plan('brave'), chromium = plan('chromium');
  const adapter = browser => windowsRegistrationAdapter(browser, { helper: 'fixture-helper', exec });
  adapter('chrome').installIfAbsentOrEqual(chrome.registry, chrome.manifest);
  adapter('brave').installIfAbsentOrEqual(brave.registry, brave.manifest);
  adapter('chromium').installIfAbsentOrEqual(chromium.registry, chromium.manifest);
  assert.equal(values.size, 2); assert.notEqual(chrome.registry.key, brave.registry.key);
  assert.deepEqual(brave.registry, chromium.registry); assert.equal(brave.manifest.path, chromium.manifest.path);
  assert.throws(() => adapter('brave').installIfAbsentOrEqual({ ...brave.registry, value: paths(['C:', 'foreign.json']) }, brave.manifest));
  adapter('brave').removeIfEqual(brave.registry, brave.manifest);
  assert.equal(values.size, 1); assert.equal(values.get('chrome:' + hostName), chrome.registry.value);
});

test('Windows broker closes a closed client\'s pipe, the first one included', async () => {
  // Source assertion on every platform; the behaviour (a refused first client sees its pipe close) is proved on
  // Windows by server/browser-extension-broker.test.ts "does not publish an authenticated extension...".
  const source = await fs.readFile(new URL('../native/browser-extension/transport.cpp', import.meta.url), 'utf8');
  assert.match(source, /std::thread acceptor\(\[&,pipe=std::move\(first\)\]/, 'a second reference to the first pipe instance keeps the first client connected');
  // Closing the last handle, not DisconnectNamedPipe, so the client still reads what was sent before the close.
  assert.equal(/closeConnection\(c\);DisconnectNamedPipe/.test(source), false);
});
