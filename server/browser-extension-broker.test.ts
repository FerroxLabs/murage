import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
// A short real root keeps sockets inside macOS sockaddr_un's bound on every runner.
const SHORT_ROOT = process.platform === 'win32' ? os.tmpdir() : realpathSync('/tmp');
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dataDirLeasePaths } from '../electron/data-dir-lease.mjs';
import { startBrowserExtensionBroker } from './browser-extension-broker.ts';
import { runNativeHost, readHostConfig, FrameDecoder, encodeFrame } from '../electron/browser-extension-host.mjs';
import { makePrivateTestSubdirectory, privateTestDirectory, writePrivateTestFile } from './testing/private-test-dir.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(capabilities = ['ordered_requests_v1'], onMessage?: (profileId: string, message: unknown) => void) {
    const { root: stateRoot, directory: stateDir } = await privateTestDirectory(path.join(SHORT_ROOT, 'bex-'));
  cleanup.push(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const broker = await startBrowserExtensionBroker({ stateDir, ...(onMessage ? { onMessage: onMessage as never } : {}) }); cleanup.push(() => broker.close());
  const input = new PassThrough(), output = new PassThrough(); const messages: unknown[] = [];
  const decoder = new FrameDecoder(value => messages.push(value)); output.on('data', chunk => decoder.push(chunk));
  const host = runNativeHost({ input, output, config: readHostConfig(broker.configPath) }); cleanup.push(async () => host.stop());
  input.write(encodeFrame({ version: 1, type: 'hello', profileId: 'profile', browser: 'chromium', extensionVersion: '0.1.0', capabilities }));
  if (capabilities.includes('ordered_requests_v1')) await expect.poll(() => broker.profiles().length).toBe(1);
  else await expect.poll(() => messages.some(value => (value as {type?:string}).type === 'host.error')).toBe(true);
  return { broker, input, output, messages, host };
}
const command = { version: 1, type: 'command', id: 'request1', bindingId: 'binding', generation: 1, operation: 'status', params: {} } as const;
describe('native broker real isolated Unix socket', () => {
  it('does not publish an authenticated extension without the ordered wire capability', async () => {
    const f=await fixture(['scoped_cdp']); expect(f.broker.profiles()).toEqual([]);
    expect(f.messages).toContainEqual(expect.objectContaining({type:'host.error',error:expect.objectContaining({code:'host_lost'})}));
  });
  it('authenticates host, matches response and prevents request replay', async () => {
    const f = await fixture(); const pending = f.broker.request('profile', command);
    await expect.poll(() => f.messages.length).toBe(1); const wire = f.messages[0] as typeof command;
    expect(wire).toEqual({ ...command, id: expect.stringMatching(/^[a-f0-9]{32}_1$/) });
    f.input.write(encodeFrame({ version: 1, type: 'response', id: wire.id, bindingId: 'binding', generation: 1, result: { ok: true } }));
    await expect(pending).resolves.toMatchObject({ id: command.id, result: { ok: true } });
    await expect(f.broker.request('profile', command)).rejects.toThrow('request_replay');
  });
  it('rejects offline and deadline without replay', async () => {
    const f = await fixture(); await expect(f.broker.request('absent', command)).rejects.toThrow('host_offline');
    await expect(f.broker.request('profile', command, 10)).rejects.toThrow('deadline_exceeded_uncertain');
    expect(f.messages).toHaveLength(1);
    await expect(f.broker.request('profile', command)).rejects.toThrow('request_replay');
  });
  it('wrong response binding disconnects and rejects pending work', async () => {
    const f = await fixture(); const pending = f.broker.request('profile', command);
    const assertion = expect(pending).rejects.toThrow('host_lost_uncertain');
    await expect.poll(() => f.messages.length).toBe(1);
    f.input.write(encodeFrame({ version: 1, type: 'response', id: (f.messages[0] as typeof command).id, bindingId: 'foreign', generation: 1, result: {} }));
    await assertion; await expect.poll(() => f.broker.profiles().length).toBe(0);
  });
  it('host loss rejects outstanding request without retries', async () => {
    const f = await fixture(); const pending = f.broker.request('profile', command);
    const assertion = expect(pending).rejects.toThrow('host_lost_uncertain'); f.host.stop(); await assertion;
  });
  it('orders wire requests and restores application IDs for out-of-order responses', async () => {
    const f = await fixture();
    const first = f.broker.request('profile', command), second = f.broker.request('profile', { ...command, id: 'request2' });
    await expect.poll(() => f.messages.length).toBe(2);
    const [a,b] = f.messages as typeof command[];
    expect(a.id).toMatch(/^[a-f0-9]{32}_1$/); expect(b.id).toBe(a.id.replace(/_1$/, '_2'));
    f.input.write(encodeFrame({version:1,type:'response',id:b.id,bindingId:'binding',generation:1,result:{order:2}}));
    f.input.write(encodeFrame({version:1,type:'response',id:a.id,bindingId:'binding',generation:1,result:{order:1}}));
    await expect(first).resolves.toMatchObject({id:'request1',result:{order:1}});
    await expect(second).resolves.toMatchObject({id:'request2',result:{order:2}});
  });
  it('ignores a timed-out wire response rather than completing later work', async () => {
    const f=await fixture(); await expect(f.broker.request('profile',command,10)).rejects.toThrow('deadline_exceeded_uncertain');
    const pending=f.broker.request('profile',{...command,id:'request2'});
    await expect.poll(()=>f.messages.length).toBe(2); const [a,b]=f.messages as typeof command[];
    f.input.write(encodeFrame({version:1,type:'response',id:a.id,bindingId:'binding',generation:1,result:{late:true}}));
    f.input.write(encodeFrame({version:1,type:'response',id:b.id,bindingId:'binding',generation:1,result:{fresh:true}}));
    await expect(pending).resolves.toMatchObject({id:'request2',result:{fresh:true}});
  });
  it('d: an uncertain report with no pending request reaches the service; any other late response does not', async () => {
    const seen: unknown[] = []; const f = await fixture(['ordered_requests_v1'], (_p, m) => seen.push(m));
    f.input.write(encodeFrame({ version: 1, type: 'response', id: 'old_9', bindingId: 'binding', generation: 1, result: { late: true } }));
    f.input.write(encodeFrame({ version: 1, type: 'response', id: 'old_10', bindingId: 'binding', generation: 1, error: { code: 'uncertain', message: 'The browser restarted during the last action.' } }));
    const responses = () => seen.filter(m => (m as { type?: string }).type === 'response');
    await expect.poll(() => responses().length).toBe(1);
    expect(responses()[0]).toMatchObject({ type: 'response', bindingId: 'binding', error: { code: 'uncertain' } });
  });
  it('raw unauthenticated client cannot claim a profile', async () => {
    const f = await fixture(); const config = readHostConfig(f.broker.configPath);
    const socket = net.createConnection(config.socketPath); cleanup.push(async () => { socket.destroy(); });
    await new Promise<void>(resolve => socket.once('connect', resolve));
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.on('data', () => {}); socket.write(encodeFrame({ version: 1, type: 'hello', profileId: 'evil' })); await closed;
    expect(f.broker.profiles().map(p => p.profileId)).toEqual(['profile']);
  });
});

