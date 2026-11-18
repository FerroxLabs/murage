// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
import { describe, expect, it } from 'vitest';
import { autoVerdict, type AutoContext } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';

// MAIN 2026-11-12 supersedes permission holds below; protected reader observations remain.
// G-NL SYMLINK RULING (MAIN 2026-11-11 10:45Z): LINK writes and writes through
// links differ. All filesystem observations below are inert, exact-path fakes.
const noLimits = { autoApprove: true, fullAccess: true, noLimits: true };
const owner: AutoContext = { fullAccessOrigin: 'owner', ownerStarted: true, commandCwd: '/w', outsideRead: null };
const verdict = (command: string, context: AutoContext = owner) =>
  autoVerdict(noLimits, 'Bash', command, { ...context, commandText: command });

describe('No limits symbolic links', () => {
  it.each(['ln -s /usr/bin/x ./y', 'ln -sf /etc/hosts ./hosts', 'ln -s /etc ./etc-link'])('only the local link is written: %s', command => {
    expect(verdict(command).approve).toBeTruthy();
  });
  it.each(['ln -s ./a /usr/y', 'ln -s -t /usr/bin ./x', 'ln -sf /tmp/blob /etc/x', 'ln /usr/bin/x ./y'])('protected links and hard links stay denied: %s', command => {
    expect(verdict(command)).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
  });
  it.each(['ln -sf /etc/hosts ./h && echo x > ./h', 'ln -sf /etc/hosts ./h; tee ./h', 'ln -s /etc ./etc-link; tee ./etc-link/new-file'])('same-command write through a link stays denied: %s', command => {
    expect(noLimitsProtectedWrite(command, owner)).toMatchObject({ rule: 'protected-path' });
    expect(verdict(command)).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
  });
  it.each(['echo x > ./h', 'tee ./etc-link/new-file'])('a later command resolves its exact write destination: %s', command => {
    const probes: string[] = [];
    const context: AutoContext = { ...owner, unseen: { platform: 'posix', fs: {
      realpath(path) {
        probes.push(path);
        if (path === '/w/h') return '/etc/hosts';
        if (path === '/w/etc-link') return '/etc';
        if (path === '/w/etc-link/new-file') throw Object.assign(new Error('not created'), { code: 'ENOENT' });
        return path;
      },
      stat: () => ({ isFile: () => true, isDirectory: () => false }),
    } } };
    expect(noLimitsProtectedWrite(command, context)).toMatchObject({ rule: 'protected-path' });
    expect(verdict(command, context)).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.length).toBeLessThan(64);
  });
  it('an existing ordinary link stays runnable, without enumerating any history', () => {
    const context: AutoContext = { ...owner, unseen: { fs: {
      realpath: path => path === '/w/h' ? '/w/notes' : path,
      stat: () => ({ isFile: () => true, isDirectory: () => false }),
    } } };
    expect(noLimitsProtectedWrite('echo x > ./h', context)).toBeNull();
    expect(verdict('echo x > ./h', context).approve).toBeTruthy();
  });
});
