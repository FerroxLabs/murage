// Producer: FUIGO-TRUST-V2 store seat (-b). Consumers: ACP driver (-a), turn assembly (-c).
// FROZEN INTERFACE (2026-11-16): UpstreamStoreState readable|unreadable|absent.
import { promises as fsp, type Stats } from 'node:fs';
import { nextFsTicket, trustFs, trustFsRunClean, trustFsStatTicket } from './trust-fs.ts';
import { dirname, join } from 'node:path';
import { folderTrustKey, isUnrecordableTrustRoot, parseUpstreamTrustedFolders, trustPath } from './folder-trust.ts';

export type UpstreamStoreState = 'readable' | 'unreadable' | 'absent';
type Verdict = { trusted: boolean; declined: boolean };
type Entry = { identity: string; ready: boolean; one: Map<string, boolean>; two: Map<string, boolean>; verdicts: Map<string, Verdict> };
const cache = new Map<string, Entry>();
// The last REAL identity stat of each trust file (from a turn's snapshot run that saw only real answers, or an off-thread refresh),
// for `upstreamTrustNow`, which never makes a file call on the serving thread.
const known = new Map<string, { identity: string } | { code: string }>();
const refreshing = new Set<string>();
const verdictKey = (generation: 1 | 2, key: string) => `${generation}\0${key}`;
const identityFrom = (stat: Stats) => {
  if (!stat.isFile()) throw new Error('not a regular trust file');
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
};
const identityOf = (file: string) => identityFrom(trustFs.statSync(file));
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
  const ticket = trustFsStatTicket(file);
  try { identity = identityOf(file); }
  catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (trustFsRunClean() !== false) landStat(file, ticket, { code: (error as NodeJS.ErrnoException).code ?? 'EIO' });
    cache.delete(file);
    return { state: absent ? 'absent' : 'unreadable', readable: absent, trusted: false, declined: false, revision: absent ? 'absent' : 'unreadable' };
  }
  if (trustFsRunClean() !== false) landStat(file, ticket, { identity });
  let entry = cache.get(file);
  if (!entry || entry.identity !== identity) {
    entry = { identity, ready: false, one: new Map(), two: new Map(), verdicts: new Map() };
    cache.set(file, entry);
    const pending = entry;
    // read and parsed off the serving thread (1.0.22 N3: a file call there is what froze the app)
    void (async () => {
      try {
        const text = await fsp.readFile(file, 'utf8');
        const one = parseUpstreamTrustedFolders(text, 1), two = parseUpstreamTrustedFolders(text, 2);
        if (!one || !two || cache.get(file) !== pending || identityFrom(await fsp.stat(file)) !== identity) return;
        pending.one = normalized(one); pending.two = normalized(two); pending.ready = true;
      } catch { /* changed, unreadable or malformed remains unknown, never a grant */ }
    })();
  }
  if (!entry.ready) return { state: 'unreadable', readable: false, trusted: false, declined: false, revision: identity };
  const verdict = lookup(generation === 1 ? entry.one : entry.two, key, home);
  const answer = { trusted: verdict === true, declined: verdict === false && lookup(entry.one, key, home) === false };
  if (trustFsRunClean() !== false) entry.verdicts.set(verdictKey(generation, key), answer);
  return { state: 'readable', readable: true, ...answer, revision: identity };
}

/** The same answer for a check made AFTER the turn's trust step (FolderTrustIndex.sourceNow: the ACP launch, its epoch checks, the
 * engine's own trust request), with no file call on the serving thread (1.0.24 S03; Astra 5f3b49f69b: the launch statted the engine's
 * trust file live). It reads the last real identity stat and the verdict the turn's snapshot run computed for this key, and refreshes
 * the identity off the thread, so a file changed mid-turn shows up as a new revision on a later check. Anything it does not hold
 * (no stat yet, an identity the turn did not see, a key the turn did not compute) is unknown: never a grant, never a live call. */
export function upstreamTrustNow(home: string | null, key: string, generation: 1 | 2): { state: UpstreamStoreState; readable: boolean; trusted: boolean; declined: boolean; revision: string } {
  if (!home) return { state: 'absent', readable: true, trusted: false, declined: false, revision: 'temporary' };
  const file = join(home, 'trusted_folders.toml');
  refreshIdentity(file);
  const stat = known.get(file);
  if (!stat) return { state: 'unreadable', readable: false, trusted: false, declined: false, revision: 'unknown' };
  if ('code' in stat) {
    const absent = stat.code === 'ENOENT';
    return { state: absent ? 'absent' : 'unreadable', readable: absent, trusted: false, declined: false, revision: absent ? 'absent' : 'unreadable' };
  }
  const entry = cache.get(file);
  const verdict = entry && entry.ready && entry.identity === stat.identity ? entry.verdicts.get(verdictKey(generation, key)) : undefined;
  // an entry parsed after the turn step is a new revision (still unknown for this turn: its verdict was never computed in a snapshot)
  if (!verdict) return { state: 'unreadable', readable: false, trusted: false, declined: false, revision: entry?.ready && entry.identity === stat.identity ? `${stat.identity}+ready` : stat.identity };
  return { state: 'readable', readable: true, ...verdict, revision: stat.identity };
}
function refreshIdentity(file: string): void {
  if (refreshing.has(file)) return;
  refreshing.add(file);
  void statIdentity(file).finally(() => refreshing.delete(file));
}
// Stats land in the order they STARTED (one ticket order, trust-fs.ts nextFsTicket): an older stat that lands late never overwrites a newer
// one. A turn step's stat is ordered by when its snapshot stat started, not by when the turn replays it (Astra 1afc268eb5: another turn
// replaying a snapshot taken before a decline marked the reply's fresh stat as landed, so it was dropped and the old verdict granted).
const statLanded = new Map<string, number>();
function landStat(file: string, at: number, value: { identity: string } | { code: string }): void {
  if (at <= (statLanded.get(file) ?? 0)) return;
  statLanded.set(file, at);
  known.set(file, value);
}
async function statIdentity(file: string): Promise<void> {
  const at = nextFsTicket();
  let value: { identity: string } | { code: string };
  try {
    const stat = await fsp.stat(file);
    try { value = { identity: identityFrom(stat) }; } catch { value = { code: 'EINVAL' }; }
  } catch (error) { value = { code: (error as NodeJS.ErrnoException).code ?? 'EIO' }; }
  landStat(file, at, value);
}

/** One fresh off-thread stat of the engine's trust file, started now (never an older one in flight): what a grant waits for, so
 * `upstreamTrustNow` answers it from the file as it is when the engine asks, not as it was at the last check (Astra/Opus d66f84912c:
 * a decline written mid-turn was missed by the automatic reply). A changed file is then a new revision: unknown, never a grant. */
export async function refreshUpstreamTrust(home: string | null): Promise<void> {
  if (home) await statIdentity(join(home, 'trusted_folders.toml'));
}

/** The file calls `upstreamTrustForTurn` makes for a warm entry (the identity stat and the ancestor key lookups), for the turn's snapshot
 * (trust-fs.ts). Makes none that the live call would not, and changes nothing: a cold or changed entry is read off the thread by the call itself. */
export function probeUpstreamTrustFs(home: string | null, key: string, generation: 1 | 2): void {
  if (!home) return;
  const file = join(home, 'trusted_folders.toml');
  let identity: string;
  try { identity = identityOf(file); } catch { return; }
  const entry = cache.get(file);
  if (entry?.ready && entry.identity === identity) lookup(generation === 1 ? entry.one : entry.two, key, home);
}
