// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner consumers: c3-nl-b; owner checker: wipe-fable; owner Pi gate: c3-drivers.
import {afterEach,expect,it,vi} from 'vitest';
import {visibleWipe} from './no-limits-visible-wipe.ts';
import {wipeBreaker} from '../server/wipe-breaker.ts';
import {linuxContext} from '../server/wipe/corpus/v3-context.fixture.ts';

afterEach(()=>{
 vi.unstubAllEnvs();
});

it.each([undefined,{}])('BLOCK-ENV server-only values never resolve engine variables, env=%s',env=>{
 vi.stubEnv('BUILD_DIR','/work/project/pkg/build');
 const context=linuxContext({env});
 const text='rm -rf "$BUILD_DIR"/*';
 expect(wipeBreaker(text,context)?.rule).toBe('delete-root');
 expect(visibleWipe(text,context)).toBe('delete-root');
 expect(visibleWipe(text,{...context,env:{BUILD_DIR:'/work/project/pkg/build'}})).toBeNull();
 // MAIN RULING 1114-NOLIMITS-OLD-ORACLES point 1: process.ts:39-46
 // treats nounset as off when the engine environment is unavailable.
 expect(visibleWipe('set -u; '+text,context)).toBe(env===undefined?'delete-root':null);
});

