import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

const oldSQL = "SELECT DISTINCT s.owner_key FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE s.kind='conversation' AND (r.id,r.version) IN (SELECT value->>0,value->>1 FROM json_each(?))";
// 2fe571bb91 records every cited notebook, including bot scopes, for scoped deletion.
const sql = readFileSync(new URL('./disclosures.ts', import.meta.url), 'utf8').match(/prepare\("(SELECT DISTINCT s.id,s.kind,s.owner_key[^"]+)"\)/)![1];
const schema = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8');

it('keeps the exact dependency set, including missing ancestry, and visits only cited scopes at tenfold history', () => {
  const visits: number[] = [];
  for (const threads of [2000, 20000]) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=OFF'); // deliberately incomplete historical ancestry
    try {
      for (const name of ['memory_scopes', 'memory_records', 'memory_derivations']) db.exec(schema.match(new RegExp('CREATE TABLE IF NOT EXISTS '+name+' \\([\\s\\S]*?\\);'))![0]);
      db.exec('CREATE INDEX memory_records_scope ON memory_records(scope_id,state); CREATE INDEX memory_scopes_owner ON memory_scopes(kind,owner_key); BEGIN');
      const scope = db.prepare("INSERT INTO memory_scopes VALUES(?,'conversation',?,'[]',0)");
      const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','fixture','fixture','active',0,0,NULL,NULL,0)");
      for (let i=0;i<threads;i++) { scope.run('s'+i,'t'+i); for(let j=0;j<25;j++) record.run('r'+i+'-'+j,'s'+i); }
      db.exec("INSERT INTO memory_scopes VALUES('bot','bot','not-a-thread','[]',0)");
      record.run('bot-record','bot');
      record.run('orphan-record','missing-scope');
      db.exec("INSERT INTO memory_records SELECT id,2,scope_id,kind,text,assertion,'archived',owner_pinned,valid_from,valid_to,supersedes_id,created_at FROM memory_records WHERE id='r0-0'");
      // No ancestry join belongs in this dependency query. The separate conservative flag must still handle this edge.
      db.exec("INSERT INTO memory_derivations VALUES('missing-parent',1,'r0-0',1); COMMIT");
      const cases = [[], [['missing',1]], [['r0-0',3]], [['r0-0',2]], [['orphan-record',1]], [['bot-record',1]], [['r0-0',1],['r0-0',1],['r1-0',1],['bot-record',1],['missing',1]]];
      for (const pairs of cases) {
        const args = JSON.stringify(pairs);
        const owners = (q: string) => db.prepare(q).all(args).filter(r => r.kind === undefined || r.kind === 'conversation').map(r=>r.owner_key).sort();
        expect(owners(sql)).toEqual(owners(oldSQL));
        // Keep the widened dependency set exact too, including non-conversation notebooks.
        const expected = db.prepare("SELECT DISTINCT s.id,s.kind,s.owner_key FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE (r.id,r.version) IN (SELECT value->>0,value->>1 FROM json_each(?))").all(args);
        const sorted = (rows: typeof expected) => rows.map(row => JSON.stringify(row)).sort();
        expect(sorted(db.prepare(sql).all(args))).toEqual(sorted(expected));
      }
      let count=0;
      db.function('visited_scope',(_id)=>{count++;return 1;});
      const measured=sql+' WHERE visited_scope(s.id)';
      const args=JSON.stringify([['r0-0',1]]);
      const plan=(q:string)=>db.prepare('EXPLAIN QUERY PLAN '+q).all(args).map(r=>String(r.detail));
      expect(plan(measured)).toEqual(plan(sql));
      db.prepare(measured).all(args); visits.push(count);
      console.log({threads, records:threads*25, visits:count, plan:plan(sql)});
      expect(plan(sql).some(p=>/SEARCH s .*\(id=\?\)/.test(p))).toBe(true);
      expect(plan(sql).some(p=>/SEARCH r .*\(id=\? AND version=\?\)/.test(p))).toBe(true);
    } finally { db.close(); }
  }
  expect(visits).toEqual([1,1]);
});
