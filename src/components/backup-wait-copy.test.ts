import { expect, it } from 'vitest';
import { BACKUP_WAIT_SENTENCES, backupWaitSentence } from '../../shared/backup-capture-failure.mjs';
import en from '../locales/en.json';
import { schedulePhase, scheduleNeedsReview } from './backup-schedule-ui';
it('T-copy: all seven waiting sentences match the catalogue and copy gate', () => {
  expect(Object.keys(BACKUP_WAIT_SENTENCES)).toHaveLength(7);
  for (const [key, text] of Object.entries(BACKUP_WAIT_SENTENCES)) {
    expect(en[`backup.waiting.${key}` as keyof typeof en]).toBe(text);
    expect(text).not.toMatch(/—|\bsafe\b|\bfree\b/i);
  }
  expect(backupWaitSentence({cause:'space',drive:'data',neededBytes:1e9})).toContain("this computer's drive");
  expect(backupWaitSentence({cause:'space',drive:'data'})).toBe(BACKUP_WAIT_SENTENCES.dataUnknown);
  expect(schedulePhase('waiting')).toBe('Waiting to back up. It starts by itself.');
  expect(scheduleNeedsReview('waiting')).toBe(false);
});

import {backupWaitDelayMs, delayForStops} from '../../shared/backup-capture-failure.mjs';
it('T-delay-contract: indexes and distinct stop counts have different first-stop semantics', () => {
  expect([0,1,2].map(backupWaitDelayMs)).toEqual([900000,3600000,3600000]);
  expect([0,1,2,3].map(delayForStops)).toEqual([900000,900000,3600000,3600000]);
});
