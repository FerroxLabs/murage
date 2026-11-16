import { removeTempDirSync } from "../../testing/cleanup.ts";
import { existsSync, mkdtempSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CopilotMcpConfig, reclaimCopilotMcpConfigs } from './copilot-mcp-config.ts';

it('gives each child its own file and removes only the released generation', async () => {
  const files = await CopilotMcpConfig.create();
  try {
    const first = files.prepare('same', []), second = files.prepare('same', []);
    expect(first).not.toBe(second);
    files.release(first);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    files.release(second);
    expect(readdirSync(dirname(second))).toEqual(['owner.json']);
  } finally { await files.dispose(); }
});

it('reclaims dead owners, retains live owners and never follows directory or owner links', async () => {
  const base = mkdtempSync(join(tmpdir(), 'copilot-reclaim-'));
  const make = (pid: number) => {
    const dir = mkdtempSync(join(base, 'murage-copilot-mcp-'));
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid }));
    writeFileSync(join(dir, 'secret.json'), 'synthetic');
    return dir;
  };
  // Deterministic ESRCH, while the real PID and argv inventory still protect the live control.
  const kill = process.kill.bind(process);
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 2147483647) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return kill(pid, signal);
  });
  try {
    const dead = make(2147483647), live = make(process.pid), linkedOwner = make(2147483647);
    rmSync(join(linkedOwner, 'owner.json'));
    symlinkSync(join(dead, 'owner.json'), join(linkedOwner, 'owner.json'));
    const alias = join(base, 'murage-copilot-mcp-SyM123');
    symlinkSync(live, alias, 'dir');
    await reclaimCopilotMcpConfigs(base);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(alias)).toBe(true);
    expect(existsSync(join(linkedOwner, 'secret.json'))).toBe(true);
  } finally { spy.mockRestore(); removeTempDirSync(base); }
});

it('reclaims Windows configs without getuid and retains linked owner files', async () => {
  const base = mkdtempSync(join(tmpdir(), 'copilot-win-reclaim-'));
  const make = () => {
    const dir = mkdtempSync(join(base, 'murage-copilot-mcp-'));
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
    writeFileSync(join(dir, 'secret.json'), 'planted');
    return dir;
  };
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  const dead = make(), linked = make(), ownerless = make();
  rmSync(join(linked, 'owner.json')); symlinkSync(join(dead, 'owner.json'), join(linked, 'owner.json'));
  rmSync(join(ownerless, 'owner.json'));
  const sweep = vi.fn(async () => [] as number[]);
  try {
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    await (reclaimCopilotMcpConfigs as (base: string, options: { platform: NodeJS.Platform; sweep: typeof sweep }) => Promise<void>)(base, { platform: 'win32', sweep });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(linked)).toBe(true);
    expect(existsSync(ownerless)).toBe(true);
    expect(sweep).toHaveBeenCalledWith(dead, 'win32');
  } finally {
    if (descriptor) Object.defineProperty(process, 'getuid', descriptor);
    else delete (process as { getuid?: unknown }).getuid;
    kill.mockRestore(); removeTempDirSync(base);
  }
});
