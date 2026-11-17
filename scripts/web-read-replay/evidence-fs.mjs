import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
function safe(path) {
  const full = resolve(path);
  if (full === '/dev' || full.startsWith('/dev/')) throw Error('Evidence must be outside /dev');
  return full;
}
export function evidenceDir(path) {
  const full = safe(path);
  const first = mkdirSync(full, { recursive: true, mode: 0o755 });
  // Only directories made by this call, plus its explicit destination.
  // Existing ancestors may be private fixture homes and must stay private.
  let current = full;
  for (;;) {
    chmodSync(current, 0o755);
    if (!first || current === first) break;
    current = dirname(current);
  }
  return full;
}
export function writeEvidence(path, data) {
  const full = safe(path); evidenceDir(dirname(full));
  writeFileSync(full, data); chmodSync(full, 0o644);
}
