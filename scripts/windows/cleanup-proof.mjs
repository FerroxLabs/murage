import assert from 'node:assert/strict';
export function validateDiff(d,prefix) {
 assert(d && d.ok === true,'cleanup failed');
 for(const key of ['before','after','added','changed','removed','deleted','remaining','errors'])assert(Array.isArray(d[key]),`snapshot ${key}`);
 assert.deepEqual(d.errors,[]);assert.deepEqual(d.changed,[]);assert.deepEqual(d.removed,[]);
 const owned=id=>id.split(/[\\/]/).some(p=>p.startsWith(prefix));
 const old=new Map(d.before.map(x=>[x.id.toLowerCase(),x]));
 assert.equal(old.size,d.before.length,'duplicate baseline');
 const added=d.after.filter(x=>!old.has(x.id.toLowerCase()));
 assert.deepEqual(d.added,added,'actual snapshot additions');
 assert.deepEqual([...d.deleted].sort(),added.map(x=>x.id).sort(),'every new registration cleaned');
 for(const x of d.before) {
  assert.deepEqual(d.after.find(y=>y.id.toLowerCase()===x.id.toLowerCase()),x,'preexisting registration changed');
  assert.deepEqual(d.remaining.find(y=>y.id.toLowerCase()===x.id.toLowerCase()),x,'preexisting registration removed');
 }
 for(const id of d.deleted){assert(owned(id),'unprefixed deletion');assert(!old.has(id.toLowerCase()),'preexisting deletion');}
 assert.deepEqual(d.remaining.map(x=>x.id).sort(),d.before.map(x=>x.id).sort(),'leftover or new registration');
}
export function validateCleanup(r) {
 const c=r.cleanup;assert(c,'outer cleanup required');
 assert.equal(c.writer,'operator','child receipt refused');
 for(const n of [c.pid,c.childPid])assert(Number.isSafeInteger(n)&&n>0);
 assert.notEqual(c.pid,c.childPid,'child finalization refused');
 assert.match(c.prefix,/^MurageCI-[a-f0-9]{32}-$/);
 assert(Number.isFinite(c.completedAt)&&c.completedAt>0&&c.finalizedAt>=c.completedAt,'cleanup must precede receipt');
 assert.deepEqual(c.job,{ownerClosed:true,empty:true,flags:0x2000,remaining:[]},'job close/empty/no-breakaway proof');
 assert(c.processes?.ok===true);assert.deepEqual(c.processes.escaped,[]);assert.deepEqual(c.processes.enrolled,[]);assert(Array.isArray(c.processes.browsers));
 if(r.kind==='desktop')assert.deepEqual(c.processes.browsers,[]);
 validateDiff(c.tasks,c.prefix);validateDiff(c.launcher,c.prefix);
 if(r.kind==='desktop')assert.equal(c.registrations,null,'Desktop must not inspect installer registrations');
 else validateDiff(c.registrations,c.prefix);
}
