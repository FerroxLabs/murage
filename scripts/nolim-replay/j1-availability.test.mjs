const {test}=process.env.VITEST ? await import('vitest') : await import('node:test');
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkAvailability} from './j1-availability.mjs';
function corpus(rows,run){const dir=mkdtempSync(join(tmpdir(),'j1-availability-')),file=join(dir,'corpus.jsonl');try{writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');run(file);}finally{rmSync(dir,{recursive:true,force:true});}}
test('Q5 ignores the v2 count header and binds every known unavailable corpus shape',()=>corpus([
 {schema:'murage.nolim-cards-count.v2',total:5,emitted:5,limit:140},
 {tool:'Bash',boundedToolInput:'echo fixture'},
 {tool:'Edit',toolInputTruncated:true},
 {tool:'Write',toolInputTruncated:true,boundedToolInput:'cat <<EOF\nfixture'},
 {tool:'Write',toolInputTruncated:true},
 {tool:'mcp__tvcontrol__pine_set_source',toolInputTruncated:true},
],file=>{const r=checkAvailability(file);assert.equal(r.rows,5);assert.equal(r.status,'PASS');assert.deepEqual(r.missingJ3Rows,[]);assert.equal(r.counts['unavailable:input'],5);assert.equal(r.verdictsClaimed,false);assert.equal(r.shapeRows.length,5);}));
test('Q5 unknown unavailable shape still fails a missing J3 binding',()=>corpus([{tool:'unbound_fixture_tool'}],file=>{const r=checkAvailability(file);assert.equal(r.status,'FAIL');assert.deepEqual(r.missingJ3Rows,['unavailable-unbound_fixture_tool-missing-input']);}));
