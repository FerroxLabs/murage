import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCleanup,validateDiff} from './cleanup-proof.mjs';
import {emptyDiff,cleanup} from './cleanup-fixture.mjs';
for(const kind of ['desktop','handoff'])test(`outer ${kind} cleanup accepted`,()=>validateCleanup({kind,cleanup:cleanup(kind)}));
for(const mutate of [c=>c.writer='child',c=>c.pid=c.childPid,c=>c.finalizedAt=0,c=>c.job.flags|=0x800,c=>c.job.empty=false,c=>c.job.ownerClosed=false,c=>c.job.remaining=[12],c=>c.tasks.errors=['new unprefixed task'],c=>c.tasks.ok=false,c=>c.registrations=emptyDiff()])test(`refuse cleanup: ${mutate}`,()=>{const c=cleanup();mutate(c);assert.throws(()=>validateCleanup({kind:'desktop',cleanup:c}));});
test('refuse child assertion object without outer proof',()=>assert.throws(()=>validateCleanup({kind:'desktop'})));
test('diff rejects unprefixed delete even if cleaner claims success',()=>{
 const d=emptyDiff();const item={id:'\\unowned'};d.after=[item];d.added=[item];d.deleted=[item.id];
 assert.throws(()=>validateDiff(d,cleanup().prefix),/unprefixed/);
});
test('diff rejects deletion of a prefixed preexisting task',()=>{
 const d=emptyDiff(),item={id:`\\${cleanup().prefix}old`};d.before=[item];d.deleted=[item.id];
 assert.throws(()=>validateDiff(d,cleanup().prefix));
});
test('diff accepts only new prefixed cleanup',()=>{
 const d=emptyDiff(),item={id:`\\nested\\${cleanup().prefix}new`};d.after=[item];d.added=[item];d.deleted=[item.id];validateDiff(d,cleanup().prefix);
});