describe('optional stable native config alias', () => {
  it('keeps the same private launcher config path across clean restarts', async () => {
    const stateDir = await recoveryDir();
    const first = await startBrowserExtensionBroker({ stateDir, configAlias: 'native-host.json' });
    const configPath = first.configPath; const previousSocket = readHostConfig(configPath).socketPath;
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    await first.close();
    const second = await startBrowserExtensionBroker({ stateDir, configAlias: 'native-host.json' }); cleanup.push(() => second.close());
    expect(second.configPath).toBe(configPath); expect(readHostConfig(configPath).socketPath === previousSocket).toBe(false);
  });
  it('refuses a conflicting active alias and preserves its owner', async () => {
    const stateDir = await recoveryDir();
    const first = await startBrowserExtensionBroker({ stateDir, configAlias: 'native-host.json' }); cleanup.push(() => first.close());
    const original = await fs.stat(first.configPath);
    await expect(startBrowserExtensionBroker({ stateDir, configAlias: 'native-host.json' })).rejects.toMatchObject({ code: 'LEASE_BUSY' });
    expect((await fs.stat(first.configPath)).ino).toBe(original.ino);
    expect((await fs.readdir(stateDir)).length).toBe(3); // unique config, alias and socket only
  });
  it('does not remove an alias replaced by another owner', async () => {
    const stateDir = await recoveryDir();
    const first = await startBrowserExtensionBroker({ stateDir, configAlias: 'native-host.json' });
    await fs.unlink(first.configPath); await fs.writeFile(first.configPath, 'foreign-owner', { mode: 0o600 });
    await first.close(); expect(await fs.readFile(first.configPath, 'utf8')).toBe('foreign-owner');
  });
});

