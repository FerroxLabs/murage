// SPDX-License-Identifier: AGPL-3.0-or-later
// Proof lifecycle bookkeeping, separate from the extension's reconnect policy.
export function watchProofWorker(worker, { closing, step, record, reconnect }) {
  worker.on('close', () => {
    const teardown = closing();
    record({ at: Date.now(), step: step(), phase: teardown ? 'teardown' : 'running' });
    if (!teardown) void reconnect();
  });
}
