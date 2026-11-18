// The complete production tree and every dependency must be checked out at
// --base before invoking this in the isolated remote container. Only the
// generator, corpus and caller harness are carried from the new tree.
import {spawnSync} from 'node:child_process';
const base=process.argv[process.argv.indexOf('--base')+1];
if(!/^[a-f0-9]{40}$/.test(base)||process.env.UPMASK_PREPARED_BASE!==base)throw Error('Prepare and verify the complete release-base tree first');
const run=spawnSync('pnpm',['exec','vitest','run','shared/provider-secret-golden.test.ts'],{stdio:'inherit',env:process.env});
process.exitCode=run.status??1;