async function recoveryDir() {
  const outer = await fs.mkdtemp(path.join(SHORT_ROOT, 'bxr-')); await fs.chmod(outer, 0o700);
  cleanup.push(() => fs.rm(outer, { recursive: true, force: true }));
  const stateDir = path.join(outer, 'state'); await makePrivateTestSubdirectory(stateDir); return stateDir;
}
async function childBroker(stateDir: string) {
  const child = fork(new URL('./testing/browser-extension-broker-child.ts', import.meta.url), [stateDir], { execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  const result = await new Promise<{ready?:boolean; code?:string}>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('child_start_timeout')), 10000);
    child.once('message', message => { clearTimeout(timer); resolve(message as {ready?:boolean;code?:string}); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('child_exited_before_ready')); });
  });
  return { child, result };
}
async function crash(child: ChildProcess) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
async function crashedFixture() {
  const stateDir = await recoveryDir(); const started = await childBroker(stateDir); expect(started.result.ready).toBe(true);
  const alias = path.join(stateDir, 'native-host.json'); const config = readHostConfig(alias) as ReturnType<typeof readHostConfig> & {instance:string};
  await crash(started.child); return { stateDir, alias, config };
}
async function authenticate(broker: Awaited<ReturnType<typeof startBrowserExtensionBroker>>, config: ReturnType<typeof readHostConfig>, profileId: string) {
  const input = new PassThrough(), output = new PassThrough(), messages: {type?:string}[] = [];
  const decoder = new FrameDecoder(value => messages.push(value as {type?:string})); output.on('data', chunk => decoder.push(chunk));
  const host = runNativeHost({input,output,config}); cleanup.push(async()=>host.stop());
  input.write(encodeFrame({version:1,type:'hello',profileId,browser:'chromium',extensionVersion:'0.1.0',capabilities:['ordered_requests_v1']}));
  await expect.poll(()=>broker.profiles().some(p=>p.profileId===profileId) || messages.some(m=>m.type==='host.error')).toBe(true);
  return broker.profiles().some(p=>p.profileId===profileId);
}
describe('R6 crash recovery boundary (real isolated child processes)', () => {
  it('recovers SIGKILL alias, rotates credentials and authenticates only the fresh token', async () => {
    const f=await crashedFixture();
    const broker=await startBrowserExtensionBroker({stateDir:f.stateDir,configAlias:'native-host.json'}); cleanup.push(()=>broker.close());
    const fresh=readHostConfig(f.alias); expect(fresh.token===f.config.token).toBe(false);
    expect(await authenticate(broker,fresh,'fresh')).toBe(true);
    expect(await authenticate(broker,{...fresh,token:f.config.token},'old')).toBe(false);
  });
  // Another computer has another host name AND another boot session (upstream
  // #2018: a renamed host in the same boot is still this computer).
  it('preserves foreign-host and malformed prior leases', async () => {
    for (const kind of ['foreign','malformed']) {
      const f=await crashedFixture(), lease=dataDirLeasePaths(f.stateDir).leasePath;
      const originalBytes=await fs.readFile(lease);const original=JSON.parse(originalBytes.toString('utf8'));
      try {
      await fs.writeFile(lease,kind==='foreign'?JSON.stringify({...original,host:'foreign.invalid',boot:'another-computer-boot'}):'malformed');
      const before=await fs.readFile(f.alias), inode=(await fs.lstat(f.alias)).ino;
      await expect(startBrowserExtensionBroker({stateDir:f.stateDir,configAlias:'native-host.json'})).rejects.toThrow();
      expect((await fs.readFile(f.alias)).equals(before)).toBe(true); expect((await fs.lstat(f.alias)).ino).toBe(inode);
      } finally { await fs.writeFile(lease,originalBytes); }
    }
  });
  it('preserves malformed, symlink, mode, inode, outside endpoint and legacy aliases', async () => {
    for (const kind of ['malformed','symlink','mode','inode','outside','legacy']) {
      const f=await crashedFixture();
      if(kind==='malformed') await fs.writeFile(f.alias,'bad');
      if(kind==='symlink') {await fs.unlink(f.alias);await fs.symlink(path.join(f.stateDir,`browser-${f.config.instance}.json`),f.alias);}
      if(kind==='mode') await fs.chmod(f.alias,0o644);
      if(kind==='inode') {await fs.unlink(f.alias);await fs.writeFile(f.alias,JSON.stringify(f.config),{mode:0o600});}
      if(kind==='outside') await fs.writeFile(f.alias,JSON.stringify({...f.config,socketPath:'/tmp/foreign.sock'}));
      if(kind==='legacy') {const {instance:_,...legacy}=f.config;await fs.writeFile(f.alias,JSON.stringify(legacy));}
      const before=await fs.readFile(f.alias), inode=(await fs.lstat(f.alias)).ino;
      await expect(startBrowserExtensionBroker({stateDir:f.stateDir,configAlias:'native-host.json'})).rejects.toThrow();
      expect((await fs.readFile(f.alias)).equals(before)).toBe(true);expect((await fs.lstat(f.alias)).ino).toBe(inode);
    }
  });
  it('preserves live and ambiguous endpoints and requires explicit repair on a later retry', async () => {
    for(const kind of ['live','timeout','permission']) {
      const f=await crashedFixture(); const before=await fs.readFile(f.alias); let listener: net.Server|undefined;
      if(kind==='live') {await fs.unlink(f.config.socketPath);listener=net.createServer(socket=>socket.on('error',()=>{}));await new Promise<void>(resolve=>listener!.listen(f.config.socketPath,resolve));await fs.chmod(f.config.socketPath,0o600);}
      const mock=kind==='live'?undefined:vi.spyOn(net,'createConnection').mockImplementation((()=>{const socket=new net.Socket();if(kind==='permission')queueMicrotask(()=>socket.emit('error',Object.assign(Error('denied'),{code:'EACCES'})));return socket;}) as typeof net.createConnection);
      try {await expect(startBrowserExtensionBroker({stateDir:f.stateDir,configAlias:'native-host.json'})).rejects.toThrow('browser_helper_repair_required');} finally {mock?.mockRestore();if(listener)await new Promise<void>(resolve=>listener!.close(()=>resolve()));}
      expect((await fs.readFile(f.alias)).equals(before)).toBe(true);
      await expect(startBrowserExtensionBroker({stateDir:f.stateDir,configAlias:'native-host.json'})).rejects.toThrow('browser_helper_repair_required');
    }
    const missing=await crashedFixture();await fs.unlink(missing.config.socketPath);
    const broker=await startBrowserExtensionBroker({stateDir:missing.stateDir,configAlias:'native-host.json'});cleanup.push(()=>broker.close());expect(readHostConfig(missing.alias).socketPath===missing.config.socketPath).toBe(false);
  });
  it('allows exactly one of two child contenders after a crash', async () => {
    const f=await crashedFixture();const contenders=await Promise.all([childBroker(f.stateDir),childBroker(f.stateDir)]);
    expect(contenders.filter(c=>c.result.ready)).toHaveLength(1);expect(contenders.filter(c=>['LEASE_BUSY','LEASE_RECOVERY_BUSY'].includes(c.result.code ?? ''))).toHaveLength(1);
    const inode=(await fs.stat(f.alias)).ino, before=await fs.readFile(f.alias);
    const loser=contenders.find(c=>!c.result.ready)!;if(loser.child.exitCode===null)await once(loser.child,'exit');
    expect((await fs.stat(f.alias)).ino).toBe(inode);expect((await fs.readFile(f.alias)).equals(before)).toBe(true);
  });
  it('cleans an injected publication failure, permits retry, and leaves registration artifacts unchanged', async () => {
    const stateDir=await recoveryDir();const files=['launcher','manifest.json','registration-chrome.json'];
    for(const file of files)writePrivateTestFile(path.join(stateDir,file),`fixture-${file}`);
    const before=await Promise.all(files.map(file=>fs.readFile(path.join(stateDir,file))));
    const mock=vi.spyOn(fs,'link').mockRejectedValueOnce(Object.assign(Error('fixture_failure'),{code:'EIO'}));
    try{await expect(startBrowserExtensionBroker({stateDir,configAlias:'native-host.json'})).rejects.toThrow('fixture_failure');}finally{mock.mockRestore();}
    expect((await fs.readdir(stateDir)).sort()).toEqual([...files].sort());
    const child=await childBroker(stateDir);expect(child.result.ready).toBe(true);await crash(child.child);
    const broker=await startBrowserExtensionBroker({stateDir,configAlias:'native-host.json'});await broker.close();
    for(let i=0;i<files.length;i++)expect((await fs.readFile(path.join(stateDir,files[i]))).equals(before[i])).toBe(true);
  });
});

