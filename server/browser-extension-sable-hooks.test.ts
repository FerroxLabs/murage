// SPDX-License-Identifier: AGPL-3.0-or-later
// SABLE-B design 5.7 (shared broker hooks): broker.drop(profileId) closes that profile's connection; onHello(profileId) runs once per
// accepted hello, after the profile is registered. Real broker, real native host, isolated socket.
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { removeTempDir } from './testing/cleanup.ts';
import { startBrowserExtensionBroker } from './browser-extension-broker.ts';
import { runNativeHost, readHostConfig, FrameDecoder, encodeFrame } from '../electron/browser-extension-host.mjs';
import { privateTestDirectory } from './testing/private-test-dir.ts';

const SHORT_ROOT = process.platform === 'win32' ? os.tmpdir() : realpathSync('/tmp');
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(onHello?: (profileId: string) => void) {
  const { root: stateRoot, directory: stateDir } = await privateTestDirectory(path.join(SHORT_ROOT, 'bsh-'));
  cleanup.push(() => removeTempDir(stateRoot));
  const seenAtHello: number[] = [];
  const broker = await startBrowserExtensionBroker({ stateDir, onHello: profileId => { seenAtHello.push(broker.profiles().filter(item => item.profileId === profileId).length); onHello?.(profileId); } });
  cleanup.push(() => broker.close());
  const connect = async () => {
    const input = new PassThrough(), output = new PassThrough(); const messages: unknown[] = [];
    const decoder = new FrameDecoder(value => messages.push(value)); output.on('data', chunk => decoder.push(chunk));
    const host = runNativeHost({ input, output, config: readHostConfig(broker.configPath) }); cleanup.push(async () => host.stop());
    input.write(encodeFrame({ version: 1, type: 'hello', profileId: 'profile', browser: 'chromium', extensionVersion: '0.1.0', capabilities: ['ordered_requests_v1'] }));
    await expect.poll(() => broker.profiles().length).toBe(1);
    return { input, output, messages, host };
  };
  return { broker, connect, seenAtHello };
}
const command = { version: 1, type: 'command', id: 'request1', bindingId: 'binding', generation: 1, operation: 'status', params: {} } as const;

describe('SABLE-B 5.7 broker hooks', () => {
  it('onHello runs once per accepted hello, with the profile already online', async () => {
    const hellos: string[] = [];
    const f = await fixture(profileId => hellos.push(profileId));
    await f.connect();
    expect(hellos).toEqual(['profile']);
    expect(f.seenAtHello).toEqual([1]);
  });
  it('a throwing onHello never breaks the connection', async () => {
    const f = await fixture(() => { throw Error('boom'); });
    await f.connect();
    expect(f.broker.profiles().map(item => item.profileId)).toEqual(['profile']);
  });
  it('drop closes that profile: it leaves profiles, a pending request rejects host_lost_uncertain, and an unknown profile is false', async () => {
    const f = await fixture();
    await f.connect();
    expect(f.broker.drop('absent')).toBe(false);
    const pending = f.broker.request('profile', command);
    const assertion = expect(pending).rejects.toThrow('host_lost_uncertain');
    expect(f.broker.drop('profile')).toBe(true);
    await assertion;
    await expect.poll(() => f.broker.profiles().length).toBe(0);
    await expect(f.broker.request('profile', { ...command, id: 'request2' })).rejects.toThrow('host_offline');
  });
  it('after a drop the extension can say hello again, and onHello runs again', async () => {
    const hellos: string[] = [];
    const f = await fixture(profileId => hellos.push(profileId));
    await f.connect();
    f.broker.drop('profile');
    await expect.poll(() => f.broker.profiles().length).toBe(0);
    await f.connect();
    expect(hellos).toEqual(['profile', 'profile']);
  });
});
