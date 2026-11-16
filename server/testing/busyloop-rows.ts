import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const fixtureRoot = new URL('../__fixtures__/flux-refusals/prod-00000000/', import.meta.url);
export const specRoot = new URL('../__fixtures__/flux-refusals/spec/', import.meta.url);
export const frozenNow = Date.parse('2026-11-10T20:07:21Z');
export const tsv = readFileSync(new URL('busyloop_expected.tsv', specRoot));
export const tsvSha = createHash('sha256').update(tsv).digest('hex');
const [header, ...lines] = tsv.toString().trimEnd().split('\n');
export const rows = lines.map(line => Object.fromEntries(header.split('\t').map((key, i) => [key, line.split('\t')[i]])));
const endpoints: Record<string, string> = { '/v1/chat/completions': 'chat', '/v1/responses': 'resp', '/v1/messages': 'msg' };
export type Leaf = { status: number; headers?: Record<string, string>; body?: unknown };
export const leaves = new Map<string, Leaf>();
for (const [sub, pattern] of [['', /^[0-9].*\.json$/], ['siblings/', /^D.*\.json$/], ['target-654/', /\.json$/]] as const) {
  const dir = new URL(sub, fixtureRoot);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter(f => pattern.test(f) && f !== 'PROVENANCE.json')) {
    const j = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    if (j.not_reachable_in_prod) continue;
    const stem = (sub === 'target-654/' ? 't654:' : '') + file.split('-')[0] + '.';
    if ('body' in j || 'headers' in j) leaves.set(stem + endpoints[j.endpoint], j);
    const walk = (o: Record<string, unknown>, pre: string) => {
      for (const [k, v] of Object.entries(o)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        if ('status' in v && ('body' in v || 'headers' in v)) leaves.set(stem + pre + (endpoints[k] ?? k), v as Leaf);
        else walk(v as Record<string, unknown>, pre + k.replace('_variant', '') + '/');
      }
    };
    walk(j.per_endpoint ?? {}, '');
  }
}
export function input(row: Record<string, string>): Leaf {
  if (row.status === 'fixture') {
    const leaf = leaves.get(row.id);
    if (!leaf) throw new Error('ROW WITHOUT LEAF ' + row.id);
    return leaf;
  }
  return { status: Number(row.status), headers: JSON.parse(row.headers), body: JSON.parse(row.body) };
}
