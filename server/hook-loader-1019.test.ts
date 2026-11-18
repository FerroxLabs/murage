import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOOK_LOADER } from './hook-canon.ts';
import { CODEX_HOOK_SCRIPT } from './drivers/codex-hook.ts';
import { ANTIGRAVITY_RELAY_SCRIPT } from './drivers/antigravity-relay.ts';
import { shellArg } from './hook-shell-arg.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const denial = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Murage could not confirm its tool check' } };
function fixture(engine: keyof typeof HOOK_LOADER = 'codex', extension = 'cjs', source = 'process.stdout.write("canonical")') {
  const dir = mkdtempSync(join(tmpdir(), 'hook-loader-')); roots.push(dir);
  const path = join(dir, 'hook.' + extension);
  const preload = join(dir, 'seam.cjs');
  writeFileSync(path, source); writeFileSync(preload, '');
  const run = (options: { hash?: string; input?: string; seam?: string; missing?: boolean; env?: NodeJS.ProcessEnv; args?: string[] } = {}) => {
    writeFileSync(preload, options.seam ?? '');
    return spawnSync(process.execPath, ['-r', preload, '-e', HOOK_LOADER[engine], options.missing ? join(dir, 'missing.cjs') : path, options.hash ?? sha(source), ...(options.args ?? [])], {
      input: options.input ?? '{"hook_event_name":"PreToolUse"}', encoding: 'utf8', timeout: 1000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...options.env },
    });
  };
  return { dir, path, run, source };
}
describe('T13/T14 authentic loader executes the verified buffer', () => {
  for (const extension of ['cjs', 'mjs']) {
    it(`${extension}: matching bytes execute; mismatched and missing bytes deny`, () => {
      const f = fixture('codex', extension);
      expect(f.run().stdout).toBe('canonical');
      expect(JSON.parse(f.run({ hash: '0'.repeat(64) }).stdout)).toEqual(denial);
      expect(JSON.parse(f.run({ missing: true }).stdout)).toEqual(denial);
    });
    it(`T14b ${extension}: replacement after verification never executes`, () => {
      const f = fixture('codex', extension);
      const result = f.run({ seam: `globalThis.MURAGE_LOADER_AFTER_VERIFY=()=>require('fs').writeFileSync(${JSON.stringify(f.path)},'process.stdout.write("replacement")')` });
      expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('canonical');
    });
  }
  it('T14a replacement before loader read denies', () => {
    const f = fixture(); writeFileSync(f.path, 'process.stdout.write("replacement")');
    expect(JSON.parse(f.run().stdout)).toEqual(denial);
  });
  for (const swap of [false, true]) it.runIf(process.platform !== 'win32')(`FIFO ${swap ? 'substituted just before open' : 'already present'} never blocks`, () => {
    const f = fixture();
    const seam = `const fs=require('fs'),cp=require('child_process');const swap=()=>{fs.unlinkSync(${JSON.stringify(f.path)});cp.execFileSync('mkfifo',[${JSON.stringify(f.path)}])};` +
      (swap ? `const open=fs.openSync;fs.openSync=function(p,...args){if(p===${JSON.stringify(f.path)}) swap();return open.call(this,p,...args)}` : 'swap();');
    const result = f.run({ seam });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(denial);
  });
});
describe('T13c denial output and stdin', () => {
  const writer = {
    partial: `const w=fs.writeSync;fs.writeSync=function(fd,b,o,n){return w.call(this,fd,b,o,Math.min(n,7))}`,
    zero: `fs.writeSync=()=>0`,
    epipe: `fs.writeSync=()=>{throw Object.assign(new Error('pipe'),{code:'EPIPE'})}`,
  };
  for (const engine of ['codex', 'antigravity', 'hermes'] as const) for (const [name, seam] of Object.entries(writer)) {
    it(`${engine} ${name} output`, () => {
      const f = fixture(engine);
      const result = f.run({ hash: '0'.repeat(64), seam: 'const fs=require("fs");' + seam });
      expect(result.status).toBe(engine === 'hermes' ? 1 : name === 'partial' ? 0 : 2);
      if (engine === 'hermes') expect(result.stdout).toBe('');
      else if (name === 'partial') expect(JSON.parse(result.stdout)).toEqual(engine === 'codex' ? denial : { decision: 'deny', reason: 'Murage could not confirm its tool check' });
    });
  }
  it('Hermes writes no denial bytes on failure', () => {
    const result = fixture('hermes').run({ hash: '0'.repeat(64), seam: `const fs=require('fs'),write=fs.writeSync;let n=0;fs.writeSync=()=>{n++;throw Error('writer must not run')};process.on('exit',()=>write(2,String(n)))` });
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe('0');
  });
  for (const input of ['{x', '', '{}', '{"hook_event_name":"unknown"}', 'null']) it(`invalid stdin ${JSON.stringify(input)} denies`, () => {
    const result = fixture().run({ input }); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(denial);
  });
  for (const event of ['SessionStart', 'Stop', 'SubagentStop']) it(`${event} failure writes nothing`, () => {
    const result = fixture().run({ hash: '0'.repeat(64), input: JSON.stringify({ hook_event_name: event }) });
    expect(result.stdout).toBe(''); expect(result.status).toBe(event === 'SessionStart' ? 2 : 0);
  });
  for (const name of ['normal', 'partial', 'zero', 'epipe'] as const) it(`T13c(g) prefix consumed then EIO, ${name} writer: no retry or script open`, () => {
    const f = fixture();
    const marker = join(f.dir, 'opened');
    const seam = `const fs=require('fs');const read=fs.readFileSync,open=fs.openSync,write=fs.writeSync;let attempts=0;fs.openSync=function(p,...a){if(p===${JSON.stringify(f.path)}) fs.writeFileSync(${JSON.stringify(marker)},'opened');return open.call(this,p,...a)};fs.readFileSync=function(fd,...a){if(fd===0){attempts++;write(2,String(attempts));fs.readSync(0,Buffer.alloc(5),0,5,null);throw Object.assign(new Error('read'),{code:'EIO'})}return read.call(this,fd,...a)};` + (name === 'normal' ? '' : writer[name]);
    const result = f.run({ seam });
    expect(result.stderr).toBe('1'); expect(existsSync(marker)).toBe(false);
    expect(result.status).toBe(name === 'zero' || name === 'epipe' ? 2 : 0);
    if (result.status === 0) expect(JSON.parse(result.stdout)).toEqual(denial);
  });
  it('import rejection uses the cached event without another stdin read', () => {
    const f = fixture('codex', 'mjs', 'if(!Buffer.isBuffer(globalThis.MURAGE_HOOK_STDIN)) throw Error();await Promise.reject(Error("failed"))');
    const result = f.run({ seam: `const fs=require('fs'),r=fs.readFileSync;let n=0;fs.readFileSync=function(fd,...a){if(fd===0){n++;fs.writeSync(2,String(n))}return r.call(this,fd,...a)}` });
    expect(result.stderr).toBe('1'); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(denial);
  });
});
describe('T16 final rendered loaders and shell paths', () => {
  for (const [engine, loader] of Object.entries(HOOK_LOADER)) it(`${engine}: shell-safe body and buffer-only execution`, () => {
    expect(loader).not.toMatch(/["$`\\%!^&|<>]/);
    expect(loader.match(/b\.toString\(/g)).toHaveLength(2);
    expect(loader).not.toMatch(/require\(p\)|pathToFileURL|import\(p|readFileSync\(p\)/);
    expect(loader).toContain('readFileSync(fd)'); expect(loader).toContain('fstatSync(fd).isFile()');
    expect(loader).toContain('while(B.length-o)');
  });
  for (const name of ['space name', '日本語', "&;()'", '$HOME', '$(touch pwn)', '`touch pwn`', 'back\\slash']) it.runIf(process.platform !== 'win32')(`T16b literal path ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-arg-')); roots.push(dir);
    const path = join(dir, name); writeFileSync(path, 'process.stdout.write(process.argv[1])');
    const result = spawnSync('/bin/sh', ['-c', `${shellArg(process.execPath, 'posix')} -e "${HOOK_LOADER.antigravity}" ${shellArg(path, 'posix')} ${sha('process.stdout.write(process.argv[1])')}`], { cwd: dir, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe(path); expect(existsSync(join(dir, 'pwn'))).toBe(false);
  });
  for (const bad of ['bad\0path', 'bad\npath']) it('refuses unsafe paths before launching', () => { expect(() => shellArg(bad, 'posix')).toThrow(); });
});

describe('T13/T15 env readers refuse changed bytes and FIFOs before connecting', () => {
  for (const engine of ['codex', 'antigravity'] as const) for (const mode of ['changed', 'fifo', 'swap-fifo'] as const) it.runIf(mode === 'changed' || process.platform !== 'win32')(`${engine} ${mode}`, () => {
    const f = fixture(engine, engine === 'codex' ? 'mjs' : 'cjs', engine === 'codex' ? CODEX_HOOK_SCRIPT : ANTIGRAVITY_RELAY_SCRIPT);
    mkdirSync(join(f.dir, 'hook-env'));
    const envFile = engine === 'codex' ? join(f.dir, 'hook-env', 'process.env') : join(f.dir, 'murage-agy-relay.env');
    const expected = 'SOCKET=/unused\nTOKEN=canonical\n';
    writeFileSync(envFile, mode === 'changed' ? expected.replace('canonical', 'tampered!') : expected);
    const marker = join(f.dir, 'connected');
    let seam = `const fs=require('fs'),net=require('net'),cp=require('child_process');net.connect=()=>{fs.writeFileSync(${JSON.stringify(marker)},'connected');throw Error('must not connect')};`;
    if (mode !== 'changed') {
      seam += `const swap=()=>{fs.unlinkSync(${JSON.stringify(envFile)});cp.execFileSync('mkfifo',[${JSON.stringify(envFile)}])};`;
      seam += mode === 'fifo' ? 'swap();' : `const open=fs.openSync;fs.openSync=function(p,...a){if(p===${JSON.stringify(envFile)}) swap();return open.call(this,p,...a)}`;
      seam += `;require('module').syncBuiltinESMExports();`;
    }
    const result = f.run({ seam, env: { MURAGE_CODEX_HOOK_ENV: envFile, MURAGE_CODEX_HOOK_ENV_SHA256: sha(expected) }, args: [sha(expected)] });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const answer = JSON.parse(result.stdout);
    expect(engine === 'codex' ? answer.hookSpecificOutput.permissionDecision : answer.decision).toBe('deny');
  });
});

describe('T16 Windows command-layer validation', () => {
  for (const layer of ['codex-runtime', 'codex-scope', 'cmd'] as const) {
    for (const bad of ['quote"name', 'nul\0name', 'line\nname']) it(`${layer} refuses an unrepresentable path`, () => { expect(() => shellArg(bad, layer)).toThrow(); });
    it(`${layer} preserves spaces, Unicode and quoted metacharacters`, () => { const path = "C:\\日本語 &;()^\\runtime.exe"; expect(shellArg(path, layer)).toBe('"' + path + '"'); });
  }
  it('Codex runtime percent is one env expansion; scope percent is rejected', () => {
    expect(shellArg('C:\\%literal%\\runtime.exe', 'codex-runtime')).toBe('"C:\\%literal%\\runtime.exe"');
    expect(() => shellArg('C:\\%literal%\\scope', 'codex-scope')).toThrow();
    expect(() => shellArg('C:\\%literal%\\runtime.exe', 'cmd')).toThrow();
  });
  it('only the known delayed-expansion-off Codex layer accepts !', () => {
    expect(shellArg('C:\\literal!\\runtime.exe', 'codex-runtime')).toContain('literal!');
    expect(() => shellArg('C:\\literal!\\runtime.exe', 'cmd')).toThrow();
  });
});
