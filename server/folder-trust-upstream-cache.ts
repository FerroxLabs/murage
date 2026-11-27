// Producer: FUIGO-TRUST-V2 store seat (-b). Consumers: ACP driver (-a), turn assembly (-c).
// FROZEN INTERFACE (2026-11-16): UpstreamStoreState readable|unreadable|absent.
import { statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { folderTrustKey, isUnrecordableTrustRoot, parseUpstreamTrustedFolders, trustPath } from './folder-trust.ts';

export type UpstreamStoreState = 'readable' | 'unreadable' | 'absent';
type Entry = { identity: string; ready: boolean; one: Map<string, boolean>; two: Map<string, boolean> };
const cache = new Map<string, Entry>();
const identityOf = (file: string) => {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error('not a regular trust file');
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
};
const normalized = (records: Map<string, boolean>) => {
  const index = new Map<string, boolean>();
  for (const [raw, value] of records) {
    const key = trustPath(raw);
    index.set(key, (index.get(key) ?? true) && value);
  }
  return index;
};
const lookup = (records: Map<string, boolean>, key: string, home: string): boolean | null => {
  const ownKey = folderTrustKey(key, { fuigoHome: home });
  for (let at = key; ; at = dirname(at)) {
    if (records.has(at) && !isUnrecordableTrustRoot(at) && folderTrustKey(at, { fuigoHome: home }) === ownKey) return records.get(at)!;
    if (at === dirname(at)) return null;
  }
};

/** Constant metadata check plus component-bounded query. A changed file is
 * unknown while its new parsed index is prepared outside the turn's stack. */
export function upstreamTrustForTurn(home: string | null, key: string, generation: 1 | 2): { state: UpstreamStoreState; readable: boolean; trusted: boolean; declined: boolean; revision: string } {
  if (!home) return { state: 'absent', readable: true, trusted: false, declined: false, revision: 'temporary' };
  const file = join(home, 'trusted_folders.toml');
  let identity: string;
  try { identity = identityOf(file); }
  catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === 'ENOENT';
    cache.delete(file);
    return { state: absent ? 'absent' : 'unreadable', readable: absent, trusted: false, declined: false, revision: absent ? 'absent' : 'unreadable' };
  }
  let entry = cache.get(file);
  if (!entry || entry.identity !== identity) {
    entry = { identity, ready: false, one: new Map(), two: new Map() };
    cache.set(file, entry);
    const pending = entry;
    setImmediate(() => {
      try {
        const text = readFileSync(file, 'utf8');
        const one = parseUpstreamTrustedFolders(text, 1), two = parseUpstreamTrustedFolders(text, 2);
        if (!one || !two || cache.get(file) !== pending || identityOf(file) !== identity) return;
        pending.one = normalized(one); pending.two = normalized(two); pending.ready = true;
      } catch { /* changed, unreadable or malformed remains unknown, never a grant */ }
    });
  }
  if (!entry.ready) return { state: 'unreadable', readable: false, trusted: false, declined: false, revision: identity };
  const verdict = lookup(generation === 1 ? entry.one : entry.two, key, home);
  return { state: 'readable', readable: true, trusted: verdict === true, declined: verdict === false && lookup(entry.one, key, home) === false, revision: identity };
}
