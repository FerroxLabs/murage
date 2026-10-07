import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { acquireDataDirLease, dataDirLeasePaths } from '../electron/data-dir-lease.mjs';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { createPrivateWindowsDirectory, writePrivateWindowsJson, readPrivateWindowsJson, createWindowsBrowserServer } from '../electron/browser-extension-windows.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { FrameDecoder, encodeFrame, authProof, MAX_NATIVE_FRAME } from '../electron/browser-extension-host.mjs';
import { parseBrowserExtensionMessage, orderedBrowserRequestId, type BrowserExtensionMessage, type BrowserExtensionHello, type BrowserExtensionCommand, type BrowserExtensionResponse } from '../shared/browser-extension-protocol.ts';

type Pending = { command: BrowserExtensionCommand; resolve: (value: BrowserExtensionResponse) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout };
type Connection = { socket: Duplex; hello?: BrowserExtensionHello; pending: Map<string, Pending>; wireNonce: string; wireSequence: number };
/** Only a definite absent/refused endpoint permits recovery. No authentication or data is sent. */
async function endpointIsDead(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(endpoint);
    const finish = (dead: boolean) => { clearTimeout(timer); socket.destroy(); resolve(dead); };
    const timer = setTimeout(() => finish(false), 500);
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'));
  });
}
async function recoverAlias(stateDir: string, aliasPath: string, priorLease: boolean, windows: boolean) {
  const alias = await fs.lstat(aliasPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!alias) return;
  const repair = () => Error('browser_helper_repair_required');
  if (!priorLease || !alias.isFile() || alias.isSymbolicLink() || alias.size > 16384 || (!windows && (alias.uid !== process.getuid?.() || (alias.mode & 0o077)))) throw repair();
  let config: { version?: number; instance?: string; socketPath?: string; token?: string };
  if (windows) config = readPrivateWindowsJson(aliasPath) as typeof config;
  else {
    const handle = await fs.open(aliasPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== alias.dev || opened.ino !== alias.ino || opened.size > 16384) throw repair();
      config = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }
  if (config?.version !== 1 || typeof config.instance !== 'string' || !/^[a-f0-9]{16}$/.test(config.instance) || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token) || typeof config.socketPath !== 'string') throw repair();
  const originalPath = path.join(stateDir, `browser-${config.instance}.json`);
  const original = await fs.lstat(originalPath);
  if (!original.isFile() || original.isSymbolicLink() || original.dev !== alias.dev || original.ino !== alias.ino) throw repair();
  if (windows) {
    if (!/^\\\\\.\\pipe\\murage-browser-[a-f0-9]{64}$/.test(config.socketPath)) throw repair();
  } else {
    if (config.socketPath !== path.join(stateDir, `browser-${config.instance}.sock`)) throw repair();
    const socket = await fs.lstat(config.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (socket && (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077))) throw repair();
  }
  if (!await endpointIsDead(config.socketPath)) throw repair();
  const current = await fs.lstat(aliasPath), currentOriginal = await fs.lstat(originalPath);
  if (current.dev !== alias.dev || current.ino !== alias.ino || currentOriginal.dev !== alias.dev || currentOriginal.ino !== alias.ino) throw repair();
  // Retain old unique artifacts; never unlink an endpoint that could have changed after the probe.
  await fs.unlink(aliasPath);
}
/** Windows uses the explicit native ACL adapter; missing helper fails closed. */
export async function startBrowserExtensionBroker({ stateDir, onMessage, configAlias, maxRequestsPerConnection = 100000 }: {
  stateDir: string;
  /** Stable basename for owner-installed launchers; absent keeps isolated per-instance paths. */
  configAlias?: string;
  onMessage?: (profileId: string, message: BrowserExtensionMessage) => void;
  /** Request ids are remembered per connection; at this many the connection is rotated. Tests lower it. */
  maxRequestsPerConnection?: number;
}) {
  const windows = process.platform === 'win32';
  if (!path.isAbsolute(stateDir)) throw Error('absolute_state_directory_required');
  if (configAlias !== undefined && !/^[A-Za-z0-9_-]{1,80}\.json$/.test(configAlias)) throw Error('invalid_config_alias');
  if (windows) createPrivateWindowsDirectory(stateDir);
  else await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (!windows && (stat.uid !== process.getuid?.() || (stat.mode & 0o077)))) throw Error('unsafe_state_directory');
  const priorLease = configAlias ? await fs.lstat(dataDirLeasePaths(stateDir).leasePath).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; }) : false;
  const lease = configAlias ? acquireDataDirLease(stateDir) : undefined;
  try {
  if (configAlias) await recoverAlias(stateDir, path.join(stateDir, configAlias), priorLease, windows);
  const token = randomBytes(32).toString('hex');
  // Unique paths avoid deleting another instance's socket or rotating its credentials.
  const instance = randomBytes(8).toString('hex');
  const socketPath = windows ? `\\\\.\\pipe\\murage-browser-${randomBytes(32).toString('hex')}` : path.join(stateDir, `browser-${instance}.sock`);
  const instanceConfigPath = path.join(stateDir, `browser-${instance}.json`);
  const configPath = configAlias ? path.join(stateDir, configAlias) : instanceConfigPath;
  let ownsConfig = false, ownsAlias = false;
  const removeOwnAlias = async () => {
    if (!ownsAlias) return;
    try {
      const [alias, original] = await Promise.all([fs.lstat(configPath), fs.lstat(instanceConfigPath)]);
      if (alias.isFile() && !alias.isSymbolicLink() && alias.dev === original.dev && alias.ino === original.ino) await fs.unlink(configPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    ownsAlias = false;
  };
  if (!windows && Buffer.byteLength(socketPath) > 100) throw Error('socket_path_too_long');
  const connections = new Set<Connection>();
  const profiles = new Map<string, Connection>();
  let accepting = false;
  const onConnection = (socket: Duplex) => {
    if (!accepting || connections.size >= 16) { socket.destroy(); return; }
    const connection: Connection = { socket, pending: new Map(), wireNonce: randomBytes(16).toString('hex'), wireSequence: 0 };
    connections.add(connection);
    let authenticated = false;
    const nonce = randomBytes(32).toString('hex');
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    const drop = () => {
      clearTimeout(timer); connections.delete(connection);
      if (connection.hello && profiles.get(connection.hello.profileId) === connection) profiles.delete(connection.hello.profileId);
      for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('host_lost_uncertain')); }
      connection.pending.clear();
    };
    socket.on('error', () => socket.destroy()); socket.on('close', drop);
    const decoder = new FrameDecoder(value => {
      if (!authenticated) {
        const auth = value as { type?: string; version?: number; nonce?: string; proof?: string };
        if (auth?.type !== 'host.authenticate' || auth.version !== 1 || typeof auth.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(auth.nonce) || typeof auth.proof !== 'string' || !/^[a-f0-9]{64}$/.test(auth.proof)) throw Error('authentication_failed');
        if (!timingSafeEqual(Buffer.from(auth.proof, 'hex'), Buffer.from(authProof(token, 'host', nonce, auth.nonce), 'hex'))) throw Error('authentication_failed');
        authenticated = true;
        socket.write(encodeFrame({ type: 'host.authenticated', version: 1, proof: authProof(token, 'broker', nonce, auth.nonce) }));
        return;
      }
      let message: BrowserExtensionMessage;
      try { message = parseBrowserExtensionMessage(value); }
      catch (error) {
        // One response too big or too deep for the wire rules fails that request with a clear code. The
        // connection and every other task on it stay up: it is not an attack, it is a large page.
        const raw = value as { type?: unknown; id?: unknown } | null;
        const pending = raw && raw.type === 'response' && typeof raw.id === 'string' ? connection.pending.get(raw.id) : undefined;
        if (!pending) throw error;
        connection.pending.delete(raw!.id as string); clearTimeout(pending.timer); pending.reject(Object.assign(Error('response_too_large'), { code: 'response_too_large' })); return;
      }
      if (!connection.hello) {
        if (message.type !== 'hello' || !message.capabilities.includes('ordered_requests_v1') || profiles.has(message.profileId)) throw Error('profile_handshake_required');
        connection.hello = message; profiles.set(message.profileId, connection); clearTimeout(timer);
      } else if (message.type === 'response') {
        const pending = connection.pending.get(message.id);
        // Late responses never complete a new request; IDs cannot be reused per connection. The one thing
        // a request-less response may say is "uncertain": a restarted extension reporting that its last
        // action may have run. That goes to the service, which pauses the task. Nothing is completed or resent.
        if (!pending) { if (message.error?.code !== 'uncertain') return; }
        else {
        if (message.bindingId !== pending.command.bindingId || message.generation !== pending.command.generation) throw Error('response_binding_mismatch');
        connection.pending.delete(message.id); clearTimeout(pending.timer); message = { ...message, id: pending.command.id }; pending.resolve(message);
        }
      } else if (message.type !== 'event') throw Error('unexpected_browser_message');
      try { onMessage?.(connection.hello.profileId, message); } catch { socket.destroy(); }
    });
    socket.on('data', chunk => { try { decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); } catch { socket.destroy(); } });
    socket.on('end', () => socket.destroy());
    socket.write(encodeFrame({ type: 'host.challenge', version: 1, nonce }));
  };
  const nativeServer = windows ? createWindowsBrowserServer(socketPath, onConnection) : undefined;
  const server = windows ? undefined : net.createServer(onConnection);
  const closeServer = () => nativeServer ? nativeServer.close() : new Promise<void>(resolve => server!.close(() => resolve()));
  if (nativeServer) await nativeServer.ready;
  else await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(socketPath, resolve); });
  try {
    if (windows) writePrivateWindowsJson(instanceConfigPath, { version: 1, instance, socketPath, token });
    else {
      await fs.chmod(socketPath, 0o600);
      await fs.writeFile(instanceConfigPath, JSON.stringify({ version: 1, instance, socketPath, token }), { mode: 0o600, flag: 'wx' });
    }
    ownsConfig = true;
    if (configAlias) {
      // Hard links preserve the verified file ACL/mode and fail atomically if occupied.
      await fs.link(instanceConfigPath, configPath); ownsAlias = true;
    }
    accepting = true;
  } catch (error) {
    await closeServer(); await removeOwnAlias();
    if (ownsConfig) await fs.rm(instanceConfigPath, { force: true });
    if (!windows) await fs.rm(socketPath, { force: true }); throw error;
  }
  const usedIds = new WeakMap<Connection, Set<string>>();
  return {
    configPath,
    profiles: () => [...profiles.values()].map(connection => structuredClone(connection.hello!)),
    request(profileId: string, command: BrowserExtensionCommand, timeoutMs = 15000): Promise<BrowserExtensionResponse> {
      const checked = parseBrowserExtensionMessage(command);
      if (checked.type !== 'command') return Promise.reject(Error('command_required'));
      const connection = profiles.get(profileId);
      if (!connection || connection.socket.destroyed) return Promise.reject(Error('host_offline'));
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return Promise.reject(Error('invalid_deadline'));
      const ids = usedIds.get(connection) ?? new Set<string>(); usedIds.set(connection, ids);
      if (ids.has(command.id)) return Promise.reject(Error('request_replay'));
      // A connection that has used all its request ids is rotated, not left refusing forever: the
      // extension reconnects on a fresh connection. Nothing in flight is replayed (they fail as uncertain).
      if (ids.size >= maxRequestsPerConnection) { connection.socket.destroy(); return Promise.reject(Error('reconnect_required')); }
      if (connection.pending.size >= 32 || connection.socket.writableLength > MAX_NATIVE_FRAME * 2) return Promise.reject(Error('broker_busy'));
      const nextSequence = connection.wireSequence + 1;
      if (!Number.isSafeInteger(nextSequence)) return Promise.reject(Error('reconnect_required'));
      const wireId = orderedBrowserRequestId(connection.wireNonce, nextSequence);
      // Validate/encode before consuming a sequence: accepted frames are never replayed.
      const frame = encodeFrame({ ...checked, id: wireId });
      ids.add(command.id); connection.wireSequence = nextSequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { connection.pending.delete(wireId); reject(Error('deadline_exceeded_uncertain')); }, timeoutMs);
        connection.pending.set(wireId, { command: checked, resolve, reject, timer });
        try { connection.socket.write(frame, error => { if (error) connection.socket.destroy(); }); }
        catch { connection.socket.destroy(); }
      });
    },
    async close() {
      try {
      accepting = false;
      for (const connection of connections) connection.socket.destroy();
      await closeServer();
      await removeOwnAlias();
      if (ownsConfig) await fs.rm(instanceConfigPath, { force: true });
      ownsConfig = false;
      if (!windows) await fs.rm(socketPath, { force: true });
      } finally { lease?.release(); }
    },
  };
  } catch (error) { lease?.release(); throw error; }
}
