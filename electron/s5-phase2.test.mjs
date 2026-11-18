import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import { createBackgroundLogin } from './background-login.mjs';
import { connectOwnerBrowser } from './browser-extension-registration.mjs';
import * as registration from './browser-extension-registration.mjs';
import { rebaseStoredPath } from '../shared/stored-root-path.mjs';
import { removeTempDirSync } from '../server/testing/cleanup.ts';

// On Windows keep the real relocation and receipt code, with fixture-only ACL, launcher and registry adapters.
vi.mock('./browser-extension-host.mjs', async original => {
  const actual = await original();
  return process.platform === 'win32' ? { ...actual, readHostConfig: () => ({}) } : actual;
});
vi.mock('./browser-extension-windows.mjs', async original => {
  const actual = await original();
  if (process.platform !== 'win32') return actual;
  const io = await import('node:fs');
  let installed;
  const adapter = {
    read: () => installed,
    installIfAbsentOrEqual(registry) { if (installed !== undefined && installed !== registry.value) throw Error('foreign registry'); installed = registry.value; },
    removeIfEqual(registry) { if (installed !== undefined && installed !== registry.value) throw Error('foreign registry'); installed = undefined; },
  };
  return { ...actual, readPrivateWindowsJson: file => JSON.parse(io.readFileSync(file, 'utf8')), writePrivateWindowsJson: (file, value) => io.writeFileSync(file, JSON.stringify(value)),
    windowsRegistrationAdapter: () => adapter,
    createWindowsBrowserLauncher(options) { io.writeFileSync(options.launcherPath, 'fixture launcher'); io.writeFileSync(options.launcherPath + '.launch', JSON.stringify(options)); },
  };
});

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

it.each([
  ['win32', 'C:\\new', 'C:\\new\\bx-run', ['bx-run']],
  ['win32', 'C:\\new', 'c:\\NEW\\browser-extension\\native-host', ['browser-extension', 'native-host']],
  ['linux', '/new', '/new/browser-extension/native-host', ['browser-extension', 'native-host']],
  ['linux', '/new', '/user/other', null],
])('site 20 the %s registration uses only its exact data-root directory constructor', (platform, dataDir, directory, expected) => {
  expect(registration.ownedRegistrationDirectoryParts?.({dataDir}, directory, platform)).toEqual(expected);
});

