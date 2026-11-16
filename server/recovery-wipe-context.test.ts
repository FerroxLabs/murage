// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner recovery consumer: c3-nl-b. Owner checker: wipe-fable.
import {expect,it} from 'vitest';
import {recoveryExecutesScript} from './no-limits-wipe-scripts.ts';
import {linuxContext,corpusContext} from './wipe/corpus/v3-context.fixture.ts';
it('recovery resolves the engine environment and preserves root cards',()=>{
 expect(recoveryExecutesScript('rm -rf "$BUILD_DIR"/*',linuxContext({env:{BUILD_DIR:'/work/project/pkg/build'}}))).toBe(false);
 expect(recoveryExecutesScript('rm -rf "$BUILD_DIR"/*',linuxContext({env:{BUILD_DIR:'/home/u'}}))).toBe(true);
 expect(recoveryExecutesScript('rm -rf "$BUILD_DIR"/*',linuxContext({env:{BUILD_DIR:undefined}}))).toBe(true);
});
it('recovery passes the actual cwd, project and dialect',()=>{
 expect(recoveryExecutesScript('rm -rf .',linuxContext({cwd:'/work/project'}))).toBe(true);
 expect(recoveryExecutesScript('rm -rf .',linuxContext())).toBe(false);
 expect(recoveryExecutesScript('rd -r -fo ~',corpusContext({platform:'win32',dialect:'pwsh',cwd:'C:\\work\\project\\pkg'}))).toBe(true);
});
