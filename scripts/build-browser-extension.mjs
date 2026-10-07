// SPDX-License-Identifier: AGPL-3.0-or-later
import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = `${root}extensions/murage-browser`;

/** Build the unpacked extension. `_locales` must travel with the manifest: its default_locale and __MSG_ names point there,
 * and Chrome will not load an extension whose strings are missing. */
export async function buildBrowserExtension({ output = `${root}dist-browser-extension`, quiet = false } = {}) {
  await mkdir(output, { recursive: true });
  await build({ entryPoints: [`${source}/service-worker.mjs`], outfile: `${output}/service-worker.js`, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', logLevel: quiet ? 'silent' : 'warning' });
  await cp(`${source}/manifest.json`, `${output}/manifest.json`);
  await cp(`${source}/icons`, `${output}/icons`, { recursive: true });
  await cp(`${source}/sidepanel`, `${output}/sidepanel`, { recursive: true });
  await cp(`${source}/_locales`, `${output}/_locales`, { recursive: true });
  if (!quiet) console.log(`Browser extension built: ${output}`);
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildBrowserExtension();
