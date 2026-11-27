#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Validate execution, not release qualification; preserve every measured miss."""
import json,sys
root,leg,variant,bar=sys.argv[1:]
r=json.load(open(root+'/'+leg+'.json'))
v=json.load(open(root+'/vitest.json'))
assert r['smoke'] is True and r['qualification'] is False
assert all(not x.get('message') for x in v['testResults']), 'suite/setup/teardown failed'
failed=[a for x in v['testResults'] for a in x['assertionResults'] if a['status']=='failed']
bad={k for k,p in r['pass'].items() if not p}
if variant=='fail':
    assert r['pass'][bar] is False and r['injectedBar']==bar
    assert r['computedPass'][bar] is False
    if bar=='main-fts': assert r['raw']['mainFTSStatements']>0
    elif bar=='integrity': assert r['raw']['integrityChecks']['search'] is False
    elif bar=='parity': assert any(x['count']==0 for x in r['raw']['parity'])
    elif bar=='new-fails': assert len(r['raw']['newFails'])==1
else:
    assert r.get('injectedBar') is None
    if bad:
        if leg=='q2-diskfull':
            assert r['raw']['maskedFull']>0 and bad=={'atomic-owner'}
        elif leg in ('q1-103k','q1-1m'):
            assert bad <= {'event-loop','owner-commit','worker-step','merge-residual','halt-recovery'}
        elif leg=='q3-copy':
            assert bad <= {'open','rebuild-owner','owner-p99'}
        else:
            raise AssertionError('unexpected smoke failure')
        print(leg+' measured bars OPEN: '+','.join(sorted(bad)))
if bad:
    assert len(failed)==1
    message=failed[0]['failureMessages'][0]
    assert 'AssertionError' in message and 'ORACLE:'+leg in message, 'not a behavioural assertion'
else:
    assert not failed and v['success'] is True
