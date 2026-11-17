import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectChildEntries} from './check-windows-hide-entries.mjs';
test('unrecognized child_process references fail closed, including reviewer fork.call',()=>{
 for(const source of [
  "import {fork} from 'node:child_process';fork.call(null,'C:/murage-ci/child.cjs',[],{env:{},execArgv:[]});",
  "import {spawn as run} from 'child_process';run.apply(null,args);",
  "import cp from 'node:child_process';cp[method]('node');",
  "import {fork} from 'node:child_process';thirdParty(fork);",
  "import * as cp from 'child_process';thirdParty(cp);",
  "import {fork} from 'child_process';const bound=fork.bind(null);bound('child.cjs');",
  "const cp=require('child_process');cp.fork.call(null,'child.cjs');",
  "import {ChildProcess} from 'node:child_process';new ChildProcess().spawn(options);",
  "import cp from 'node:child_process';const {unknownExport: run}=cp;run('child.cjs');",
  "import {fork} from 'node:child_process';thirdParty((fork || fallback));",
  "const cp=process.getBuiltinModule('node:child_process');cp.fork('child.cjs');",
  "import {fork} from 'node:child_process';holder.run=fork;holder.run('child.cjs');",
  "export {fork} from 'node:child_process';",
 ]) assert.ok(inspectChildEntries('server/witness.ts',source).failures.length,source);
});
