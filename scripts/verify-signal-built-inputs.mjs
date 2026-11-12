import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
// Account-free assembled-runtime verification; invoked only in the test container.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from "yaml";
import { spawnSync } from 'node:child_process';
import { stageRuntimeLicenses } from "../server/channels/signal/runtime-licenses.mjs";
import { verifyRuntimeTree } from '../server/channels/signal/runtime-integrity.mjs';
const output=resolve(process.argv[2]), pin=JSON.parse(readFileSync(new URL('../server/channels/signal/runtime-pin.json',import.meta.url)));
const fragments=Object.fromEntries(['darwin-arm64','win32-x64','linux-x64'].map(t=>[t,JSON.parse(readFileSync(join(output,`pin-fragment-${t}.json`)))]));
for(const [t,f] of Object.entries(fragments)){pin.targets[t]=f.record;pin.releaseInputs[t]=f.releaseInput;pin.signalNetwork.sha256=f.signalNetworkSha256;}
pin.g0=null;
const root=mkdtempSync(join(tmpdir(),'signal-built-inputs-'));
try {
  for(const [target,f] of Object.entries(fragments)){
    if (target==='win32-x64') {
      const config=parse(readFileSync(new URL('../electron-builder.yml',import.meta.url),'utf8'));
      const expected=Object.keys(f.record.integrity.executables).filter(p=>/\.exe$/i.test(p)).sort();
      const copies=config.win.extraResources.filter(r=>r.from?.startsWith('dist-native/signal-runtime/win32-x64/jre/')&&r.from.endsWith('.exe')).map(r=>r.from.slice('dist-native/signal-runtime/win32-x64/'.length)).sort();
      if(JSON.stringify(expected)!==JSON.stringify(copies))throw Error('Windows single-file copy list differs from pinned EXE inventory');
      console.log('WINDOWS_EXE_EXCLUSION',expected.length);
    }
    const runtime=join(root,target);mkdirSync(runtime);
    const archive=join(output,new URL(f.releaseInput.url).pathname.split('/').at(-1));
    const extracted=spawnSync('tar',['-xzf',archive,'-C',runtime],{encoding:'utf8',windowsHide:true});
    if(extracted.status!==0)throw Error(extracted.stderr);
    renameSync(join(runtime,'jdk'),join(runtime,'jre'));
    stageRuntimeLicenses(new URL('../licenses/signal-runtime/',import.meta.url),join(runtime,'licenses'),f.record.jars);
    const start=performance.now();const verified=await verifyRuntimeTree({root:runtime,pin,target});
    console.log('VERIFIED',target,(performance.now()-start).toFixed(1)+'ms');
    const scan=spawnSync('python3',['-c',`import pathlib,sys,zipfile,re
for p in pathlib.Path(sys.argv[1]).rglob('*.jar'):
 with zipfile.ZipFile(p) as z:
  assert not any(re.search(r'\\.(so|dll|dylib|jnilib)$',n,re.I) for n in z.namelist()),p
print('NO_NESTED_NATIVE')`,runtime],{encoding:'utf8',windowsHide:true});
    if(scan.status!==0)throw Error(scan.stderr);console.log(scan.stdout.trim());
    if(target==='linux-x64'){
      const javaHome=readFileSync(join(output,'first-build/java/build-jdk.home'),'utf8').trim();
      const classes=join(root,'classes'),scratch=join(root,'tmp');mkdirSync(classes);mkdirSync(scratch);
      const compiled=spawnSync(join(javaHome,'bin/javac'),['-d',classes,'scripts/signal-native-loaded.java'],{encoding:'utf8',windowsHide:true});
      if(compiled.status!==0)throw Error(compiled.stderr);
      const args=['--enable-native-access=ALL-UNNAMED',`-Djava.library.path=${verified.nativeDir}`,`-Dorg.sqlite.lib.path=${verified.nativeDir}`,'-Dorg.sqlite.lib.name=libsqlitejdbc.so',`-Djava.io.tmpdir=${scratch}`,'-cp',`${classes}:${runtime}/signal-cli.jar:${runtime}/lib/*`,'SignalNativeLoaded',runtime];
      const loaded=spawnSync(verified.java,args,{encoding:'utf8',windowsHide:true,timeout:30000,env:{PATH:join(javaHome,'bin'),HOME:root}});
      if(loaded.status!==0)throw Error(loaded.stderr);console.log(loaded.stdout.trim());
      const version=spawnSync(verified.java,['-Djava.library.path='+verified.nativeDir,'-jar',verified.jar,'--version'],{encoding:'utf8',windowsHide:true,timeout:30000,env:{PATH:join(javaHome,'bin'),HOME:root}});
      if(version.status!==0)throw Error(version.stderr);console.log(version.stdout.trim());
    }
  }
  writeFileSync(join(output,'candidate-pin.json'),JSON.stringify(pin,null,2)+'\n');
}finally{safeWipeSync(root);}
