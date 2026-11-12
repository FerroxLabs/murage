import assert from 'node:assert/strict';
export function validateGroupEvidence(kind,before,after,result,prefix) {
 for(const snapshot of [before,after]) {
  assert.equal(snapshot.kind,kind);
  assert(Array.isArray(snapshot.tasks));assert(Array.isArray(snapshot.registrations));
  for(const task of snapshot.tasks)for(const key of ['id','name','author','actions','definition'])assert.equal(typeof task[key],'string');
  if(kind==='desktop')assert.deepEqual(snapshot.registrations,[]);
 }
 for(const field of ['tasks','registrations']) {
  const owned=id=>id.split(/[\\/]/).some(p=>p.startsWith(prefix));
  for(const row of after[field]){
   const old=before[field].find(x=>x.id.toLowerCase()===row.id.toLowerCase());
   if(!owned(row.id))assert.deepEqual(row,old,'unprefixed registration change in group');
  }
  for(const row of before[field])if(!owned(row.id))assert(after[field].some(x=>x.id.toLowerCase()===row.id.toLowerCase()),'unprefixed registration removed');
 }
 const rows=result.shellRows??[];
 if(kind==='desktop')assert(!rows.some(x=>x.row==='https-opened'||x.osDispatch),'Desktop dispatch forbidden');
 else assert(rows.some(x=>x.row==='https-opened'&&x.osDispatch==='fulfilled'&&x.browserMayOutliveRun===true),'handoff HTTPS dispatch required');
}
