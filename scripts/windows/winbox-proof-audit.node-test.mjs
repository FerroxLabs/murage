import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const read = name => readFileSync(new URL(name,import.meta.url),'utf8');

// This conservative inventory includes every quoted source fragment, including
// technical tokens, so prompts/diagnostics/fixture text cannot silently escape.
const sources = ['winbox-driver.mjs','winbox-driver.node-test.mjs','winbox-gate.ps1','winbox-sampler.cs','winbox-shell-mcp.mjs','winbox-proof-audit.node-test.mjs'];
export function stringInventory() {
  return sources.map(file=>({file,strings:read(file).split('\n').flatMap((line,index)=>{
    if (/^\s*(\/\/|#)/.test(line)) return [];
    return [...line.matchAll(/(['"`])(?:\\.|(?!\1).)*?\1/g)].map(match=>({line:index+1,text:match[0]}));
  })}));
}

test('BLOCK 3: verification cites behavioral RED and killed implementation mutants',()=>{
  const report=read('evidence/winbox-gate-verification.md');
  for(const log of ['afix-reviewed-red.log','afix-base-replay-red.log','afix-mutant-unknown-owner.log','afix-mutant-discard-offenders.log','afix-mutant-terminal.log','afix-mutant-child.log','afix-mutant-self-test.log','afix-mutant-workflow.log','afix-audit-red.log']) {
    assert(report.includes(log),`verification must cite ${log}`);
    const output=read(`evidence/${log}`);
    assert.match(output,/AssertionError \[ERR_ASSERTION\]/,`${log} must fail a behavioral assertion`);
    assert.doesNotMatch(output,/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,`${log} cannot be a missing-module RED`);
  }
  assert.match(report,/4d9e2f97cb/);assert.match(report,/overlay/i);
});

test('BLOCK 4: every quoted harness string is inventoried',()=>{
  const inventory=existsSync(new URL('winbox-strings.json',import.meta.url)) ? JSON.parse(read('winbox-strings.json')) : {files:[]};
  assert.deepEqual(inventory.files.map(row=>row.file),sources,'missing string inventory sources');
  assert.deepEqual(inventory.files,stringInventory());
});

test('ROUND 3: fallback retains an existing offender artifact and driver writes it first',()=>{
  const ps=read('winbox-gate.ps1');
  const fallback=ps.slice(ps.indexOf("if(-not (Test-Path -LiteralPath (Join-Path $output 'verdict.json')))"));
  assert.match(fallback,/\$offenders=@\(Get-Content -LiteralPath \$offendersFile -Raw \| ConvertFrom-Json\)/);
  assert.match(fallback,/offendingWindows=\$offenders/);
  assert.doesNotMatch(fallback,/Save-Json .*'offending-windows.json'\) @\(\)/);
  const driver=read('winbox-driver.mjs');
  assert(driver.indexOf("writeFileSync(join(dirname(file),'offending-windows.json')") < driver.indexOf("writeFileSync(join(dirname(file),'verdict.json')"));
});
