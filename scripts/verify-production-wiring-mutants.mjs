import { evidencePath } from './evidence-path.mjs';
// Each mutant removes a production installation, then boots the real server.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let file='server/index.ts';
const cases={
  'H1-powershell': [/\.\.\.Object\.values\(CLAUDE_NATIVE_SHELL_TOOLS\)/, 'CLAUDE_NATIVE_SHELL_TOOLS.bash'],
  'H1-edit': [/'apply_patch','edit','read_file'/, "'apply_patch','read_file'"],
  'C1-proof': [/      if \(result.state === 'accepted' \|\| result.state === 'already'\) \{\n        void releaseDecisionQueueProof\(item\)[^\n]*\n      \}/, '      /* synchronous proof cleanup removed */'],
  M3: [/   reportDecisionRefusal\(cause\);/, '   /* refusal diagnostic removed */'],
  M2: [/setApprovalContextReader\(\(threadId, botId\) => \{[\s\S]*?\n\}\);/, '/* context reader installation removed */'],
  M1: [/installBotAccessApprovalAccounts\(store, \(\) => currentConnectedAccessAccounts\(\{ remembered: false \}\)\);/, '/* account reader installation removed */'],
  H2: [/installMemoryApprovalAccess\(recoveredMemoryApprovalAccess\);/, '/* memory recovery installation removed */'],
  H1: [/installHighlevelEngineLedger\(highlevelCallLedger\);/, '/* ledger installation removed */'],
  C1: [ /const removeSync = installSynchronousQueueDeliveries\(\[\{ kind: port.kind,[\s\S]*?\}\]\);/, 'const removeSync = () => {};'],
};
const expectedFailure={C1:/state[\s\S]*failed/,H1:/backstop[\s\S]*deny/,H2:/delivery[\s\S]*failed/,
 'H1-edit':/backstop[\s\S]*deny/,'C1-proof':/present[\s\S]*true/,
 'H1-powershell':/expected false to be true|expected undefined to be 'PowerShell'/,
 M1:/M1 reached the accounts reader/,M2:/expected 'card' to be 'run'/,M3:/expected \+?0 to be 1/};
mkdirSync(evidencePath('evidence/wiring-fix'),{recursive:true});
for(const row of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases)) {
  file=row==='M3'?'server/decision/implementation.ts':row==='H1-edit'||row==='H1-powershell'?'server/highlevel/engine-policy.ts':'server/index.ts';
  const original=readFileSync(file,'utf8');
  const [pattern,replacement]=cases[row];
  if(!pattern.test(original))throw new Error(`${row}: install anchor missing`);
  try {
    writeFileSync(file,original.replace(pattern,replacement));
    const output=evidencePath(`evidence/wiring-fix/${row}-mutant.json`);
    if(existsSync(output))unlinkSync(output);
    const testPrefix=row==='H1-powershell'?'H1 native Claude PowerShell':row==='H1-edit'?'H1 Codex':row==='C1-proof'?'C1 recovered':row;
    const testFile=row==='H1-powershell'?'server/decision/production-claude-shell-wiring.test.ts':'server/decision/production-boot-wiring.test.ts';
    const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',testFile,'-t',`^${testPrefix} `,'--reporter=json',`--outputFile=${output}`],{encoding:'utf8',timeout:240_000});
    writeFileSync(evidencePath(`evidence/wiring-fix/${row}-mutant.log`),(result.stdout??'')+(result.stderr??''));
    if(result.error)throw result.error;
    const report=JSON.parse(readFileSync(output,'utf8'));
    const failures=report.testResults.flatMap(r=>r.assertionResults).filter(r=>r.status==='failed');
    if(result.status===0||!failures.some(r=>r.fullName.startsWith(testPrefix+' ')&&r.failureMessages.some(m=>expectedFailure[row].test(m))))throw new Error(`${row}: mutant survived or infrastructure failure`);
    console.log(`${row}: KILLED by assertion`);
  } finally { writeFileSync(file,original); }
}
