import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { nativeProcessList } from './drivers/win-process-table.ts';

export type DaemonIdentity = { pid: number; start: string; bootId: string };
export type CloseTarget = { botId: string; command: string; socketDir: string; session: string };
export type DaemonVerdict = 'alive' | 'gone' | 'unknown';
const word = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\0\r\n]/u.test(v);
export function validDaemonIdentity(v: unknown): v is DaemonIdentity {
  if (!v || typeof v !== 'object') return false;
  const x = v as DaemonIdentity;
  return Number.isSafeInteger(x.pid) && x.pid > 0 && word(x.start, 128) && word(x.bootId, 128);
}
export function validCloseTarget(v: unknown): v is CloseTarget {
  if (!v || typeof v !== 'object') return false;
  const x = v as CloseTarget;
  return word(x.botId, 120) && word(x.command) && word(x.socketDir) && typeof x.session === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(x.session);
}
const commandText = (file: string, args: string[]) => new Promise<string | undefined>(resolve => {
  execFile(file, [...args], withHideInherit({ timeout: 2000, maxBuffer: 4096, encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } }), (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
});
async function bootId(): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
    if (process.platform === 'darwin') return await commandText('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
    // Windows creation time is absolute across boots. The native table is the
    // proof there; no estimate made from uptime is used as a boot identifier.
    if (process.platform === 'win32') return 'windows-creation-time';
  } catch { /* unknown */ }
  return undefined;
}
function windowsStart(entry: { start?: number }): string | undefined {
  return typeof entry.start === 'number' && Number.isFinite(entry.start) && entry.start > 0 ? String(entry.start) : undefined;
}
async function processStart(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')'); if (end < 0) return undefined;
      const value = stat.slice(end + 2).split(/\s+/u)[19];
      return value && /^\d+$/u.test(value) ? value : undefined;
    }
    if (process.platform === 'darwin') return await commandText('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
  } catch { /* unknown */ }
  return undefined;
}
function alive(pid: number): boolean | undefined {
  try { process.kill(pid, 0); return true; }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === 'ESRCH' ? false : code === 'EPERM' ? true : undefined; }
}
export async function captureDaemonIdentity(pid: number, command: string): Promise<DaemonIdentity | undefined> {
  if (process.env.MURAGE_CLOUD_ROLE === 'home' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const boot = await bootId();
  let start: string | undefined;
  if (process.platform === 'win32') {
    const entry = nativeProcessList()?.find(e => e.pid === pid);
    if (entry?.exe?.toLowerCase() === command.toLowerCase()) start = windowsStart(entry);
  } else start = await processStart(pid);
  return start && boot && alive(pid) === true ? { pid, start, bootId: boot } : undefined;
}
type Reads = { alive: (pid: number) => boolean | undefined | Promise<boolean | undefined>; boot: () => string | undefined | Promise<string | undefined>; start: (pid: number) => string | undefined | Promise<string | undefined> };
export async function judgeDaemonIdentity(identity: DaemonIdentity | undefined, command: string, reads?: Reads): Promise<DaemonVerdict> {
  if (process.env.MURAGE_CLOUD_ROLE === 'home' || !validDaemonIdentity(identity)) return 'unknown';
  try {
    if (!reads && process.platform === 'win32') {
      const list = nativeProcessList(); if (!list) return 'unknown';
      const entry = list.find(e => e.pid === identity.pid); if (!entry) return 'gone';
      if (!word(entry.exe)) return 'unknown';
      if (entry.exe.toLowerCase() !== command.toLowerCase()) return 'gone';
      const start = windowsStart(entry); if (!start || !Number.isFinite(Number(identity.start))) return 'unknown';
      return Math.abs(Number(start) - Number(identity.start)) > 1 ? 'gone' : 'alive';
    }
    const r = reads ?? { alive, boot: bootId, start: processStart };
    const present = await r.alive(identity.pid); if (present === false) return 'gone'; if (present !== true) return 'unknown';
    const boot = await r.boot(); if (!word(boot, 128)) return 'unknown'; if (boot !== identity.bootId) return 'gone';
    const start = await r.start(identity.pid); if (!word(start, 128)) return 'unknown';
    return start === identity.start ? 'alive' : 'gone';
  } catch { return 'unknown'; }
}