it('site 20 owner Connect re-registers a copied, unchanged browser receipt at its reconstructed location', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 's5-browser-')); roots.push(root);
  const dataDir = path.join(root, 'old'), nextDir = path.join(root, 'new');
  const directory = path.join(dataDir, 'browser-extension', 'native-host');
  const resources = path.join(root, 'resources');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(resources, 'browser-extension'), { recursive: true });
  await fs.writeFile(path.join(resources, 'browser-extension', 'native-host.mjs'), '// fake host');
  await fs.writeFile(path.join(resources, 'browser-extension', 'build.json'), JSON.stringify({ mode: 'development', developmentId: 'b'.repeat(32) }));
  const home = path.join(root, 'home');
  await fs.mkdir(path.join(home, '.config', 'chromium'), { recursive: true });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\s5-browser-${path.basename(root)}` : path.join(root, 'broker.sock');
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    if (process.platform !== 'win32') await fs.chmod(socketPath, 0o600);
    const configPath = path.join(root, 'native-host.json');
    await fs.writeFile(configPath, JSON.stringify({ version: 1, socketPath, token: 'a'.repeat(64) }), { mode: 0o600 });
    const options = { ownerConfirmed: true, browser: 'chromium', platform: process.platform === 'win32' ? 'win32' : 'linux', registrationHome: home, configPath, resourcesPath: resources, electronPath: process.execPath, registrationDirectory: directory, dataDir };
    await connectOwnerBrowser(options);
    await fs.rename(dataDir, nextDir);
    const currentDirectory = path.join(nextDir, 'browser-extension', 'native-host');
    const result = await connectOwnerBrowser({ ...options, dataDir: nextDir, previousDataDirs: [dataDir], registrationDirectory: currentDirectory });
    expect(result.status).toBe('installed');
    const launcherName = `browser-native-${result.registrationFamily}${process.platform === 'win32' ? '.exe' : ''}`;
    expect(JSON.parse(await fs.readFile(result.manifestPath, 'utf8')).path).toBe(path.join(currentDirectory, launcherName));
    expect((await fs.readFile(path.join(currentDirectory, launcherName) + (process.platform === 'win32' ? '.launch' : ''), 'utf8'))).not.toContain(directory);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

it('site 23 re-registers an owned login item after a recorded profile move, preserving disabled and foreign entries', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 's5-login-')); roots.push(root);
  const autostartDir = path.join(root, 'autostart'); mkdirSync(autostartDir);
  const prior = path.join(root, 'old'), current = path.join(root, 'new');
  const windows = process.platform === 'win32';
  let items=[];
  const app = { getLoginItemSettings: () => ({ launchItems: items }), setLoginItemSettings(value) {
    items=items.filter(item => item.name !== value.name);
    if(value.openAtLogin) items.push({ name:value.name, path:value.path, args:value.args.slice(1), scope:'user', enabled:value.enabled });
  } };
  const options = { platform: windows ? 'win32' : 'linux', app, installed: true, primaryProfile: true, profileDir: prior, userDataDir: path.join(root, 'ui'), executable: windows ? process.execPath : '/opt/murage', autostartDir };
  await createBackgroundLogin(options).write(true);
  writeFileSync(path.join(autostartDir, 'unrelated.desktop'), 'foreign');
  const login = createBackgroundLogin({ ...options, profileDir: current, previousProfileDirs: [prior] });
  await login.reconcile();
  expect(login.read().openAtLogin).toBe(true);
  const name = `murage-${createHash('sha256').update(current).digest('hex').slice(0, 16)}.desktop`;
  if(windows) { expect(items).toHaveLength(1); expect(items[0].args).toContain(current); expect(items[0].args).not.toContain(prior); }
  else { expect(readFileSync(path.join(autostartDir, name), 'utf8')).toContain(current); expect(readdirSync(autostartDir).sort()).toEqual([name, 'unrelated.desktop'].sort()); }
  expect(readFileSync(path.join(autostartDir, 'unrelated.desktop'), 'utf8')).toBe('foreign');
  await login.write(false);
  await login.reconcile();
  expect(login.read().openAtLogin).toBe(false);
});

it.each(['linux', 'darwin', 'win32'])('site 24 uses the same exact constructor and provenance rule on %s', platform => {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const previous = platform === 'win32' ? 'C:\\old' : '/old';
  const dataDir = platform === 'win32' ? 'D:\\new' : '/new';
  expect(rebaseStoredPath(previous, root => [root], { dataDir, previous: [previous], platform })).toEqual({ path: dataDir });
  expect(rebaseStoredPath(p.join(previous, 'other'), root => [root], { dataDir, previous: [previous], platform })).toEqual({ refused: true });
  expect(rebaseStoredPath(previous, root => [root], { dataDir, previous: [], platform })).toEqual({ keep: true });
});

it.each(['disabled', 'foreign'])('site 23 preserves a current Windows %s entry while retiring the owned prior entry', async state => {
  const prior='/fixture/old', current='/fixture/new', userDataDir='/fixture/ui', executable='C:\\Murage\\Murage.exe';
  const name=profile=>`Murage-${createHash('sha256').update(profile).digest('hex').slice(0,16)}`;
  const entry=profile=>({name:name(profile),path:executable,args:['--murage-login','--murage-data-dir',profile,'--murage-user-data',userDataDir],scope:'user',enabled:true});
  const currentEntry={...entry(current),enabled:false,...(state==='foreign'?{path:'C:\\Other\\Other.exe',enabled:true}:{})};
  let items=[entry(prior),currentEntry];const writes=[];
  const app={getLoginItemSettings:()=>({launchItems:items}),setLoginItemSettings:value=>{
    writes.push(value);items=items.filter(item=>item.name!==value.name);
    if(value.openAtLogin)items.push({name:value.name,path:value.path,args:value.args.slice(1),scope:'user',enabled:value.enabled});
  }};
  const login=createBackgroundLogin({platform:'win32',app,installed:true,primaryProfile:true,profileDir:current,userDataDir,executable,previousProfileDirs:[prior]});
  await login.reconcile();
  expect(items.find(item=>item.name===name(current))).toEqual(currentEntry);
  expect(writes.some(value=>value.name===name(current))).toBe(false);
  expect(items.some(item=>item.name===name(prior))).toBe(false);
});