describe('Astra 13: a connection that used all its request ids is rotated', () => {
  it('refuses the next request with reconnect_required, drops the connection, and accepts the extension again on a new one', async () => {
    const { root: stateRoot, directory: stateDir } = await privateTestDirectory(path.join(SHORT_ROOT, 'bex-'));
    cleanup.push(() => fs.rm(stateRoot, { recursive: true, force: true }));
    const broker = await startBrowserExtensionBroker({ stateDir, maxRequestsPerConnection: 3 }); cleanup.push(() => broker.close());
    const connect = async () => {
      const input = new PassThrough(), output = new PassThrough(); const messages: unknown[] = [];
      const decoder = new FrameDecoder(value => messages.push(value)); output.on('data', chunk => decoder.push(chunk));
      const host = runNativeHost({ input, output, config: readHostConfig(broker.configPath) }); cleanup.push(async () => host.stop());
      input.write(encodeFrame({ version: 1, type: 'hello', profileId: 'profile', browser: 'chromium', extensionVersion: '0.1.0', capabilities: ['ordered_requests_v1'] }));
      await expect.poll(() => broker.profiles().length).toBe(1);
      return { input, messages };
    };
    const first = await connect();
    for (let i = 1; i <= 3; i++) {
      const pending = broker.request('profile', { ...command, id: `r${i}` });
      await expect.poll(() => first.messages.length).toBe(i);
      first.input.write(encodeFrame({ version: 1, type: 'response', id: (first.messages[i - 1] as typeof command).id, bindingId: 'binding', generation: 1, result: { i } }));
      await expect(pending).resolves.toMatchObject({ result: { i } });
    }
    await expect(broker.request('profile', { ...command, id: 'r4' })).rejects.toThrow('reconnect_required');
    await expect.poll(() => broker.profiles().length).toBe(0);
    const second = await connect();
    const pending = broker.request('profile', { ...command, id: 'r5' });
    await expect.poll(() => second.messages.length).toBe(1);
    second.input.write(encodeFrame({ version: 1, type: 'response', id: (second.messages[0] as typeof command).id, bindingId: 'binding', generation: 1, result: { again: true } }));
    await expect(pending).resolves.toMatchObject({ result: { again: true } });
  });
});

