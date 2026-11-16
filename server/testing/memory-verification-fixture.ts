// SPDX-License-Identifier: AGPL-3.0-or-later
// Verification fixture consumer owners: c4-misc-a and recall-fix-a. Native meter producer owner: c3-memory.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../../scripts/control-murage.ts';
import { forgetExclusionAddon } from '../engine-exclusion.ts';
import { ioMeterSqlDeadline, ioMeterNativePath, resetIoMeterForTest } from '../io-meter.ts';
import { prepareMemoryMeterFixture } from '../memory/testing/native-meter-fixture.ts';
import { removeTempDir } from './cleanup.ts';

let directory: string | undefined, meter: string | undefined;
const fixtures = new Set<VerificationServer>();
/** Start an immediate-work fixture outside the real admission window's
 * closing guard, as memory unit fixtures and accepted owner turns do. */
export async function waitForMemoryFixtureWindow(): Promise<void> {
  const remaining = 60_000 - Date.now() % 60_000;
  if (remaining <= 10_000) await new Promise<void>(resolve => setTimeout(resolve, remaining + 1));
}
export function memoryVerificationMeter(): string {
  if (meter) return meter;
  const existing = ioMeterNativePath();
  if (existing && ioMeterSqlDeadline()) return meter = existing;
  const previous = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
  try {
    // The normal suite pins its lock stand-in. Prefer a built real resource
    // when one is available, including Windows CI's native build.
    delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;
    forgetExclusionAddon(); resetIoMeterForTest();
    const built = ioMeterNativePath();
    if (built && ioMeterSqlDeadline()) return meter = built;
    directory = mkdtempSync(join(tmpdir(), 'memory-verification-'));
    prepareMemoryMeterFixture(directory);
    meter = ioMeterNativePath();
    if (!meter) throw new Error('fixture native meter was not prepared');
    return meter;
  } finally {
    if (previous === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;
    else process.env.MURAGE_ENGINE_EXCLUSION_PATH = previous;
    forgetExclusionAddon(); resetIoMeterForTest();
  }
}

/** The lock-only stand-in cannot admit checked background lineage writers.
 * Keep the real VFS, native grants, timeouts and policy in this owned child.
 */
export async function launchMemoryVerificationServer(...args: Parameters<typeof launchVerificationServer>): Promise<VerificationServer> {
  const [env, signal, options] = args;
  const fixture = await launchVerificationServer(env, signal, { ...options, env: {
    NODE_ENV: 'test', MURAGE_ENGINE_EXCLUSION_PATH: memoryVerificationMeter(), ...options?.env,
  } });
  fixtures.add(fixture);
  return fixture;
}

afterAll(async () => {
  try {
    const outcomes = await Promise.allSettled([...fixtures].map(fixture => fixture.close()));
    const failed = outcomes.filter(outcome => outcome.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(outcome => outcome.reason), 'verification fixture cleanup failed');
  } finally { if (directory) await removeTempDir(directory); }
});
