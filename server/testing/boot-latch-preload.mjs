// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance W10 (owner: fix/1019-bootbuild3b-r; consumer: server/boot-latch-listen.test.ts). Loaded into the real server with --import: it
// reports, on stdout, every call the production start makes to the boot-only goal reconcile and to the latch that closes it, in order, so the test
// can tell that the listen path closes the boot recoveries after the boot reconcile ran. It changes no behaviour: each wrapper calls the original.
import { isMainThread } from 'node:worker_threads';
if (isMainThread) {
  const { Store } = await import('../store.ts');
  const reconcile = Store.prototype.reconcileInterruptedGroupGoals, close = Store.prototype.closeBootRecoveries;
  Store.prototype.reconcileInterruptedGroupGoals = function (...args) { const changed = reconcile.apply(this, args); process.stdout.write(`BOOT-LATCH reconcile changed=${changed}\n`); return changed; };
  Store.prototype.closeBootRecoveries = function (...args) { const result = close.apply(this, args); process.stdout.write('BOOT-LATCH closed\n'); return result; };
}
