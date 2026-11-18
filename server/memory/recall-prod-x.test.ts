// Copy-admission producer owner: scperf-p1; WAL consumer owner: recall-prod-x; integration owner: MAIN.
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { checkpointLedger } from '../admission-shared.ts';
import { ioBudget } from '../io-budget.ts';
import { assertWalWriteAdmission, WAL_ADMISSION_BYTES } from '../wal-maintenance.ts';

afterEach(() => { vi.restoreAllMocks(); ioBudget.setIsIdle(() => false); });

for (const idle of [false, true]) it(`publishes the current idle=${idle} verdict after the copy worker rotates its minute`, () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const file=join(DATA_DIR,'copy-admission.db');writeFileSync(file+'-wal','');
  ioBudget.setIsIdle(() => idle);
  const ledger=checkpointLedger(ioBudget.checkpointAdmissionBuffer());
  const now=(1_000_000+Number(idle))*60_000+1000;
  vi.spyOn(Date,'now').mockReturnValue(now);
  // Rotation keeps the owner's last verdict (admission-minute-boundary T-MIN-ACTIVE). The conservative idle mark that the
  // foreground must replace is the one a missed owner reading leaves (io-budget fail-closed), stored here by hand.
  ledger.lock();try { ledger.rotate(now); expect(Atomics.load(ledger.slots,7)).toBe(idle?1n:0n); Atomics.store(ledger.slots,7,1n); } finally { ledger.unlock(); }
  expect(Atomics.load(ledger.slots,7)).toBe(1n);
  assertWalWriteAdmission(file);
  expect(Atomics.load(ledger.slots,7)).toBe(idle?1n:0n);
  const ticket=ledger.beginCopy(2*1024*1024,now);
  if(idle)expect(ticket).toBeNull();
  else { expect(ticket).not.toBeNull(); if(ticket)ledger.endCopy(ticket,0); }
});

it('keeps the retained WAL fence at 512 MiB without copied credit', () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const file=join(DATA_DIR,'copy-fence.db');writeFileSync(file+'-wal','');
  expect(WAL_ADMISSION_BYTES).toBe(512*1024*1024);
  truncateSync(file+'-wal',WAL_ADMISSION_BYTES);
  expect(() => assertWalWriteAdmission(file)).toThrow('Busy for a moment');
});
