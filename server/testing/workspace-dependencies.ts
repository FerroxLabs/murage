// Root suites import the control-plane workspace. Normal pnpm installs link its
// dependencies there; flattened, read-only test stores retain the virtual store
// but omit workspace links. Restore only missing links to the pinned packages.
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vite rewrites new URL(relative, import.meta.url) as a browser asset in DOM suites.
export function prepareWorkspaceTestDependencies(root = join(dirname(fileURLToPath(import.meta.url)), '../..')) {
  const workspace = join(root, 'cloudflare/control-plane');
  const virtual = join(root, 'node_modules/.pnpm/node_modules');
  if (!existsSync(virtual)) return; // A regular install owns its own workspace setup.
  const { dependencies } = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(dependencies)) {
    const target = join(workspace, 'node_modules', name);
    if (existsSync(target)) continue;
    const direct = join(root, 'node_modules', name);
    const source = existsSync(direct) ? direct : join(virtual, name);
    const installed = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    if (installed.version !== version) throw new Error(`Workspace test dependency ${name} must match its pinned version`);
    mkdirSync(dirname(target), { recursive: true });
    try { symlinkSync(realpathSync(source), target, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !existsSync(target)) throw error; }
  }
}
