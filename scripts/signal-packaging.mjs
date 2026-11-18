// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bindLinuxActions from './linux-desktop-actions.mjs';
import { SIGNAL_RUNTIME_RESOURCE } from '../server/channels/signal/runtime-paths.mjs';

const readPin = () => JSON.parse(readFileSync(new URL('../server/channels/signal/runtime-pin.json', import.meta.url), 'utf8'));
export function signalRuntimeEnabled(pin = readPin()) {
  if (pin?.g0 === undefined) throw new Error('Signal pin.g0 is required; only explicit null omits the runtime');
  return pin.g0 !== null;
}
function signalResource(row) {
  const paths = typeof row === 'string' ? [row] : [row?.from, row?.to];
  return paths.some(value => typeof value === 'string'
    && value.replaceAll('\\', '/').toLowerCase().split('/').includes(SIGNAL_RUNTIME_RESOURCE));
}

/** beforePack runs before electron-builder computes its resource matchers.
 * Remove all Signal copies, including individual Windows EXEs and licences,
 * so even stale staged bytes cannot enter a null-G0 package. */
export function configureSignalPackaging(context, pin) {
  if (!context.packager || signalRuntimeEnabled(pin)) return;
  const config = context.packager.config ?? {};
  for (const scope of [config, config.mac, config.win, config.linux, context.packager.platformSpecificBuildOptions]) {
    for (const key of ['extraResources', 'extraFiles']) {
      if (Array.isArray(scope?.[key])) scope[key] = scope[key].filter(row => !signalResource(row));
    }
  }
}

/** Read only, without following links: fail on any accidentally bundled tree. */
export function assertNoSignalRuntime(resources) {
  const info = lstatSync(resources);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Signal package resources must be a real directory: ${resources}`);
  const scan = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name.toLowerCase() === SIGNAL_RUNTIME_RESOURCE) throw new Error(`Signal pin.g0 is null but package contains signal-runtime: ${path}`);
      if (entry.isDirectory()) scan(path);
    }
  };
  scan(resources);
  return `Signal omitted (pin.g0 is null): no signal-runtime directory in ${resources}`;
}
export function assertSignalPackaging(resources, pin) {
  if (!signalRuntimeEnabled(pin)) return assertNoSignalRuntime(resources);
}
export default function beforePack(context) {
  configureSignalPackaging(context);
  bindLinuxActions(context);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...resources] = process.argv.slice(2);
    if (command !== '--assert-absent' || resources.length === 0) throw new Error('usage: signal-packaging.mjs --assert-absent <packaged-resources> [...]');
    if (signalRuntimeEnabled()) throw new Error('Signal absence assertion requires pin.g0 to be null');
    for (const directory of resources) console.log(assertNoSignalRuntime(resolve(directory)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
