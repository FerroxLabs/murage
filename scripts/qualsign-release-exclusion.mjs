// Exclusion producer: winsac-qualsign; release entry consumer: release-guard / MAIN.
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export function refuseQualificationAssets(dir) {
  const refuse = reason => { throw Error(`qualsign-not-release-v1: ${reason}`); };
  const denylist = new URL('../infra/windows-signing/qualsign/refused-sha256.txt', import.meta.url);
  if (lstatSync(denylist).isSymbolicLink()) refuse('digest denylist link');
  const pins = readFileSync(denylist, 'utf8')
    .split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
  if (pins.some(pin => !/^[0-9a-f]{64}$/.test(pin))) refuse('invalid digest denylist');
  const refused = new Set(pins);
  const root = resolve(dir);
  function walk(path) {
    if (path.split(sep).some(part => /^qualsign-(?:collector|signed)-/i.test(part))) refuse('qualification artifact path');
    const name = basename(path).toLowerCase();
    if (name === 'witness-collector.exe' || name === 'qualsign-receipt.json') refuse('qualification asset name');
    const info = lstatSync(path);
    if (info.isSymbolicLink()) refuse('WINDOWS_PE_FILE_UNSAFE');
    if (info.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
    if (!info.isFile()) refuse('asset type');
    const bytes = readFileSync(path);
    if (refused.has(createHash('sha256').update(bytes).digest('hex'))) refuse('qualification digest');
    if (name.endsWith('.json')) {
      let data;
      try { data = JSON.parse(bytes); } catch { refuse('invalid asset JSON'); }
      if (typeof data?.schema === 'string' && data.schema.toLowerCase() === 'qualsign-collector-v1') refuse('qualification receipt schema');
    }
  }
  // Inspect the lexical path as well as the resolved directory's artifact segments.
  if (realpathSync(root) !== root) refuse('WINDOWS_PE_FILE_UNSAFE');
  walk(root);
}
