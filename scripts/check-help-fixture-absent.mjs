#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export function checkHelpFixtureAbsent(dist = 'dist', release = '.github/workflows/release.yml', args = process.argv.slice(2)) {
  if (args.some(arg => arg === '--mode' || arg.startsWith('--mode=')) || /--mode(?:[=\s]|$)/m.test(readFileSync(release, 'utf8'))) {
    throw Error('Release must not pass --mode');
  }
  let files = 0, decodedBytes = 0;
  const maxAssetBytes = 32 * 1024 * 1024;
  function scan(dir) {
    const directory = lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error(`Package directory is not regular: ${dir}`);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Package asset is not a regular file: ${path}`);
        if (stat.size > maxAssetBytes) throw Error(`Package asset exceeds scan bound: ${path}`);
        files++;
        let bytes = readFileSync(path);
        if (path.endsWith('.br')) bytes = brotliDecompressSync(bytes, { maxOutputLength: maxAssetBytes });
        else if (path.endsWith('.gz')) bytes = gunzipSync(bytes, { maxOutputLength: maxAssetBytes });
        decodedBytes += bytes.length;
        if (decodedBytes > 512 * 1024 * 1024) throw Error('Package assets exceed scan bound');
        const text = bytes.toString('utf8');
        if (text.includes('HELP_ASK_FIXTURE_ONLY') || text.includes('__helpAskFixture')) throw Error(`Help fixture in shipped asset: ${path}`);
      }
    }
  }
  scan(dist);
  if (!files) throw Error('Empty dist cannot prove fixture absence');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) checkHelpFixtureAbsent();
