// Pi loads these files itself, so keep its package imports external and ship
// the installer at the relative path used by the staged extensions.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function stagePiWindowsHide(root, output = join(root, 'dist-server')) {
  mkdirSync(join(output, 'drivers'), { recursive: true });
  mkdirSync(join(output, 'shared'), { recursive: true });
  for (const name of ['win-hide-child-process.mjs', 'win-hide-child-process.cjs'])
    copyFileSync(join(root, 'shared', name), join(output, 'shared', name));
  for (const name of ['pi-mcp-extension.ts', 'pi-permission-gate.ts']) {
    let source = readFileSync(join(root, 'server/drivers', name), 'utf8');
    const first = 'import "../../shared/win-hide-child-process.mjs";';
    // The portable permission gate is node-only. The packaged wrapper owns
    // its Windows preload, just as spawnCli owns the development preload.
    if (name === 'pi-permission-gate.ts') source = first + '\n' + source;
    if (!source.startsWith(first)) throw new Error(`${name}: missing first Windows installer import`);
    writeFileSync(join(output, 'drivers', name), source.replaceAll('"../../shared/win-hide-child-process.mjs"', '"../shared/win-hide-child-process.mjs"'));
  }
}
