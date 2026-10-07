import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
const result=spawnSync('pnpm',['exec','cap','sync'],{stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
const version=JSON.parse(readFileSync('package.json','utf8')).dependencies['@capacitor/ios'];
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Native SDK must be pinned');
const path='ios/App/CapApp-SPM/Package.swift';
writeFileSync(path,readFileSync(path,'utf8').replace(/(capacitor-swift-pm\.git", )from: "[^"]+"/,`$1exact: "${version}"`));
