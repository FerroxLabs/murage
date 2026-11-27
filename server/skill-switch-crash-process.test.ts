// Process fixture/test owner: skills lane; durable queue/receipt owner: decision lane.
import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTempDir} from './testing/cleanup.ts';

const matrix=['C01','C02','C03','C03-quarantine','C04','C05','C05-legacy-pending','C05-legacy-failed'].flatMap(point=>['sync','async'].flatMap(driver=>['row-backed','rowless','immediate'].flatMap(shape=>['turn_on','turn_off','delete'].map(action=>({point,driver,shape,action})))));
it.each(matrix)('$point actual process loss: $driver $shape $action',async({point,driver,shape,action})=>{
  const root=mkdtempSync(join(tmpdir(),'murage-skill-crash-'));mkdirSync(join(root,'fixture-home'));
  const run=(phase:string)=>spawnSync(process.execPath,['--experimental-transform-types','--no-warnings','server/testing/skill-switch-crash-process.mjs',phase,point,driver,shape,action],{
    encoding:'utf8',timeout:60_000,maxBuffer:4*1024*1024,env:{...process.env,MURAGE_DATA_DIR:root,MURAGE_COMPANION_DIR:join(root,'companion'),HOME:join(root,'fixture-home'),MURAGE_SKILL_CRASH_FIXTURE:'1'}});
  try{
    const first=run('init');expect(first.status,first.stderr+first.stdout).toBe(point==='C01'?71:point==='C04'?74:point.startsWith('C03')?0:72);
    const replay=run('replay');expect(replay.status,replay.stderr+replay.stdout).toBe(0);
    const report=JSON.parse(replay.stdout.split('\n').find(line=>line.startsWith('CRASH_FIXTURE '))!.slice(14));
    expect(report.result.state).toBe(point==='C04'?'already':'unconfirmed');
    expect(report.observations.filter((event:any)=>event.kind==='effect')).toHaveLength(point==='C01'?0:1);
    expect(report.observations.filter((event:any)=>event.phase==='replay')).toHaveLength(0);
    expect(report.observations.filter((event:any)=>event.phase==='live-retry')).toHaveLength(0);
    expect(report.observations.filter((event:any)=>event.kind==='read'&&event.phase==='init').length).toBeGreaterThan(0);
    expect(report.observations.filter((event:any)=>event.kind==='scan'&&event.phase==='init').length).toBeGreaterThan(0);
    expect(report.observations.every((event:any)=>event.acknowledged===undefined)).toBe(true);
    expect(report.enabled).toBe(action!=='turn_on');
    console.log('CRASH_CASE '+JSON.stringify({point,driver,shape,action,state:report.result.state,effects:report.observations.filter((event:any)=>event.kind==='effect').length}));
  }finally{await removeTempDir(root);}
},150_000);
