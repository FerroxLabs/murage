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
