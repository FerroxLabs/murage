// Producer/store owner: FUIGO-TRUST-V2 store seat (-b). Consumers: ACP driver (-a), index.ts/API/Settings (-c), seeds.
// FROZEN INTERFACE (2026-11-16): FolderTrustIndex {revision, fingerprint, lookup, prefixLookup, declineCoverage}.
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { isUnrecordableTrustRoot, pathStartsWith, trustPath, type FolderTrustRecord, type FolderTrustReject } from './folder-trust.ts';

export type DeclineCoverage = 'complete' | 'incomplete' | 'unknown';
export interface FolderTrustLookup {
  readonly decision: 'trust' | 'reject' | 'none';
  readonly consent: 2 | null;
  readonly picked: boolean;
  readonly reject: FolderTrustReject | null;
}
export interface FolderTrustIndex {
  /** Changes with every durable decision change; equal revisions mean equal decisions. */
  readonly revision: string;
  readonly fingerprint: string;
  /** Point lookup of one exact stored key. Never walks records. */
  lookup(key: string): FolderTrustLookup;
  /** Saved declines at or below `root` (a decline the folder would not see on its own path), bounded. */
  prefixLookup(root: string): { readonly declines: readonly string[]; readonly truncated: boolean };
  /** complete: every saved decline fits the seed projection; incomplete: some did not fit; unknown: the store was not readable. */
  declineCoverage(): DeclineCoverage;
  readonly rejectCount: number;
  readonly seedComplete: boolean;
  readonly seed: { readonly trustKeys: readonly string[]; readonly rejects: readonly FolderTrustReject[] };
  hasDescendantDecline(key: string): boolean;
  trusts(key: string): boolean;
  picked(key: string): boolean;
  rejectFor(key: string, cwd: string): FolderTrustReject | null;
  /** Explicit card/list recovery only. Never used to build a turn. */
  declines(key: string, ancestors?: boolean): string[];
}
export type FolderTrustSnapshot = FolderTrustIndex;
const PREFIX_LOOKUP_MAX = 64;
const NONE: FolderTrustLookup = Object.freeze({ decision: 'none', consent: null, picked: false, reject: null });
const ancestors = function* (path: string) {
  for (let at = trustPath(path); ; at = dirname(at)) { yield at; if (dirname(at) === at) return; }
};

/** Built only at boot or after an explicit saved-state mutation. The capability
 * closes over private maps; old consumers cannot see a partially updated index. */
export function buildFolderTrustSnapshot(records: ReadonlyMap<string, FolderTrustRecord>, readable = true): FolderTrustIndex {
  const byKey = new Map<string, FolderTrustRecord>();
  const trusts = new Set<string>(), picks = new Set<string>(), byPath = new Map<string, FolderTrustReject>();
  const rejects: FolderTrustReject[] = [];
  const ordered = [...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const fingerprint = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  for (const [key, record] of ordered) {
    byKey.set(key, record);
    if (record.decision === 'reject') {
      const reject = Object.freeze({ key, folder: record.folder });
      rejects.push(reject);
      for (const raw of [key, record.folder]) {
        const path = trustPath(raw);
        if (!isUnrecordableTrustRoot(path) && !byPath.has(path)) byPath.set(path, reject);
      }
    } else if (record.consent === 2) trusts.add(key);
    else if (record.source === 'picker') picks.add(key);
  }
  // Built once here, at boot or mutation. A turn reads one bucket per root, at most PREFIX_LOOKUP_MAX + 1 long, never the records.
  const descendants = new Map<string, string[]>();
  for (const path of [...byPath.keys()].sort()) for (const above of ancestors(path)) if (above !== path) {
    const bucket = descendants.get(above);
    if (!bucket) descendants.set(above, [path]); else if (bucket.length <= PREFIX_LOOKUP_MAX) bucket.push(path);
  }
  let bytes = 0, complete = true;
  const paths = new Set<string>(), boundedRejects: FolderTrustReject[] = [];
  for (const reject of rejects) {
    let fits = true;
    for (const path of new Set([reject.key, reject.folder])) {
      if (paths.has(path)) continue;
      const cost = Buffer.byteLength(JSON.stringify(path), 'utf8') + 1;
      if (isUnrecordableTrustRoot(path) || /[\u0000-\u001f\u007f\p{Cs}]/u.test(path) || Buffer.byteLength(path, 'utf8') > 4096
        || paths.size >= 1024 || bytes + cost > 256 * 1024) { complete = false; fits = false; continue; }
      paths.add(path); bytes += cost;
    }
    if (fits && complete) boundedRejects.push(reject);
  }
  const boundedTrusts: string[] = [];
  if (complete) for (const key of trusts) {
    const cost = Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
    if (boundedTrusts.length >= 1024 || bytes + cost > 256 * 1024 || Buffer.byteLength(key, 'utf8') > 4096) continue;
    boundedTrusts.push(key); bytes += cost;
  }
  const snapshot: FolderTrustIndex = {
    lookup: key => {
      const record = byKey.get(key);
      if (!record) return NONE;
      return Object.freeze({ decision: record.decision, consent: record.consent === 2 ? 2 as const : null, picked: record.source === 'picker', reject: record.decision === 'reject' ? Object.freeze({ key, folder: record.folder }) : null });
    },
    prefixLookup: root => {
      const bucket = descendants.get(trustPath(root)) ?? [];
      return bucket.length > PREFIX_LOOKUP_MAX ? { declines: bucket.slice(0, PREFIX_LOOKUP_MAX), truncated: true } : { declines: bucket, truncated: false };
    },
    declineCoverage: () => !readable ? 'unknown' : complete ? 'complete' : 'incomplete',
    revision: fingerprint, fingerprint, rejectCount: rejects.length, seedComplete: complete,
    seed: Object.freeze({ trustKeys: Object.freeze(complete ? boundedTrusts : []), rejects: Object.freeze(complete ? boundedRejects : []) }),
    hasDescendantDecline: key => descendants.has(trustPath(key)),
    trusts: key => trusts.has(key), picked: key => picks.has(key),
    rejectFor(key, cwd) {
      const exact = byPath.get(trustPath(key));
      if (exact) return exact;
      for (const candidate of ancestors(cwd)) {
        if (candidate !== key && pathStartsWith(key, candidate)) continue;
        const reject = byPath.get(candidate);
        if (reject) return reject;
      }
      return null;
    },
    declines(key, above = false) {
      const k = trustPath(key), seen = new Set<string>(), result: string[] = [];
      for (const reject of rejects) for (const raw of [reject.key, reject.folder]) {
        const path = trustPath(raw);
        if (path !== k && !isUnrecordableTrustRoot(path) && (above ? pathStartsWith(k, path) : pathStartsWith(path, k))) {
          if (!seen.has(path)) { seen.add(path); result.push(raw); } break;
        }
      }
      return above ? result.sort((a, b) => b.split(/[\\/]+/).length - a.split(/[\\/]+/).length) : result;
    },
  };
  return Object.freeze(snapshot);
}
