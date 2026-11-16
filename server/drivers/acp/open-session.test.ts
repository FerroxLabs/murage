import { expect, it } from 'vitest';
import { openAcpSession } from './open-session.ts';

it('binds load before a config update in the same transport chunk', async () => {
  let sessionId: string | null = null;
  let value = 'stale';
  // A single stdout write containing the response immediately followed by the notification.
  const chunk = '{"id":1,"result":{"configOptions":[]}}\n{"method":"session/update","params":{"sessionId":"saved","value":"fresh"}}\n';
  await openAcpSession({
    method: 'session/load', params: { sessionId: 'saved' }, sessionId: () => sessionId, bind: id => { sessionId = id; },
    request: receive => new Promise(resolve => {
      for (const line of chunk.trim().split('\n')) {
        const frame = JSON.parse(line);
        if (frame.id) { receive(frame.result); resolve(frame.result); }
        else if (frame.params.sessionId === sessionId) value = frame.params.value;
      }
    }),
    receive: () => {}, check: () => {}, policyFailure: () => undefined,
  });
  expect(value).toBe('fresh');
  expect(sessionId).toBe('saved');
});

it.each(['rpc', 'policy', 'null'])('preserves the prior binding after %s load failure', async kind => {
  let sessionId: string | null = 'previous';
  const opened = openAcpSession({
    method: 'session/load', params: { sessionId: 'saved' }, sessionId: () => sessionId, bind: id => { sessionId = id; },
    request: async receive => {
      if (kind === 'rpc') throw new Error('refused');
      const result = kind === 'null' ? null : {};
      receive(result); return result;
    },
    receive: () => {}, check: () => { if (kind === 'policy') throw new Error('refused'); }, policyFailure: () => undefined,
  });
  if (kind === 'null') await expect(opened).resolves.toBeNull();
  else await expect(opened).rejects.toThrow('refused');
  expect(sessionId).toBe('previous');
});

it('binds the process owner before the next frame of a fallback one-write response', async () => {
  let sessionId: string | null = 'previous';
  const owner = { sessionId: 'previous' as string | null };
  let received = false;
  const chunk = '{"id":1,"result":{"sessionId":"fallback"}}\n{"method":"session/update","params":{"sessionId":"fallback"}}\n';
  const options = {
    method: 'session/new' as const, params: {}, sessionId: () => sessionId, bind: (id: string | null) => { sessionId = id; },
    owner,
    request: (receive: (result: any) => void) => new Promise(resolve => {
      for (const line of chunk.trim().split('\n')) {
        const frame = JSON.parse(line);
        if (frame.id) { receive(frame.result); resolve(frame.result); }
        else received = frame.params.sessionId === owner.sessionId;
      }
    }),
    receive: () => {}, check: () => {}, policyFailure: () => undefined,
  };
  await openAcpSession(options);
  expect(received).toBe(true);
  expect(owner.sessionId).toBe('fallback');
});

it('rolls both session bindings back when fallback policy fails', async () => {
  let sessionId: string | null = 'previous';
  const owner = { sessionId: 'previous-owner' as string | null };
  let boundAtReceive: string | null = null;
  const options = {
    method: 'session/new' as const, params: {}, sessionId: () => sessionId, bind: (id: string | null) => { sessionId = id; },
    owner,
    request: async (receive: (result: any) => void) => { const result = { sessionId: 'fallback' }; receive(result); return result; },
    receive: () => { boundAtReceive = owner.sessionId; },
    check: () => { throw new Error('fixture policy failure'); }, policyFailure: () => undefined,
  };
  await expect(openAcpSession(options)).rejects.toThrow('fixture policy failure');
  expect(boundAtReceive).toBe('fallback');
  expect(sessionId).toBe('previous');
  expect(owner.sessionId).toBe('previous-owner');
});
