import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../../atomic.ts';
import { sweepByArgv } from '../../memory/pip-reaper.ts';

export interface AcpLaunchMcpServer { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
const PREFIX = 'murage-copilot-mcp-';
const live = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};

/** Unknown ownership is retained. Like the PIP orphan sweep, a failed process inventory is never evidence of absence. */
export async function reclaimCopilotMcpConfigs(base = tmpdir(), options: { platform?: NodeJS.Platform; sweep?: typeof sweepByArgv } = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && !process.getuid) return;
  const uid = platform === 'win32' ? undefined : process.getuid!();
  const owned = (stat: { uid: number }) => platform === 'win32' || stat.uid === uid;
  for (const name of readdirSync(base)) {
    if (!/^murage-copilot-mcp-[A-Za-z0-9]+$/.test(name)) continue;
    const directory = join(base, name);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) continue;
      // Do not follow an owner-file link, including a dangling one.
      const ownerPath = join(directory, 'owner.json');
      const before = lstatSync(ownerPath);
      if (!before.isFile() || before.isSymbolicLink() || !owned(before)) continue;
      const fd = openSync(ownerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let owner: { pid?: unknown };
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || !owned(info) || info.dev !== before.dev || info.ino !== before.ino || info.size > 1024) continue;
        owner = JSON.parse(readFileSync(fd, 'utf8'));
      } finally { closeSync(fd); }
      if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || live(owner.pid as number)) continue;
      // A child may survive the server. Its launch argv names this directory.
      const users = await (options.sweep ?? sweepByArgv)(directory, platform);
      if (users === null || users.length) continue;
      const now = lstatSync(directory);
      if (now.dev !== stat.dev || now.ino !== stat.ino || now.isSymbolicLink() || !owned(now)) continue;
      await rm(directory, { recursive: true, force: true });
    } catch { /* Unreadable or replaced files and concurrent cleanup are retained. Ownerless pre-fix directories may hold credentials; retain them without guessing ownership. */ }
  }
}

/** Only the turn's already-scoped proxy definitions enter these private files. */
export class CopilotMcpConfig {
  private directory: string;
  private constructor(directory: string) { this.directory = directory; }
  static async create(): Promise<CopilotMcpConfig> {
    await reclaimCopilotMcpConfigs();
    const directory = await mkdtemp(join(tmpdir(), PREFIX));
    try { writeFileAtomic(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return new CopilotMcpConfig(directory);
  }
  prepare(threadId: string, servers: readonly AcpLaunchMcpServer[]): string {
    const path = join(this.directory, createHash('sha256').update(threadId).update(randomUUID()).digest('hex') + '.json');
    const mcpServers = Object.fromEntries(servers.map(server => [server.name, {
      type: 'local', command: server.command, args: server.args,
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])), tools: ['*'],
    }]));
    try { writeFileAtomic(path, JSON.stringify({ mcpServers }), { mode: 0o600 }); }
    catch (error) { rmSync(path, { force: true }); throw error; }
    return path;
  }
  release(path: string): void { rmSync(path, { force: true }); }
  dispose(): Promise<void> { return rm(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
