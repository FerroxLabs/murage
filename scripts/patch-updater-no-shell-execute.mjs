// electron-updater 6.8.9: r3.1 §2 forbids ShellExecute for installers. Apply
// the reviewed vendor diff after the other bundle patches, on every rebuild.
// Exact, unique context matching fails closed if upstream changes these sites.
import { readFileSync } from 'node:fs';
const patch = readFileSync(new URL('../electron/vendor/patches/electron-updater-no-shell-execute.patch', import.meta.url), 'utf8');
export function patchUpdaterNoShellExecute(source) {
  for (const hunk of patch.split(/^@@[^\n]*\n/gm).slice(1)) {
    const lines = hunk.trimEnd().split('\n');
    const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n');
    const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n');
    if (source.split(before).length !== 2) throw new Error('Updater installer launch changed; review electron-updater-no-shell-execute.patch');
    source = source.replace(before, after);
  }
  return source;
}
