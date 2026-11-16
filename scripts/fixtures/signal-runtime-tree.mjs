// Synthetic filesystem pinning for runtime integrity tests only.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { digest, treeRecords, treeDigest } from '../../server/channels/signal/runtime-tree.mjs';
import { executableFormat, normalizedDigest } from '../../server/channels/signal/binary-digest.mjs';
export function pinSyntheticTree(root, target, licenseRoot) {
  const rows = treeRecords(root, { exclude: ['g0', 'licenses', 'runtime-pin.json', 'signal.inventory.json'] });
  const directories = [];
  const walk = (dir, prefix='') => { for (const name of readdirSync(dir).sort()) {
    if (!prefix && ['g0','licenses'].includes(name)) continue;
    const path=join(dir,name), rel=prefix+name, st=lstatSync(path);
    if (st.isDirectory() && !st.isSymbolicLink()) { directories.push(rel); walk(path,rel+'/'); }
  } }; walk(root);
  const executables = {};
  for (const row of rows) if (row.sha256 && /^(jre|native)\//.test(row.path)) {
    const bytes=readFileSync(join(root,row.path)), format=executableFormat(bytes);
    if (format) executables[row.path]={sha256:row.sha256,normalizedSha256:normalizedDigest(bytes,format),format};
  }
  const jars = rows.filter(r=>r.path.endsWith('.jar')&&!r.path.startsWith('jre/')).map(({path,sha256})=>({path,sha256}));
  const natives=rows.filter(r=>r.path.startsWith('native/')).map(({path,sha256})=>({path,sha256,provenance:{kind:'upstream-jar',jar:jars[0].path,entry:path.split('/').at(-1),upstreamSha256:sha256}}));
  return {jars,natives,libsignal:{version:'0.106.1',sha256:natives.find(n=>n.path.includes('signal_jni')).sha256,provenance:natives.find(n=>n.path.includes('signal_jni')).provenance},
    jre:{build:'25.0.1+1',sha256:treeDigest(join(root,'jre')),provenance:{kind:'upstream-jre',url:'https://example.test/synthetic.tar.gz',sha256:digest('synthetic'),build:'25.0.1+1'}},
    integrity:{rows,directories:directories.sort(),executables,resigned:null,licenseRows:licenseRoot?treeRecords(licenseRoot):[]}};
}
