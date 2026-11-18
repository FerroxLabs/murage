// A desktop consumer reads only this installation's bounded root record, never an old data folder.
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { lexicalKey } from '../shared/stored-root-path.mjs';
export function recordedPreviousDataRoots(dataDir, platform = process.platform) {
  try {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const file = p.join(dataDir, '.murage-root.json'), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return [];
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record?.schema !== 1 || lexicalKey(record.root, platform) !== lexicalKey(dataDir, platform) || !Array.isArray(record.previous)) return [];
    return record.previous.slice(0, 4).flatMap(entry => typeof entry?.root === 'string' && lexicalKey(entry.root, platform) && entry.root !== p.parse(entry.root).root ? [entry.root] : []);
  } catch { return []; }
}
