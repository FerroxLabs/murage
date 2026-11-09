#!/usr/bin/env bash
set -euo pipefail
# Production parser parity. The release operator supplies an evidence-backed native contract.
# No process is killed and no application data is read or changed by this probe.
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Mac update release gate requires macOS.' >&2
  exit 2
fi
: "${MURAGE_MACWD_EXEC_PATH:?packaged Murage executable required}"
: "${MURAGE_MACWD_HOME:?home context for owned ShipIt classification required}"
: "${MURAGE_MACWD_NATIVE_EVIDENCE:?pinned native lifetime evidence JSON required}"
node --test electron/mac-install-guard.node-test.mjs
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
import {shipItState,SHIPIT_ARGV} from './electron/mac-install-guard.mjs';
const evidence=JSON.parse(readFileSync(process.env.MURAGE_MACWD_NATIVE_EVIDENCE,'utf8'));
for(const key of ['P6a','P6c','P6d','P6e','P6f','completeOutput']) {
 if(typeof evidence[key]?.source!=='string'||!evidence[key].source||evidence[key].faultPassed!==true)throw Error('Missing native evidence: '+key);
}
if(!evidence.electronRevision||!evidence.squirrelRevision||!evidence.helperRevision)throw Error('Pinned native revisions required');
const result=shipItState({execPath:process.env.MURAGE_MACWD_EXEC_PATH,home:process.env.MURAGE_MACWD_HOME,supported:true});
console.log(JSON.stringify({command:'/bin/ps',argv:SHIPIT_ARGV,state:result,executable:process.env.MURAGE_MACWD_EXEC_PATH}));
if(result==='error'||result==='foreign')process.exitCode=1;
JS
