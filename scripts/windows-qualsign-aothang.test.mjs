import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
const root=new URL('..',import.meta.url).pathname;
const inputs=readFileSync(join(root,'infra/windows-signing/collector/Inputs.ps1'),'utf8');
const build=readFileSync(join(root,'infra/windows-signing/collector/Build.ps1'),'utf8');
const body=name=>{const start=inputs.indexOf(`function ${name}(`); const next=inputs.indexOf('\nfunction ',start+1); return inputs.slice(start,next<0?undefined:next);};
const clean=body('Get-CleanEnvironment'), invoke=body('Invoke-Clean');
const allow=()=>(clean.match(/-cnotmatch '\\A\(([^']*)\)\\z'/)?.[1]??'').split('|');
// Round 10: the NativeAOT publish child ran silently until the 30 minute job limit. Invoke-Clean buffered all output until exit with
// unbounded waits, and the first stage new in that round (findvcvarsall.bat -> vcvarsall.bat -> VsDevCmd.bat, then `where link`)
// ran with no %PATHEXT%, a telemetry sender that starts a detached powershell.exe, and %SystemRoot% read from a registry scope that lacks it.
describe('pinned publish child environment admits what the MSVC lookup needs',()=>{
  it('admits PATHEXT and VSCMD_SKIP_SENDTELEMETRY by exact name, each set with a reason, and keeps the allow-list closed',()=>{
    const names=allow();
    for (const name of ['PATHEXT','VSCMD_SKIP_SENDTELEMETRY']) expect(names).toContain(name);
    expect(names.join('|')).not.toMatch(/\.\*|\.\+|\\w\*|\\S\*/);
    const branch=clean.slice(clean.indexOf('if ($IsWindows) {'),clean.indexOf('# The child environment is an allow-list'));
    expect(branch).toMatch(/# [^\n]*%PATHEXT%[^\n]*\n\s*\$environment\['PATHEXT'\] = '\.COM;\.EXE;\.BAT;\.CMD'/);
    expect(branch).toMatch(/# [^\n]*powershell\.exe[^\n]*\n\s*\$environment\['VSCMD_SKIP_SENDTELEMETRY'\] = '1'/);
  });
  it('takes SystemRoot from the Windows folder, never from the Machine registry scope',()=>{
    expect(clean).toContain("$environment['SystemRoot'] = [Environment]::GetFolderPath('Windows')");
    expect(clean).not.toMatch(/GetEnvironmentVariable\('SystemRoot'/);
  });
  it('sets every dotnet first-run, banner and telemetry opt-out',()=>{
    for (const name of ['DOTNET_NOLOGO','DOTNET_CLI_TELEMETRY_OPTOUT','DOTNET_SKIP_FIRST_TIME_EXPERIENCE']) expect(clean).toContain(`$environment['${name}'] = '1'`);
  });
});
describe('Invoke-Clean streams the child live and keeps the captured lines',()=>{
  it('reads both pipes line by line asynchronously; nothing waits for end-of-stream or exit without a bound',()=>{
    expect(invoke).not.toMatch(/ReadToEnd/);
    expect(invoke).toContain('$readers = @($child.StandardOutput, $child.StandardError)');
    expect(invoke).toContain('$readers[$index].ReadLineAsync()');
    expect(invoke).toContain('[Threading.Tasks.Task]::WaitAny(');
    expect(invoke).not.toMatch(/WaitForExit\(\)/);
  });
  it('writes every line to the log and to the host as it arrives',()=>{
    expect(invoke).toMatch(/\$writer\.WriteLine\(\$line\); Write-Host \$line/);
    expect(invoke).toContain('$child.StandardInput.Close()');
  });
});
describe('a hang can never be silent again',()=>{
  it('Invoke-Clean has a bounded deadline, a drain deadline, kills the tree and prints the process list and last output',()=>{
    const def=invoke.match(/\[int\] \$TimeoutSeconds = ([0-9]+)\)/);
    expect(Number(def?.[1])).toBeGreaterThan(0); expect(Number(def?.[1])).toBeLessThanOrEqual(1200);
    expect(invoke).toContain("if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 1200) { throw");
    expect(invoke).toMatch(/\$drainDeadline = \$now\.AddSeconds\(/);
    expect(invoke).toContain('$child.Kill($true)');
    expect(invoke).toContain('Get-DescendantIds $table $child.Id $childStart');
    expect(invoke).toContain("Write-Host 'Running processes at the stall");
    expect(invoke).toContain("Write-Host 'Last child output before the stall:'");
    expect(invoke).toContain('throw "Pinned child timed out: $stall');
  });
  it('Build.ps1 publishes with no node reuse, no shared compilation and an explicit deadline well under the job limit',()=>{
    const call=build.split('\n').find(line=>line.startsWith("Invoke-Clean $Dotnet @('publish'"))??'';
    for (const flag of ["'-nodeReuse:false'","'-p:UseSharedCompilation=false'"]) expect(call).toContain(flag);
    const seconds=Number(call.match(/ -TimeoutSeconds:([0-9]+)$/)?.[1]);
    expect(seconds).toBeGreaterThan(0); expect(seconds).toBeLessThanOrEqual(1200);
  });
});
