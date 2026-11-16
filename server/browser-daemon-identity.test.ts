import { expect, it } from 'vitest';
import { captureDaemonIdentity, judgeDaemonIdentity, validDaemonIdentity, validCloseTarget } from './browser-daemon-identity.ts';
const identity = { pid: 123, start: '100', bootId: 'boot-a' };
const reads = { alive: () => true, boot: () => 'boot-a', start: () => '100' };
it('T25/M63s ESRCH, another boot or another start is gone; unreadable evidence is unknown', async () => {
  expect(await judgeDaemonIdentity(identity, '/engine', reads)).toBe('alive');
  expect(await judgeDaemonIdentity(identity, '/engine', { ...reads, alive: () => false })).toBe('gone');
  expect(await judgeDaemonIdentity(identity, '/engine', { ...reads, boot: () => 'boot-b' })).toBe('gone');
  expect(await judgeDaemonIdentity(identity, '/engine', { ...reads, start: () => '101' })).toBe('gone');
  for (const field of ['alive', 'boot', 'start']) expect(await judgeDaemonIdentity(identity, '/engine', { ...reads, [field]: () => undefined })).toBe('unknown');
  expect(await judgeDaemonIdentity(undefined, '/engine', reads)).toBe('unknown');
  expect(await judgeDaemonIdentity({ ...identity, pid: 0 }, '/engine', reads)).toBe('unknown');
});
it('T25 identity and close-target validators reject malformed persisted fields', () => {
  expect(validDaemonIdentity(identity)).toBe(true);
  for (const invalid of [null, {}, { ...identity, pid: 1.5 }, { ...identity, start: '' }, { ...identity, bootId: [] }]) expect(validDaemonIdentity(invalid)).toBe(false);
  const target = { botId: 'bot', command: '/engine', socketDir: '/runtime', session: 'session-1' };
  expect(validCloseTarget(target)).toBe(true);
  for (const invalid of [{ ...target, session: '../foreign' }, { ...target, command: '' }, { ...target, botId: null }, { ...target, socketDir: [] }]) expect(validCloseTarget(invalid)).toBe(false);
});
it('T25 captures and judges a real Linux fixture process without signalling it', async () => {
  const captured = await captureDaemonIdentity(process.pid, process.execPath);
  expect(captured).toMatchObject({ pid: process.pid });
  expect(await judgeDaemonIdentity(captured, process.execPath)).toBe('alive');
});
