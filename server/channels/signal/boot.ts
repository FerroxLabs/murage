// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadSignalAdapters } from './adapters.ts';
// @ts-expect-error Shared ESM path contract also runs in release tooling.
import { signalFixtureDir, signalRuntimeDir } from './runtime-paths.mjs';
import type { RuntimePin } from './types.ts';
export function bootSignalRuntime({ pin, ...paths }: {
  pin: RuntimePin; moduleUrl: string; resourcesPath?: string; platform?: string; arch?: string;
}) {
  const runtimeDir: string = signalRuntimeDir(paths);
  const fixtureDir: string = signalFixtureDir(runtimeDir);
  return { runtimeDir, fixtureDir, adapters: loadSignalAdapters(pin, fixtureDir) };
}
