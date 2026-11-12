// Host-only Docker attestation. Probe output alone cannot attest topology or control reachability.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
const [network,proxy,probe,out,sha,control='example.com',mutant='none']=process.argv.slice(2);
if(existsSync('/.dockerenv'))throw Error('attest must run on the host');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:45000}).trim();
const inspect=(...args)=>JSON.parse(docker(...args))[0];
const start=Date.now(),allowlist=JSON.parse(readFileSync(new URL('./allowlist.json',import.meta.url)));
const controlResult=JSON.parse(docker('exec',proxy,'node','/egress/probe.mjs','control',mutant==='unreachable'?'control-unreachable.invalid':control));
const probeResult=JSON.parse(docker('exec',probe,'node','/egress/probe.mjs','run',proxy,control,controlResult.ip??'192.0.2.1',allowlist[1]));
const topology=inspect('network','inspect',network), probeInspect=inspect('inspect',probe);
const report={schema:1,producedBy:'attest.mjs',host:{name:hostname(),inContainer:false,pid:process.pid},candidateSha:sha,
 allowlistHash:createHash('sha256').update(readFileSync(new URL('./allowlist.json',import.meta.url))).digest('hex'),
 start,end:Date.now(),network:{name:network,internal:topology.Internal,containers:Object.values(topology.Containers??{}).map(x=>x.Name).sort()},
 proxy,probe,probeDns:probeInspect.HostConfig.Dns,probeNetworks:Object.keys(probeInspect.NetworkSettings.Networks).sort(),control:controlResult,...probeResult,runStart:start,runEnd:Date.now(),mutant};
writeFileSync(out,JSON.stringify(report,null,2)+'\n');
