// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { watchProofWorker } from './browser-extension-proof-worker.mjs';

describe('Round 2: proof worker close attribution', () => {
  it.each([false, true])('records teardown separately and reconnects only during the run: %s', teardown => {
    const worker = new EventEmitter(), record = vi.fn(), reconnect = vi.fn();
    let closing = false;
    watchProofWorker(worker, { closing: () => closing, step: () => 'click', record, reconnect });
    closing = teardown;
    worker.emit('close');
    expect(record).toHaveBeenCalledWith({ at: expect.any(Number), step: 'click', phase: teardown ? 'teardown' : 'running' });
    expect(reconnect).toHaveBeenCalledTimes(teardown ? 0 : 1);
  });
});