describe("Vultr live bug 1: one oversize or too-deep response never destroys the connection", () => {
  it("fails that request with a clear code and serves the next one on the same connection", async () => {
    const f = await fixture();
    const first = f.broker.request('profile', command); const rejected = expect(first).rejects.toThrow('response_too_large');
    await expect.poll(() => f.messages.length).toBe(1);
    // A result nested far deeper than the wire allows (a hostile or enormous page tree).
    let deep: unknown = 1; for (let i = 0; i < 90; i++) deep = { n: deep };
    f.input.write(encodeFrame({ version: 1, type: 'response', id: (f.messages[0] as typeof command).id, bindingId: 'binding', generation: 1, result: deep } as never));
    await rejected; await expect(first).rejects.toMatchObject({ code: 'response_too_large' }); // L13: the bot gets the plain sentence, not the generic refusal
    expect(f.broker.profiles()).toHaveLength(1);
    const second = f.broker.request('profile', { ...command, id: 'request2' });
    await expect.poll(() => f.messages.length).toBe(2);
    f.input.write(encodeFrame({ version: 1, type: 'response', id: (f.messages[1] as typeof command).id, bindingId: 'binding', generation: 1, result: { ok: true } }));
    await expect(second).resolves.toMatchObject({ result: { ok: true } });
  });
  it("the wire now carries an accessibility tree of tens of thousands of values", async () => {
    const { parseBrowserExtensionMessage } = await import('../shared/browser-extension-protocol.ts');
    const nodes = Array.from({ length: 3000 }, (_, i) => ({ nodeId: String(i), role: { type: 'role', value: 'text' }, name: { type: 'x', value: 'n' }, childIds: [String(i + 1)], backendDOMNodeId: i, props: [{ a: 1 }, { b: 2 }] }));
    expect(() => parseBrowserExtensionMessage({ version: 1, type: 'response', id: 'r', bindingId: 'b', generation: 1, result: { nodes } })).not.toThrow();
  });
});
