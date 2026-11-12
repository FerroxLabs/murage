// Each mutant removes a production installation, then boots the real server.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let file='server/index.ts';
const cases={
  M3: [/   reportDecisionRefusal\(cause\);/, '   /* refusal diagnostic removed */'],
  M2: [/setApprovalContextReader\(\(threadId, botId\) => \{[\s\S]*?\n\}\);/, '/* context reader installation removed */'],
  M1: [/installBotAccessApprovalAccounts\(store, \(\) => currentConnectedAccessAccounts\(\{ remembered: false \}\)\);/, '/* account reader installation removed */'],
  H2: [/installMemoryApprovalAccess\(recoveredMemoryApprovalAccess\);/, '/* memory recovery installation removed */'],
  H1: [/installHighlevelEngineLedger\(highlevelCallLedger\);/, '/* ledger installation removed */'],
  C1: [ /const removeSync = installSynchronousQueueDeliveries\(\[\{ kind: port.kind,[\s\S]*?\}\]\);/, 'const removeSync = () => {};'],
};
const expectedFailure={C1:/state[\s\S]*failed/,H1:/backstop[\s\S]*deny/,H2:/delivery[\s\S]*failed/,
 M1:/expected 503 to be 200/,M2:/expected 'card' to be 'run'/,M3:/expected \+?0 to be 1/};
mkdirSync('evidence/wiring-fix',{recursive:true});
for(const row of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases)) {
  file=row==='M3'?'server/decision/implementation.ts':'server/index.ts';
  const original=readFileSync(file,'utf8');
  const [pattern,replacement]=cases[row];
  if(!pattern.test(original))throw new Error(`${row}: install anchor missing`);
  try {
    writeFileSync(file,original.replace(pattern,replacement));
    const output=`evidence/wiring-fix/${row}-mutant.json`;
    if(existsSync(output))unlinkSync(output);
    const result=spawnSync('pnpm',['exec','vitest','run','server/decision/production-boot-wiring.test.ts','-t',`^${row} `,'--reporter=json',`--outputFile=${output}`],{encoding:'utf8',timeout:240_000});
    writeFileSync(`evidence/wiring-fix/${row}-mutant.log`,result.stdout+result.stderr);
    if(result.error)throw result.error;
    const report=JSON.parse(readFileSync(output,'utf8'));
    const failures=report.testResults.flatMap(r=>r.assertionResults).filter(r=>r.status==='failed');
    if(result.status===0||!failures.some(r=>r.fullName.startsWith(row+' ')&&r.failureMessages.some(m=>expectedFailure[row].test(m))))throw new Error(`${row}: mutant survived or infrastructure failure`);
    console.log(`${row}: KILLED by assertion`);
  } finally { writeFileSync(file,original); }
}
