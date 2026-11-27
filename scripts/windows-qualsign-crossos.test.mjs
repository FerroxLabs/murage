import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
const root=fileURLToPath(new URL('..',import.meta.url));
const inputs=readFileSync(join(root,'infra/windows-signing/collector/Inputs.ps1'),'utf8');
// Microsoft.NETCore.Native.Publish.targets (microsoft.dotnet.ilcompiler 10.0.15, line 63) fails a win-* publish with
// "Cross-OS native compilation is not supported" when $(OS) != 'Windows_NT'; MSBuild takes $(OS) from the %OS% environment variable,
// and the pinned publish child runs with a cleared allow-list environment.
describe('pinned publish child environment keeps MSBuild $(OS) native',()=>{
  it('sets OS=Windows_NT inside the Windows branch of Get-CleanEnvironment',()=>{
    const branch=inputs.slice(inputs.indexOf('if ($IsWindows) {'),inputs.indexOf('# The child environment is an allow-list'));
    expect(branch).toMatch(/\$environment\['OS'\]\s*=\s*'Windows_NT'/);
  });
  it('allows the OS name in the allow-list regex',()=>{
    const allow=inputs.match(/-cnotmatch '\\A\(([^']*)\)\\z'/)?.[1]??'';
    expect(allow.split('|')).toContain('OS');
  });
  it('allows no other name containing OS-like wildcard (allow-list stays closed)',()=>{
    const allow=inputs.match(/-cnotmatch '\\A\(([^']*)\)\\z'/)?.[1]??'';
    expect(allow).not.toMatch(/\.\*|\.\+|\\w\*/);
  });
});
