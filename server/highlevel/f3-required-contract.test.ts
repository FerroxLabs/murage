// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
// Deliberately runtime-resolved: on the original c12aaad934 base the family is
// absent. Required tests must fail by assertion, not by an unresolved import.
const familyPath = './operations/' + 'registry.ts';
const family = await import(/* @vite-ignore */ familyPath).catch((error: unknown) => { console.info('F3 import unavailable:', String(error)); return undefined; });
function spec(verb: string): any {
  const found = family?.operationSpec?.(`conversations.${verb}`);
  expect(found, `required conversation operation ${verb}`).toBeDefined();
  return found;
}
it('all 20 frozen F3 operations are available', () => {
  expect(family?.familyOperations?.('conversations')?.length).toBe(20);
});
it('conv.sendOneRecipientOnly', async () => {
  const s = spec('send.sms');
  expect(s.args.safeParse({ type: 'SMS', contactId: ['contact_1', 'contact_2'], message: 'hello', status: 'pending' }).success).toBe(false);
  await expect(s.prepare({ read: async () => ({}) }, { type: 'SMS', contactId: 'contact_1', message: 'hello', status: 'pending', toNumber: '+15555555555' }, { locationId: 'loc_1' })).rejects.toThrow();
});
it('conv.sixthSendEscalatesToD marks every send for the common host counter', () => {
  const sends = family?.familyOperations?.('conversations')?.filter((s: any) => s.id.startsWith('conversations.send.'));
  expect(sends?.length).toBe(9);
  expect(sends.every((s: any) => s.send === true && s.risk === 'C')).toBe(true);
});
it('conv.attachmentWorkspaceOnlyShaOnCard refuses an unprepared file', async () => {
  const s = spec('attachment.upload');
  await expect(s.prepare({}, { conversationId: 'conv_1', file: { workspaceFile: '../secret' } }, { locationId: 'loc_1' })).rejects.toThrow();
});
it('conv.bodyNeverInReceipt keeps reviewed message values out of field and record metadata', () => {
  const s = spec('send.sms');
  const secret = 'PRIVATE_RECEIPT_SENTINEL';
  const input = { type: 'SMS', contactId: 'contact_1', message: secret };
  expect(JSON.stringify([s.fields(input), s.recordRefs(input)])).not.toContain(secret);
});
it('conv.scheduledCancelIsC', () => {
  expect(spec('schedule.cancel').risk).toBe('C');
  expect(spec('schedule.cancelEmail').risk).toBe('C');
});
