// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const SIGNAL_FIXTURE_SOURCE = 'server/channels/signal/fixtures/g0';
export const SIGNAL_RUNTIME_RESOURCE = 'signal-runtime';
export const SIGNAL_RUNTIME_G0 = 'g0';
export function signalRuntimeDir({ resourcesPath, moduleUrl, platform = process.platform, arch = process.arch }) {
  if (resourcesPath) return join(resourcesPath, SIGNAL_RUNTIME_RESOURCE);
  const root = resolve(dirname(fileURLToPath(moduleUrl)), '..');
  return moduleUrl.endsWith('.js') ? join(root, SIGNAL_RUNTIME_RESOURCE)
    : join(root, 'dist-native', SIGNAL_RUNTIME_RESOURCE, `${platform}-${arch}`);
}
export function signalFixtureDir(runtimeDir) { return join(runtimeDir, SIGNAL_RUNTIME_G0); }
