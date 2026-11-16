// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { wiring } from './fixture.ts';
describe('R5 E1-E6 / A6a: durable deny adapter', () => {
  it('E5 read-only denial keeps read op and exact account (M58)', () => {
    const { resolveDecisionDenials } = wiring(['resolveDecisionDenials']);
    const denial = { id:'d', toolkit:'gmail', accountId:'a', tools:['GMAIL_FETCH_EMAILS'], ops:['read'], source:'request-denied', revision:1 };
    const target = {kind:'connected-app',toolkit:'gmail',accountId:'a',tool:'GMAIL_FETCH_EMAILS',op:'read'};
    expect(resolveDecisionDenials({denials:[denial]}, [target])).toHaveLength(1);
    expect(resolveDecisionDenials({denials:[denial]}, [{...target,op:'write'}])).toHaveLength(0);
    expect(resolveDecisionDenials({denials:[denial]}, [{...target,accountId:'b'}])).toHaveLength(0);
    expect(resolveDecisionDenials({denials:[]}, [target])).toHaveLength(0);
  });
  it('E6 write revocation cards write while the read twin runs', () => {
    const { resolveDecisionDenials } = wiring(['resolveDecisionDenials']);
    const state = {denials:[{id:'revoked',toolkit:'gmail',tools:['SEND'],ops:['write'],source:'grant-revoked',revision:2}]};
    expect(resolveDecisionDenials(state,[{kind:'connected-app',toolkit:'gmail',tool:'SEND',op:'write'}])).toHaveLength(1);
    expect(resolveDecisionDenials(state,[{kind:'connected-app',toolkit:'gmail',tool:'SEND',op:'read'}])).toHaveLength(0);
  });
  it('host declined and exact browser Never are persisted sources; protected paths stay S1-owned', () => {
    const { resolveDecisionDenials } = wiring(['resolveDecisionDenials']);
    const state = {host:'declined',sites:['https://example.test'],denials:[]};
    expect(resolveDecisionDenials(state,[{kind:'host-computer',scope:'local-computer'},{kind:'browser-site',origin:'https://example.test',op:'read'}])).toHaveLength(2);
    expect(resolveDecisionDenials(state,[{kind:'browser-site',origin:'https://other.test',op:'read'},{kind:'path',path:'/etc/cron.d/x',op:'read'}])).toHaveLength(0);
  });
});
