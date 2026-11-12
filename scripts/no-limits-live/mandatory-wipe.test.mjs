import { expect, it } from 'vitest';
import { fixture, d, baseRun } from '../../server/decision/fixture.ts';
// Positive controls use the real decision and presentation path. Commands
// remain inert data; no engine, shell or connector is invoked.
it.each(['rm -rf ~','rm -rf /','mkfs.ext4 /dev/sda'])('real catastrophe cards with typed wipe evidence: %s',async command=>{
  const f=fixture();
  try {
    const outcome=d.decide(f.open('wipe-control',{command}),baseRun);
    expect(outcome.kind).toBe('card');
    await d.presentApproval(outcome.ref,{title:'Wipe control',subtitle:'Inert fixture data'});
    expect(d.readApproval(outcome.ref.approvalId)).toMatchObject({why:'wipe'});
    expect(f.respond).not.toHaveBeenCalled();
  }finally{f.dispose();}
});

// Shared final-writer faults use the production replay API; no invented HTTP
// room/webhook route or ordinary-command substitute is used for these faults.
it.each(['changed-input','lost-live-record'])('a proven non-wipe owner call RUNS after %s',async fault=>{
  const {productionAdapter}=await import('../nolim-replay/production.mjs');
  const {DATA_DIR}=await import('../../server/config.ts');
  const previous=process.env.MURAGE_DATA_DIR;process.env.MURAGE_DATA_DIR=DATA_DIR;
  let adapter;
  try {
    adapter=await productionAdapter({dataDir:DATA_DIR,home:process.env.HOME,platform:process.platform});
    const got=await adapter.decide({id:'fault-control',tool:'Bash',fullToolInput:{command:'printf fixture'},
      ...(fault==='changed-input'?{updatedInput:{command:'printf changed'}}:{fault}),label:{independent:true,actor:'owner',kind:'none'}});
    expect(got.kind).toBe('run');
  }finally{await adapter?.close();if(previous===undefined)delete process.env.MURAGE_DATA_DIR;else process.env.MURAGE_DATA_DIR=previous;}
});
