// SPDX-License-Identifier: AGPL-3.0-or-later
// F2: the extension finds a restarted Murage within seconds, not minutes (backoff cap 30 s, a blocked reconnect recovers).
import { describe, it, expect, vi } from 'vitest';
import { workerFixture, settle } from './browser-extension-worker-fixture.mjs';
const KEY = 'murageBrowserReconnect', ALARM = 'murage-reconnect', CAP = 30000;
const newClock = () => ({ now: 5_000_000 });
// Wait out the stored retry time, then deliver the reconnect alarm (the path the worker uses once it is suspended).
async function nextAttempt(f, clock) {
  clock.now = Math.max(clock.now, f.stored[KEY].nextRetryAt); await f.api.alarms.onAlarm.fire({ name: ALARM }); await settle();
}
const gap = (f, clock) => f.stored[KEY].nextRetryAt - clock.now;
async function hostLost(f) { await f.ports.at(-1).onMessage.fire({ version: 1, type: 'host.error', error: { code: 'host_lost' } }); }
describe('extension reconnect backoff (F2)', () => {
  it('never schedules a retry further than 30 s away, however long the outage lasts', async () => {
    const clock = newClock(), f = await workerFixture({ clock, random: () => 0.999 });
    f.api.runtime.connectNative.mockImplementation(() => { throw Error('host not running'); });
    await hostLost(f);
    for (let i = 0; i < 14; i++) { expect(gap(f, clock)).toBeLessThanOrEqual(CAP); await nextAttempt(f, clock); }
    expect(f.stored[KEY].attempts).toBe(10); expect(gap(f, clock)).toBeLessThanOrEqual(CAP);
    expect(f.api.alarms.create.mock.calls.at(-1)[1].when - clock.now).toBeLessThanOrEqual(CAP);
  });
  it('still jitters the capped delay so profiles do not retry in lockstep', async () => {
    const delays = [];
    for (const random of [() => 0, () => 0.999]) {
      const clock = newClock(), f = await workerFixture({ clock, random });
      f.api.runtime.connectNative.mockImplementation(() => { throw Error('host not running'); });
      await hostLost(f); for (let i = 0; i < 12; i++) await nextAttempt(f, clock);
      delays.push(gap(f, clock));
    }
    // random() = 0 is the longest delay (the cap itself), 0.999 the shortest (about 80%).
    expect(delays[1]).toBeLessThan(delays[0]); expect(delays[1]).toBeGreaterThanOrEqual(CAP * 0.5); expect(delays[0]).toBeLessThanOrEqual(CAP);
  });
  it('reconnects at the first retry after a long outage once Murage is back', async () => {
    const clock = newClock(), f = await workerFixture({ clock, random: () => 0.5 });
    const real = f.api.runtime.connectNative.getMockImplementation();
    f.api.runtime.connectNative.mockImplementation(() => { throw Error('host not running'); });
    await hostLost(f); for (let i = 0; i < 20; i++) await nextAttempt(f, clock);
    f.api.runtime.connectNative.mockImplementation(real);
    const back = clock.now, before = f.ports.length;
    await nextAttempt(f, clock);
    expect(f.ports).toHaveLength(before + 1); expect(clock.now - back).toBeLessThanOrEqual(CAP);
    expect(f.ports.at(-1).messages[0]).toMatchObject({ type: expect.stringMatching(/hello|connection/) });
  });
  it('a Murage restart on a healthy connection retries within seconds and resets the backoff', async () => {
    const clock = newClock(), f = await workerFixture({ clock, random: () => 0.5 });
    await f.ports[0].onDisconnect.fire();
    expect(gap(f, clock)).toBeLessThanOrEqual(2000);
    await nextAttempt(f, clock); expect(f.ports).toHaveLength(2);
  });
});
describe('blocked reconnects (F2)', () => {
  const failRetryWrites = (f) => {
    const realSet = f.api.storage.local.set;
    f.api.storage.local.set = vi.fn(async value => { if (KEY in value) throw Error('storage unavailable'); return realSet(value); });
    return () => { f.api.storage.local.set = realSet; };
  };
  const fences = f => f.runtime.connection.mock.calls.filter(([value]) => value === false).length;
  it('an unwritable retry deadline refuses the connect but keeps retrying, and reconnects once storage heals', async () => {
    const clock = newClock(), f = await workerFixture({ clock, random: () => 0.5 });
    const heal = failRetryWrites(f);
    await hostLost(f); await settle();
    for (let i = 0; i < 3; i++) { clock.now += CAP; await f.api.alarms.onAlarm.fire({ name: ALARM }); await settle(); }
    expect(f.ports).toHaveLength(1); // fail closed: no host is opened without a recorded deadline
    f.api.alarms.create.mockClear(); clock.now += CAP; await f.api.alarms.onAlarm.fire({ name: ALARM }); await settle();
    expect(f.api.alarms.create).toHaveBeenCalled(); // still scheduled, not blocked for good
    heal();
    clock.now += CAP; await f.api.alarms.onAlarm.fire({ name: ALARM }); await settle();
    expect(f.ports).toHaveLength(2);
    // Nothing is left blocked: the next loss fences once and is retried like any other.
    const before = fences(f);
    await hostLost(f); await settle(); await nextAttempt(f, clock);
    expect(f.ports).toHaveLength(3); expect(fences(f) - before).toBe(1);
  });
  it('a failed durable fence still blocks every reconnect until the worker restarts', async () => {
    const clock = newClock(), f = await workerFixture({ clock, random: () => 0.5 });
    f.runtime.connection.mockRejectedValue(Error('fence failed'));
    await hostLost(f); await settle();
    for (let i = 0; i < 3; i++) { clock.now += CAP * 2; await f.api.alarms.onAlarm.fire({ name: ALARM }); await settle(); }
    expect(f.ports).toHaveLength(1);
  });
});
