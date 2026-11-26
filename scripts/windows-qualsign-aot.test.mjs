import {readdirSync,readFileSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
const root=fileURLToPath(new URL('..',import.meta.url));
const collector=join(root,'infra/windows-signing/collector');
const walk=dir=>readdirSync(dir).flatMap(name=>{const path=join(dir,name);return statSync(path).isDirectory()?(name==='fixtures'?[]:walk(path)):[path];});
const compiled=[...walk(collector).filter(path=>path.endsWith('.cs')&&!path.endsWith('.selfcheck.cs')),join(root,'infra/windows-signing/boundary/SigningProcess.cs'),join(root,'infra/windows-signing/boundary/WindowsSigningProcessApi.cs')];
describe('collector NativeAOT/trim safety',()=>{
  it('compiled sources use no reflection-based JsonSerializer call',()=>{
    for(const path of compiled) expect({path:relative(root,path),hits:readFileSync(path,'utf8').match(/JsonSerializer\s*\.\s*(?:Serialize|Deserialize)\w*|Activator\s*\.\s*CreateInstance|Assembly\s*\.\s*Load/g)}).toEqual({path:relative(root,path),hits:null});
  });
  it('analyzer findings are never suppressed',()=>{
    const text=[...compiled,join(collector,'WitnessCollector.csproj')].map(path=>readFileSync(path,'utf8')).join('\n');
    expect(text).not.toMatch(/UnconditionalSuppressMessage|NoWarn|TrimmerRootAssembly|TrimmerRootDescriptor|SuppressTrimAnalysisWarnings|SuppressAotAnalysisWarnings|#pragma\s+warning\s+disable\s+IL/);
  });
  it('the Linux analyzer gate pins the SDK, the locked restore and warnings as errors',()=>{
    const gate=readFileSync(join(collector,'Aot.analyze.sh'),'utf8');
    for(const needle of ['--locked-mode','-warnaserror','EnableTrimAnalyzer=true','EnableAotAnalyzer=true','10.0.115','sha512sum','--entrypoint bash','dotnet/sdk@sha256:']) expect(gate).toContain(needle);
  });
});
