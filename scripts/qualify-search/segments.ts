// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';

// Read-only decoding follows SQLite's FTS5 structure format, including the V2
// contentless-delete fields. See the source link in the verification guide.
export function levels(db: DatabaseSync) {
  const block = Buffer.from(db.prepare('SELECT block FROM messages_fts_data WHERE id=10').get()!.block as Uint8Array);
  const extended = block.subarray(4,8).equals(Buffer.from([255,0,0,1]));
  let at = extended ? 8 : 4;
  const vint = () => { let n=0;for(let i=0;i<9;i++){const b=block[at++];if(b===undefined)throw Error('truncated FTS structure');n=n*(i===8?256:128)+(i===8?b:b&127);if(i===8||b<128)return n;}return n; };
  const count=vint(),total=vint();vint();let seen=0;const result:number[]=[];
  for(let i=0;i<count;i++){vint();const segments=vint();result.push(segments);seen+=segments;for(let j=0;j<segments;j++)for(let field=0;field<(extended?8:3);field++)vint();}
  if(seen!==total||at!==block.length)throw Error('unrecognized FTS structure format');
  return result;
}
// Fixture construction runs on the SAME real index worker before workload
// measurement. Only ordinary FTS commands are used; no shadow-page edits or
// invented segments. If the exact topology cannot be reached within the build
// budget, the leg fails its fixture bar with the observed levels and work count.
export function fixtureSource() {
  return `\nconst qualLevels=${levels.toString()};\n` + String.raw`
parentPort.on('message',message=>{
  if(message.type!=='qual-prepare-segments')return;
  const began=performance.now();let generations=0;
  a.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('automerge',0);INSERT INTO messages_fts(messages_fts,rank) VALUES('deletemerge',0);INSERT INTO messages_fts(messages_fts,rank) VALUES('crisismerge',16)");
  const top=Number(b.prepare('SELECT MAX(rowid) AS n FROM messages').get().n);
  const next=()=>{
    try{
      let layout=qualLevels(a);
      if([3,4,5].every(i=>layout[i]===15)||performance.now()-began>=message.budgetMs){
        a.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
        send('qual-fixture-complete',{levels:layout,generations,ms:performance.now()-began});return;
      }
      for(let i=0;i<256;i++){
        const row=live(1+(generations%top),4*1024*1024);generations++;
        if(!row.live||!row.text)continue;
        a.exec('BEGIN IMMEDIATE');
        try{
          a.prepare('DELETE FROM messages_fts WHERE rowid=?').run(row.rowid);
          a.prepare('INSERT INTO messages_fts(rowid,t) VALUES(?,?)').run(row.rowid,row.text);
          a.exec('COMMIT');
        }catch(error){if(a.isTransaction)a.exec('ROLLBACK');throw error;}
        layout=qualLevels(a);
        if([3,4,5].every(level=>layout[level]===15))break;
      }
      a.exec('PRAGMA wal_checkpoint(PASSIVE)');
      setImmediate(next);
    }catch(error){send('qual-fixture-complete',{error:true,levels:qualLevels(a),generations,ms:performance.now()-began});}
  };next();
});
`;
}
export async function prepareSegments(budgetMs: number) {
  const workers=(globalThis as Record<symbol,unknown>)[Symbol.for('murage.qual.workers')] as Worker[]|undefined;
  const worker=workers?.at(-1);if(!worker)throw Error('qualification worker observer not installed');
  return new Promise<{levels:number[];generations:number;ms:number;error?:boolean}>((resolve,reject)=>{
    const timer=setTimeout(()=>{worker.off('message',onMessage);reject(Error('segment fixture worker deadline'));},budgetMs+30_000);
    const onMessage=(event:{type:string;levels:number[];generations:number;ms:number;error?:boolean})=>{
      if(event.type!=='qual-fixture-complete')return;clearTimeout(timer);worker.off('message',onMessage);resolve(event);
    };
    worker.on('message',onMessage);worker.postMessage({type:'qual-prepare-segments',budgetMs});
  });
}
