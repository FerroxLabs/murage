// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
const MAX = 1024 * 1024, CHUNK = 65536;
export function resolveWindowsBrowserHelper({ resources = process.resourcesPath ?? process.env.MURAGE_RESOURCES_PATH, arch = process.arch, exists = fs.existsSync } = {}) {
  const sibling = fileURLToPath(new URL(`./win32-${arch}/murage-browser-host.exe`, import.meta.url));
  if (!resources && exists(sibling)) return sibling;
  const root = resources ? path.join(resources, 'browser-extension') : fileURLToPath(new URL('../dist-native/browser-extension/', import.meta.url));
  const helper = path.join(root, `win32-${arch}`, 'murage-browser-host.exe');
  if (!exists(helper)) throw Error('windows_browser_helper_missing');
  return helper;
}
function invoke(args, { input, helper = resolveWindowsBrowserHelper(), exec = execFileSync } = {}) {
  try { return exec(helper, args, { input, windowsHide: true, maxBuffer: MAX + 1024, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { throw Error('windows_browser_private_storage_unavailable'); }
}
export function createPrivateWindowsDirectory(directory, options) {
  if (!path.win32.isAbsolute(directory)) throw Error('absolute_private_path_required');
  const missing = []; let current = directory;
  while (!fs.existsSync(current)) { missing.unshift(current); const parent = path.win32.dirname(current); if (parent === current) throw Error('private_parent_missing'); current = parent; }
  for (const item of missing) invoke(['--mkdir', item], options);
  invoke(['--mkdir', directory], options);
}
export function readPrivateWindowsJson(file, options) {
  if (!path.win32.isAbsolute(file)) throw Error('absolute_private_path_required');
  if (!fs.existsSync(file)) throw Object.assign(Error('private_file_missing'), { code: 'ENOENT' });
  return JSON.parse(invoke(['--read', file], options).toString('utf8'));
}
export function writePrivateWindowsData(file, data, options) {
  if (!path.win32.isAbsolute(file)) throw Error('absolute_private_path_required');
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length > MAX) throw Error('private_file_too_large');
  const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
  invoke(['--write', file], { ...options, input: Buffer.concat([length, bytes]) });
}
export function writePrivateWindowsJson(file, value, options) { writePrivateWindowsData(file, JSON.stringify(value), options); }
export function createWindowsBrowserLauncher({ launcherPath, electronPath, hostScriptPath, configPath }, options = {}) {
  for (const value of [launcherPath, electronPath, hostScriptPath, configPath]) if (!path.win32.isAbsolute(value) || /[\r\n\0]/.test(value)) throw Error('invalid_launcher_path');
  createPrivateWindowsDirectory(path.win32.dirname(launcherPath), options);
  const helper = options.helper ?? resolveWindowsBrowserHelper();
  writePrivateWindowsData(launcherPath, fs.readFileSync(helper), options);
  writePrivateWindowsData(`${launcherPath}.launch`, `${electronPath}\n${hostScriptPath}\n${configPath}\n`, options);
}
const defaultRegistryQuery = key => new Promise((resolve, reject) => execFile('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
export function windowsRegistrationAdapter(browser, options) {
  const vendors = { chrome: 'Google\\Chrome', chromium: 'Chromium', edge: 'Microsoft\\Edge', brave: 'Chromium' };
  if (!Object.hasOwn(vendors, browser)) throw Error('invalid_registration_browser');
  const prefix = `HKCU\\Software\\${vendors[browser]}\\NativeMessagingHosts\\`;
  const validate = (registry, manifest) => {
    if (!registry || typeof registry.key !== 'string' || !registry.key.startsWith(prefix) || typeof registry.value !== 'string' || !path.win32.isAbsolute(registry.value)) throw Error('invalid_registration_target');
    const hostName = registry.key.slice(prefix.length);
    if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(hostName) || manifest?.name !== hostName) throw Error('registration_manifest_name_mismatch');
    return hostName;
  };
  const call = (kind, registry, manifest) => invoke([kind, browser, validate(registry, manifest), registry.value], options);
  // Read-only look at the key's default value, so a value that is not ours is found before anything is written.
  // A key that is absent, or a read that cannot be made, is "nothing known": the native helper still refuses a foreign value.
  const read = async registry => {
    try {
      validate(registry, { name: registry.key.slice(prefix.length) });
      const out = String(await (options?.query ?? defaultRegistryQuery)(registry.key));
      return /\(Default\)\s+REG_SZ\s+(.*?)\s*$/m.exec(out)?.[1];
    } catch { return undefined; }
  };
  return { validate, read, installIfAbsentOrEqual: (registry, manifest) => call('--register', registry, manifest), removeIfEqual: (registry, manifest) => call('--unregister', registry, manifest) };
}
export class WindowsMuxDecoder {
  constructor(receive) { this.receive = receive; this.header = Buffer.alloc(4); this.body = undefined; this.offset = 0; }
  push(chunk) {
    while (chunk.length) {
      const target = this.body ?? this.header; const count = Math.min(chunk.length, target.length - this.offset);
      chunk.copy(target, this.offset, 0, count); chunk = chunk.subarray(count); this.offset += count;
      if (this.offset !== target.length) continue; this.offset = 0;
      if (!this.body) { const length = this.header.readUInt32LE(); if (length < 5 || length > CHUNK + 5) throw Error('invalid_windows_pipe_frame'); this.body = Buffer.alloc(length); }
      else { const body = this.body; this.body = undefined; this.receive(body[4], body.readUInt32LE(), body.subarray(5)); }
    }
  }
}
export function createWindowsBrowserServer(pipePath, onConnection, { helper = resolveWindowsBrowserHelper(), spawnImpl = spawn, parentPid = process.pid } = {}) {
  if (!/^\\\\\.\\pipe\\murage-browser-[a-f0-9]{64}$/.test(pipePath)) throw Error('invalid_windows_pipe_name');
  const child = spawnImpl(helper, ['--broker', pipePath, String(parentPid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const sockets = new Map(); let closed = false, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const send = (kind, id, data = Buffer.alloc(0), callback = () => {}) => {
    if (closed || child.stdin.writableLength > MAX * 2) return callback(Error('windows_pipe_backpressure'));
    const frame = Buffer.alloc(9 + data.length); frame.writeUInt32LE(data.length + 5); frame.writeUInt32LE(id, 4); frame[8] = kind; data.copy(frame, 9); child.stdin.write(frame, callback);
  };
  const stop = () => { if (closed) return; closed = true; clearTimeout(timer); readyReject(Error('windows_pipe_unavailable')); for (const socket of sockets.values()) socket.destroy(); sockets.clear(); child.stdin.destroy(); child.kill(); };
  const decoder = new WindowsMuxDecoder((kind, id, data) => {
    if (kind === 4 && id === 0 && !data.length) { clearTimeout(timer); readyResolve(); return; }
    if (kind === 5) return stop();
    if (kind === 1) {
      if (!id || data.length || sockets.has(id) || sockets.size >= 16) throw Error('invalid_windows_pipe_channel');
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          let offset = 0;
          const next = error => { if (error) return callback(error); if (offset >= chunk.length) return callback(); const part = chunk.subarray(offset, offset + CHUNK); offset += part.length; send(1, id, part, next); }; next();
        },
        destroy(error, callback) { sockets.delete(id); if (!closed) send(2, id); callback(error); },
      });
      sockets.set(id, socket); onConnection(socket); return;
    }
    const socket = sockets.get(id); if (!socket) return;
    if (kind === 2) { if (socket.readableLength + data.length > MAX * 2) socket.destroy(Error('windows_pipe_backpressure')); else socket.push(data); }
    else if (kind === 3 && !data.length) socket.destroy(); else throw Error('invalid_windows_pipe_event');
  });
  const timer = setTimeout(stop, 10000); timer.unref();
  child.stdout.on('data', chunk => { try { decoder.push(chunk); } catch { stop(); } });
  child.stderr.on('data', () => {});
  child.stdin.on('error', stop); child.on('error', stop); child.on('close', stop);
  return { ready, close: async () => { stop(); } };
}
