import { expect, test } from 'vitest';
import * as service from './service.ts';
const record = { version: 1, connectionId: 'legacy-id', generation: 0, enabled: false, paused: true, revoking: false, binding: null, account: null };
test('RED5 shared strict record parser supports non-UUID IDs and generation zero', () => {
  expect(service.parseSignalConnectionRecord(record)).toEqual(record);
  expect(() => service.parseSignalConnectionRecord({ ...record, extra: true })).toThrow();
});
test('RED5 schema-valid inconsistent binding is refused', () => {
  const binding = { connectionId: 'another', generation: 0, ownAci: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownDeviceId: 2, linkedAt: 1, chiefBotId: 'chief' };
  expect(() => service.parseSignalConnectionRecord({ ...record, binding })).toThrow();
  expect(service.parseSignalConnectionRecord({ ...record, binding: { ...binding, connectionId: record.connectionId } }).binding).toBeTruthy();
});
test('RED34 shared local authority phase revokes people and runs without any credential operation',async()=>{
 const calls:string[]=[];await service.revokeSignalLocalAuthority({people:{revoke:async id=>{calls.push('people:'+id);}},revokeRuns:async id=>{calls.push('runs:'+id);}},'old');
 expect(calls).toEqual(['people:old','runs:old']);
});
