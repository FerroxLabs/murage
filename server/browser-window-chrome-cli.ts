/** Maintainer-only resolver harness. It runs before server startup, never
 * launches Chrome, and a test qualification file is scoped to this invocation. */
import { readFileSync } from 'node:fs';
import { createWindowChromeResolver, windowChromeCause, type WindowChromeResult } from './browser-window-chrome.ts';
import { validateWindowChromeList } from './browser-window-validated.ts';
export async function windowChromeCheck(args: string[], dependencies: {
  env?: NodeJS.ProcessEnv;
  factory?: typeof createWindowChromeResolver;
  readList?: (file: string) => string;
} = {}): Promise<WindowChromeResult> {
  const env = dependencies.env ?? process.env;
  if (env.MURAGE_CLOUD_ROLE === 'home') return windowChromeCause('cloud_home');
  let prepare = false, download = false, list: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; if (seen.has(arg)) throw new Error('Duplicate Chrome check option'); seen.add(arg);
    if (arg === '--window-chrome-check') continue;
    if (arg === '--prepare') prepare = true;
    else if (arg === '--download') download = true;
    else if (arg === '--validated') { list = args[++i]; if (!list || list.startsWith('--')) throw new Error('Expected a qualification file'); }
    else throw new Error('Unknown Chrome check option');
  }
  const validated = list ? validateWindowChromeList(JSON.parse((dependencies.readList ?? (file => readFileSync(file, 'utf8')))(list))) : undefined;
  const resolver = (dependencies.factory ?? createWindowChromeResolver)({ env, validated });
  return download ? resolver.download({ ownerRequested: true, onProgress() {} }) : resolver.resolve({ mode: prepare ? 'prepare' : 'local' });
}
if (process.argv.includes('--window-chrome-check')) {
  try { console.log(JSON.stringify(await windowChromeCheck(process.argv.slice(2)))); process.exit(0); }
  catch { console.log(JSON.stringify(windowChromeCause('unverified'))); process.exit(1); }
}
