import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ pin: vi.fn(), spawn: vi.fn(), json: vi.fn() }));
vi.mock('./signal-inventory.mjs', () => ({
  assertReleasePin: doubles.pin, json: doubles.json, PIN_PATH: 'committed-pin.json', ROOT: '/candidate-checkout',
}));
vi.mock('node:child_process', () => ({ spawnSync: doubles.spawn }));
import { assertSignalReleaseReady } from './signal-release-prerequisites.mjs';

const gates = readFileSync(new URL('../ci/gate-post-g0.txt', import.meta.url), 'utf8')
  .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
let reportPath;
const report = () => ({ success: true, testResults: gates.map(([file, name]) => ({
  name: `/candidate-checkout/${file}`, assertionResults: [{ fullName: name, status: 'passed' }],
})) });
function runner(mutate = () => {}, result = { status: 0 }) {
  doubles.spawn.mockImplementation((_command, args) => {
    reportPath = args.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
    const value = report(); mutate(value);
    writeFileSync(reportPath, JSON.stringify(value));
    return result;
  });
}
beforeEach(() => {
  vi.resetAllMocks(); reportPath = undefined;
  doubles.json.mockReturnValue({ g0: { fixture: true } });
  runner();
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (reportPath) expect(existsSync(dirname(reportPath))).toBe(false);
});

it('validates the current pin before running exactly the named gates with RELEASE forced on', () => {
  vi.stubEnv('RELEASE', '0'); vi.stubEnv('SKIP_SIGNAL_G0', '1');
  expect(assertSignalReleaseReady()).toBe('5 passed / 0 failed / 0 skipped (selected gates)');
  expect(doubles.json).toHaveBeenCalledWith('committed-pin.json');
  expect(doubles.pin).toHaveBeenCalledWith({ g0: { fixture: true } });
  expect(doubles.pin.mock.invocationCallOrder[0]).toBeLessThan(doubles.spawn.mock.invocationCallOrder[0]);
  const [command, args, options] = doubles.spawn.mock.calls[0];
  expect(command).toBe(process.execPath);
  expect(options.env.RELEASE).toBe('1');
  expect(options.cwd).toBe('/candidate-checkout');
  expect(options.stdio).toEqual(['ignore', 2, 2]);
  const selected = new RegExp(args[args.indexOf('--testNamePattern') + 1]);
  for (const [file, name] of gates) { expect(args).toContain(file); expect(selected.test(name)).toBe(true); }
  expect(selected.test('unrelated')).toBe(false);
});

it('propagates pin refusal before spawning tests', () => {
  doubles.pin.mockImplementation(() => { throw new Error('G0_REQUIRED'); });
  expect(assertSignalReleaseReady).toThrow(/G0_REQUIRED/);
  expect(doubles.spawn).not.toHaveBeenCalled();
});

it.each(gates.flatMap(([file, name], index) => ['missing', 'pending', 'skipped', 'todo', 'disabled'].map(status => [file, name, index, status])))(
  'refuses %s / %s when gate %i is %s despite a zero process exit', (_file, _name, index, status) => {
    runner(value => {
      if (status === 'missing') value.testResults.splice(index, 1);
      else value.testResults[index].assertionResults[0].status = status;
    });
    expect(assertSignalReleaseReady).toThrow(/Required gate did not pass exactly once/);
  },
);

it.each([{ status: 1 }, { status: null }, { status: 0, error: new Error('spawn failed') }])(
  'refuses an unsuccessful process even if it wrote passing results: %j', result => {
    runner(() => {}, result);
    expect(assertSignalReleaseReady).toThrow(/did not complete successfully/);
  },
);
it('refuses a zero-exit runner that produces no report', () => {
  doubles.spawn.mockReturnValue({ status: 0 });
  expect(assertSignalReleaseReady).toThrow();
});
it('reruns the check on every invocation instead of trusting an earlier pass', () => {
  assertSignalReleaseReady();
  runner(value => { value.testResults[0].assertionResults[0].status = 'skipped'; });
  expect(assertSignalReleaseReady).toThrow(/Required gate/);
  expect(doubles.pin).toHaveBeenCalledTimes(2);
  expect(doubles.spawn).toHaveBeenCalledTimes(2);
});


it('skips Signal qualification only for an explicit null G0 pin', () => {
  doubles.json.mockReturnValue({ g0: null });
  expect(assertSignalReleaseReady()).toMatch(/Signal omitted.*g0.*null/i);
  expect(doubles.pin).not.toHaveBeenCalled();
  expect(doubles.spawn).not.toHaveBeenCalled();
});
it('still refuses a non-null G0 pin when all post-G0 gates are missing', () => {
  runner(value => { value.testResults = []; });
  expect(assertSignalReleaseReady).toThrow(/Required gate/);
  expect(doubles.pin).toHaveBeenCalledOnce();
  expect(doubles.spawn).toHaveBeenCalledOnce();
});

it.each([undefined, false, 0, ''])('does not treat malformed non-null G0 %j as an omission', g0 => {
  doubles.json.mockReturnValue({ g0 });
  doubles.pin.mockImplementation(() => { throw new Error('G0_REQUIRED'); });
  expect(assertSignalReleaseReady).toThrow(/G0_REQUIRED/);
  expect(doubles.pin).toHaveBeenCalledOnce();
  expect(doubles.spawn).not.toHaveBeenCalled();
});

// Exercise the registration expressions used by the five real CI cases. This
// catches unconditional registration without running live Signal or an engine.
it.each([null, {}, undefined, false, 0, ''])('CI omits exactly the five live prerequisites only for explicit null G0: %j', g0 => {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [file, name] of gates) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const registration = source.match(new RegExp(`^((?:it|test)(?:\\.runIf\\([^\\n]+\\))?)\\("${escape(name)}",`, 'm'));
    expect(registration, `${file}: ${name}`).toBeTruthy();
    const calls = [];
    const register = () => calls.push('run');
    register.runIf = enabled => () => calls.push(enabled ? 'run' : 'omit');
    new Function('it', 'test', 'signalPin', `${registration[1]}()`) (register, register, { g0 });
    expect(calls, `${file}: ${name}`).toEqual([g0 === null ? 'omit' : 'run']);
  }
});
