// Producer owner: winsac-qualsign-verifier. Receipt producer: winsac-qualsign-r2.
// Consumer owner: MAIN; supplies trusted git/API observations and the measured root pin.
import { createHash, X509Certificate } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

export const STRINGS = Object.freeze({
  usage: 'Usage: windows-qualsign-verify.mjs preapprove|verify|pin <input.json>',
  input: 'Qualification input rejected',
  preapprove: 'Qualification preapproval rejected',
  archive: 'Qualification archive rejected',
  receipt: 'Qualification receipt rejected',
  signer: 'Qualification signer rejected',
  verify: 'Qualification fetch rejected',
  deletion: 'delete-required',
});
export const BOUND_PATHS = Object.freeze({
  collector: 'infra/windows-signing/collector',
  signingProcess: 'infra/windows-signing/boundary/SigningProcess.cs',
  processApi: 'infra/windows-signing/boundary/WindowsSigningProcessApi.cs',
  plan: 'scripts/windows-signing-witness/plan.json',
  workflow: '.github/workflows/windows-qualsign.yml',
  helper: 'infra/windows-signing/qualsign/Write-QualsignReceipt.ps1',
  packs: 'infra/windows-signing/qualsign/packs.sha512.json',
});
export const IDENTITY = Object.freeze({
  subject: 'Ferrox Labs, LLC',
  issuerPrefix: 'Microsoft ID Verified CS AOC CA ',
  rootCn: 'Microsoft Identity Verification Root Certificate Authority 2020',
  ekus: Object.freeze(['1.3.6.1.5.5.7.3.3', '1.3.6.1.4.1.311.97.1.0', '1.3.6.1.4.1.311.97.694597467.326663264.393302725.691001577']),
});
const OIDC = Object.freeze({use_default:true, use_immutable_subject:true, sub_claim_prefix:'repo:FerroxLabs@282419864/murage@1353175124'});
const CONSTANTS = Object.freeze({schema:'qualsign-collector-v1', role:'qualification-collector', release:'HOLD', publication:'none', core:'PARTIAL', pass:false, guard:'qualsign-not-release-v1'});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha1 = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const positive = value => (Number.isSafeInteger(value) && value>0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value));
const keys = obj => Object.keys(obj).sort();
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const need = (ok, code) => { if (!ok) throw Error(STRINGS[code]); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(keys(value).map(k => [k,canonical(value[k])]));
  return value;
}
const recordHash = value => hash(JSON.stringify(canonical(value)));
function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  need(typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'input');
  const out = Buffer.from(value,'base64');
  need(out.toString('base64') === value, 'input');
  return out;
}
const gitBlob = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
function checkedObjects(objects) {
  need(objects && same(keys(objects),keys(BOUND_PATHS)) && Object.values(objects).every(sha1), 'preapprove');
  return objects;
}
function checkedWorkflows(workflows) {
  need(workflows && Object.keys(workflows).length > 0, 'preapprove');
  const blobs = {};
  for (const path of keys(workflows)) {
    need(/^\.github\/workflows\/(?!.*(?:\/\.|\/\/))[^\\:]+$/.test(path) && !path.split('/').includes('..'), 'preapprove');
    const entry = workflows[path], data = bytes(entry.bytes);
    need(sha1(entry.blob) && gitBlob(data) === entry.blob, 'preapprove');
    blobs[path] = entry.blob;
    if (!/\.ya?ml$/i.test(path)) continue;
    const doc = parseDocument(data.toString('utf8'), {uniqueKeys:true});
    need(doc.errors.length === 0, 'preapprove');
    const workflow = doc.toJS();
    need(workflow && typeof workflow === 'object' && workflow.jobs && typeof workflow.jobs === 'object', 'preapprove');
    if(path === BOUND_PATHS.workflow) need(workflow.jobs['sign-collector']?.environment === 'windows-qualsign', 'preapprove');
    for (const [id,job] of Object.entries(workflow.jobs)) {
      const env = job?.environment;
      const name = typeof env === 'string' ? env : env?.name;
      // Dynamic environment selection cannot prove this environment is exclusive.
      need(name === undefined || (typeof name === 'string' && !name.includes('${{') &&
        (name.trim().toLowerCase() !== 'windows-qualsign' || (name === 'windows-qualsign' && path === BOUND_PATHS.workflow && id === 'sign-collector'))), 'preapprove');
    }
  }
  return blobs;
}
function checkedNuget(configs) {
  need(configs && typeof configs === 'object' && !Array.isArray(configs), 'preapprove');
  for (const [path,blob] of Object.entries(configs)) {
    need(/(?:^|\/)nuget\.config$/i.test(path) && !path.startsWith('/') && !/[\\:]/.test(path) && !path.split('/').includes('..') && sha1(blob), 'preapprove');
  }
  return canonical(configs);
}
/** MAIN supplies complete workflow/config maps from both git trees, not a filtered diff.
 * {devSha,dev:{sha,objects,workflows,nugetConfigs},publicCommit:{sha,parents,ref,subject,
 * objects,workflows,nugetConfigs},oidcSubjectCustomization}. Workflow bytes are base64.
 */
export function preapprove(input) {
  try {
    const {devSha,dev,publicCommit:pub,oidcSubjectCustomization} = input;
    need(sha1(devSha) && dev.sha === devSha && sha1(pub.sha) && pub.sha !== devSha &&
      Array.isArray(pub.parents) && pub.parents.length === 1 && sha1(pub.parents[0]) &&
      /^ci\/try-[0-9a-f]{12}$/.test(pub.ref) && pub.subject === `QUALSIGN collector ${devSha}` &&
      same(canonical(oidcSubjectCustomization),canonical(OIDC)), 'preapprove');
    const objects = checkedObjects(dev.objects);
    need(same(canonical(objects),canonical(checkedObjects(pub.objects))), 'preapprove');
    const workflows = checkedWorkflows(dev.workflows), publicWorkflows = checkedWorkflows(pub.workflows);
    need(same(workflows,publicWorkflows) && workflows[BOUND_PATHS.workflow] === objects.workflow, 'preapprove');
    const nugetConfigs = checkedNuget(dev.nugetConfigs);
    need(same(nugetConfigs,checkedNuget(pub.nugetConfigs)), 'preapprove');
    const record = {schema:'qualsign-comparison-v1',devSha,publicSha:pub.sha,ref:pub.ref,parent:pub.parents[0],objects:canonical(objects),workflowBlobs:workflows,nugetConfigs,oidcSubjectCustomization:OIDC};
    return {...record,recordSha256:recordHash(record)};
  } catch { throw Error(STRINGS.preapprove); }
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const octet of data) {
    crc ^= octet;
    for (let n=0;n<8;n++) crc = (crc>>>1) ^ ((crc&1) ? 0xedb88320 : 0);
  }
  return (crc^0xffffffff)>>>0;
}
/** Strict, in-memory ZIP32 reader. Never extracts paths to disk. */
function unzip(zip, expected) {
  try {
    let end = zip.length-22;
    for (;end>=Math.max(0,zip.length-65557);end--) {
      if (zip.readUInt32LE(end) === 0x06054b50 && end+22+zip.readUInt16LE(end+20) === zip.length) break;
    }
    need(end>=0 && zip.readUInt32LE(end)===0x06054b50 && end+22+zip.readUInt16LE(end+20)===zip.length &&
      zip.readUInt16LE(end+4)===0 && zip.readUInt16LE(end+6)===0, 'archive');
    const count=zip.readUInt16LE(end+10), size=zip.readUInt32LE(end+12), start=zip.readUInt32LE(end+16);
    need(count===expected.length && zip.readUInt16LE(end+8)===count && start+size===end, 'archive');
    const result=new Map(), ranges=[];
    let at=start;
    for(let n=0;n<count;n++) {
      need(at+46<=end && zip.readUInt32LE(at)===0x02014b50, 'archive');
      const flags=zip.readUInt16LE(at+8), method=zip.readUInt16LE(at+10), crc=zip.readUInt32LE(at+16);
      const compressed=zip.readUInt32LE(at+20), length=zip.readUInt32LE(at+24), names=zip.readUInt16LE(at+28);
      const extra=zip.readUInt16LE(at+30), comment=zip.readUInt16LE(at+32), mode=zip.readUInt32LE(at+38)>>>16;
      const local=zip.readUInt32LE(at+42), nameBytes=zip.subarray(at+46,at+46+names), name=nameBytes.toString('utf8');
      need(at+46+names+extra+comment<=end && zip.readUInt16LE(at+34)===0 &&
        (flags&~0x808)===0 && [0,8].includes(method) && compressed!==0xffffffff && length!==0xffffffff &&
        expected.includes(name) && !result.has(name) && same(Buffer.from(name),nameBytes) &&
        !/[\\:/\x00]/.test(name) && (mode&0xf000)!==0xa000 && ((mode&0xf000)===0 || (mode&0xf000)===0x8000), 'archive');
      need(local+30<=start && zip.readUInt32LE(local)===0x04034b50 && zip.readUInt16LE(local+6)===flags && zip.readUInt16LE(local+8)===method, 'archive');
      const localNames=zip.readUInt16LE(local+26), localExtra=zip.readUInt16LE(local+28);
      need(zip.subarray(local+30,local+30+localNames).equals(nameBytes), 'archive');
      const dataStart=local+30+localNames+localExtra, dataEnd=dataStart+compressed;
      need(dataEnd<=start && dataStart<=dataEnd && length>0, 'archive');
      if (!(flags&8)) need(zip.readUInt32LE(local+14)===crc && zip.readUInt32LE(local+18)===compressed && zip.readUInt32LE(local+22)===length, 'archive');
      const packed=zip.subarray(dataStart,dataEnd);
      const data=method===0 ? packed : inflateRawSync(packed,{maxOutputLength:length});
      need(data.length===length && crc32(data)===crc, 'archive');
      let entryEnd=dataEnd;
      if(flags&8) {
        let descriptor=dataEnd;
        if(zip.readUInt32LE(descriptor)===0x08074b50) descriptor+=4;
        need(descriptor+12<=start && zip.readUInt32LE(descriptor)===crc && zip.readUInt32LE(descriptor+4)===compressed && zip.readUInt32LE(descriptor+8)===length, 'archive');
        entryEnd=descriptor+12;
      }
      ranges.push([local,entryEnd]); result.set(name,data);
      at+=46+names+extra+comment;
    }
    need(at===end, 'archive');
    ranges.sort((a,b)=>a[0]-b[0]);
    need(ranges[0][0]===0 && ranges.every((r,i)=>i===0 || r[0]===ranges[i-1][1]) && ranges.at(-1)[1]===start, 'archive');
    return result;
  } catch { throw Error(STRINGS.archive); }
}

// Definite-length DER only; boundaries are checked before every child is visited.
function der(data, start=0, limit=data.length) {
  need(start+2<=limit, 'signer');
  const tag=data[start]; let at=start+2, length=data[start+1];
  if(length&128) {
    const size=length&127;
    need(size>0 && size<=4 && at+size<=limit && data[at]!==0, 'signer');
    length=0; for(let n=0;n<size;n++) length=length*256+data[at++];
    need(length>=128, 'signer');
  }
  need(at+length<=limit, 'signer');
  return {tag,start,content:at,end:at+length,raw:data.subarray(start,at+length),value:data.subarray(at,at+length)};
}
function children(node) {
  const out=[]; let at=node.content;
  // node.raw is a view; use relative offsets to retain the checked parent boundary.
  while(at<node.end) {
    const child=der(node.raw,at-node.start,node.raw.length);
    out.push(child); at=node.start+child.end;
  }
  return out;
}
const sequence = node => { need(node.tag===0x30, 'signer'); return children(node); };
function oid(node) {
  need(node.tag===6 && node.value.length>0, 'signer');
  const values=[]; let value=0;
  for(const b of node.value) { value=value*128+(b&127); if(!(b&128)) { values.push(value); value=0; } }
  need((node.value.at(-1)&128)===0, 'signer');
  const first=values.shift(), head=first<40?0:first<80?1:2;
  return [head,first-head*40,...values].join('.');
}
function certParts(cert) {
  const top=sequence(der(cert.raw)), tbs=sequence(top[0]), offset=tbs[0].tag===0xa0?1:0;
  return {tbs,serial:tbs[offset],issuer:tbs[offset+2],subject:tbs[offset+4]};
}
function rdns(name) {
  const result={};
  for(const set of sequence(name)) {
    need(set.tag===0x31, 'signer');
    for(const attr of children(set)) {
      const pair=sequence(attr); need(pair.length===2, 'signer');
      const id=oid(pair[0]), value=pair[1];
      need([12,19,20,22,30].includes(value.tag), 'signer');
      let text;
      if(value.tag===30) {
        need(value.value.length%2===0, 'signer');
        text=''; for(let n=0;n<value.value.length;n+=2) text+=String.fromCharCode(value.value.readUInt16BE(n));
      } else text=value.value.toString(value.tag===12?'utf8':'latin1');
      (result[id]??=[]).push(text);
    }
  }
  return result;
}
function textRdns(text) {
  need(typeof text==='string' && text.length>0, 'receipt');
  const aliases={CN:'2.5.4.3',O:'2.5.4.10',OU:'2.5.4.11',C:'2.5.4.6',L:'2.5.4.7',S:'2.5.4.8',ST:'2.5.4.8',STREET:'2.5.4.9',STREETADDRESS:'2.5.4.9',POSTALCODE:'2.5.4.17',SERIALNUMBER:'2.5.4.5',E:'1.2.840.113549.1.9.1',EMAILADDRESS:'1.2.840.113549.1.9.1',DC:'0.9.2342.19200300.100.1.25',UID:'0.9.2342.19200300.100.1.1'};
  const parts=[];let token='',quoted=false,escaped=false;
  for(const char of text) {
    if(escaped) {token+=char;escaped=false;continue;}
    if(char==='\\') {token+=char;escaped=true;continue;}
    if(char==='"') quoted=!quoted;
    if(!quoted && [',','\n','+'].includes(char)) {parts.push(token);token='';} else token+=char;
  }
  need(!quoted && !escaped, 'receipt');parts.push(token);
  const result={};
  for(const part of parts) {
    const match=/^\s*([^=]+)=(.*)$/s.exec(part);need(match, 'receipt');
    const name=match[1].trim(), id=aliases[name.toUpperCase()]??name.replace(/^OID\./i,'');
    need(/^[0-9]+(?:\.[0-9]+)+$/.test(id), 'receipt');
    let value=match[2].trim();
    if(value.startsWith('"')) {need(value.endsWith('"'), 'receipt');value=value.slice(1,-1).replace(/""/g,'"');}
    value=value.replace(/\\([, +"\\<>;=#])/g,'$1');
    (result[id]??=[]).push(value);
  }
  return canonical(Object.fromEntries(Object.entries(result).map(([id,values])=>[id,values.sort()])));
}
const sameDn = (recorded,actual) => same(textRdns(recorded),textRdns(actual));
function oneRdn(name,key,expected) { const values=rdns(name)[key]; return values?.length===1 && values[0]===expected; }
const normalizedSerial = node => { need(node.tag===2 && node.value.length>0, 'signer'); return node.value.toString('hex').replace(/^(00)+/,''); };
/** Selects the actual primary signer by issuer AND serial, never the bag's first cert. */
function embeddedSigner(image) {
  need(image.length>=64 && image.readUInt16LE(0)===0x5a4d, 'signer');
  const pe=image.readUInt32LE(0x3c), optional=pe+24;
  need(pe>=64 && optional+152<=image.length && image.readUInt32LE(pe)===0x4550 && image.readUInt16LE(pe+20)>=152 &&
    optional+image.readUInt16LE(pe+20)<=image.length && image.readUInt16LE(optional)===0x20b && image.readUInt32LE(optional+108)>=5, 'signer');
  const start=image.readUInt32LE(optional+144), size=image.readUInt32LE(optional+148);
  need(start%8===0 && start>=optional+image.readUInt16LE(pe+20) && size>=8 && start+size<=image.length, 'signer');
  const length=image.readUInt32LE(start);
  need(length>=8 && Math.ceil(length/8)*8===size && image.readUInt16LE(start+4)===0x200 && image.readUInt16LE(start+6)===2, 'signer');
  const data=image.subarray(start+8,start+length), content=der(data);
  need(content.end===data.length || (length%8===0 && data.length-content.end<8 && data.subarray(content.end).every(byte=>byte===0)), 'signer');
  const info=sequence(content);
  need(info.length===2 && oid(info[0])==='1.2.840.113549.1.7.2' && info[1].tag===0xa0, 'signer');
  const wrapped=children(info[1]); need(wrapped.length===1, 'signer');
  const signed=sequence(wrapped[0]);
  need(signed.length>=5 && signed[3].tag===0xa0 && signed.at(-1).tag===0x31, 'signer');
  const certs=[...new Map(children(signed[3]).map(node=>{const cert=new X509Certificate(node.raw);return [hash(cert.raw),cert];})).values()];
  const signers=children(signed.at(-1)); need(signers.length===1, 'signer');
  const signer=sequence(signers[0]), sid=sequence(signer[1]);
  need(sid.length===2, 'signer');
  const matches=certs.filter(cert=>{const parts=certParts(cert); return normalizedSerial(parts.serial)===normalizedSerial(sid[1]) && parts.issuer.raw.equals(sid[0].raw);});
  need(matches.length===1, 'signer');
  return {leaf:matches[0],certs};
}
function buildChain(leaf,certs) {
  const chain=[leaf], used=new Set([hash(leaf.raw)]);
  while(!chain.at(-1).checkIssued(chain.at(-1))) {
    const current=chain.at(-1), issuers=certs.filter(cert=>!used.has(hash(cert.raw)) && current.checkIssued(cert) && current.verify(cert.publicKey));
    need(issuers.length===1 && issuers[0].ca, 'signer');
    chain.push(issuers[0]); used.add(hash(issuers[0].raw));
  }
  need(chain.length>=3 && chain.at(-1).verify(chain.at(-1).publicKey), 'signer');
  return chain;
}
/** G6 uses parsed RDNs, a verified certificate chain and a separately measured root pin.
 * This repeats identity checks; Windows signtool remains the Authenticode trust gate.
 */
export function verifySignerIdentity({leaf:leafBytes,certificates,expected}) {
  try {
    need(expected && expected.subject===IDENTITY.subject && expected.issuerPrefix===IDENTITY.issuerPrefix &&
      expected.rootCn===IDENTITY.rootCn && sha256(expected.rootSha256) && Array.isArray(expected.ekus) && same([...expected.ekus].sort(),[...IDENTITY.ekus].sort()), 'signer');
    const leaf=new X509Certificate(bytes(leafBytes));
    const certs=[...new Map(certificates.map(value=>{const cert=new X509Certificate(bytes(value));return [hash(cert.raw),cert];})).values()];
    const parts=certParts(leaf), subject=rdns(parts.subject), issuer=rdns(parts.issuer);
    need(subject['2.5.4.3']?.length===1 && subject['2.5.4.3'][0]===expected.subject && oneRdn(parts.subject,'2.5.4.10',expected.subject) &&
      issuer['2.5.4.3']?.length===1 && /^Microsoft ID Verified CS AOC CA [0-9]{2}$/.test(issuer['2.5.4.3'][0]) &&
      oneRdn(parts.issuer,'2.5.4.10','Microsoft Corporation') && !leaf.ca, 'signer');
    const chain=buildChain(leaf,certs), root=chain.at(-1), ekus=leaf.keyUsage??[];
    need(oneRdn(certParts(root).subject,'2.5.4.3',expected.rootCn) && hash(root.raw)===expected.rootSha256 &&
      expected.ekus.every(eku=>ekus.includes(eku)) &&
      !ekus.some(eku=>eku.startsWith('1.3.6.1.4.1.311.97.') && !expected.ekus.includes(eku)), 'signer');
    return {leafDerSha256:hash(leaf.raw),subject:leaf.subject,issuer:leaf.issuer,chainSubjects:chain.map(cert=>cert.subject),ekus,notBefore:leaf.validFrom,notAfter:leaf.validTo};
  } catch { throw Error(STRINGS.signer); }
}

/** Inputs: preapproval (same input as preapprove), comparisonRecordSha256, run
 * {id,attempt,publicSha,repository,workflowPath,conclusion}, artifacts (complete API list,
 * each {id,name,runId,attempt,digest,expired,zip}), jobOutputs {signed_sha256,receipt_sha256},
 * contentHashes {lockFileSha256,packsSha256}, identity (IDENTITY plus measured rootSha256).
 * API IDs may be safe positive integers or decimal strings; record IDs are strings.
 * zip is a Buffer or canonical base64. No caller-provided verification boolean is trusted.
 */
export function verifyFetched(input) {
  const comparison=preapprove(input.preapproval), {run,artifacts,jobOutputs,contentHashes} = input;
  need(input.comparisonRecordSha256===comparison.recordSha256 && positive(run.id) && positive(run.attempt) &&
    run.publicSha===comparison.publicSha && run.workflowPath===BOUND_PATHS.workflow && run.conclusion==='success' &&
    typeof run.repository==='string' && run.repository.length>0 && Array.isArray(artifacts) && artifacts.length===2, 'verify');
  const prefix=comparison.devSha.slice(0,12), names=[`qualsign-signed-${prefix}-${run.attempt}`,`qualsign-collector-${prefix}-${run.attempt}`];
  need(same(artifacts.map(a=>a.name).sort(),[...names].sort()) && artifacts.every(a=>positive(a.id) && positive(a.runId) && positive(a.attempt) && String(a.runId)===String(run.id) && String(a.attempt)===String(run.attempt) && a.expired===false) && String(artifacts[0].id)!==String(artifacts[1].id), 'verify');
  const entries=names.map((name,index)=>{
    const artifact=artifacts.find(a=>a.name===name), zip=bytes(artifact.zip);
    need(artifact.digest===`sha256:${hash(zip)}`, 'verify');
    return unzip(zip,index===0?['witness-collector.exe']:['witness-collector.exe','qualsign-receipt.json']);
  });
  const executable=entries[1].get('witness-collector.exe'), receiptBytes=entries[1].get('qualsign-receipt.json');
  let receipt; try { receipt=JSON.parse(receiptBytes.toString('utf8').replace(/^\uFEFF/,'')); } catch { throw Error(STRINGS.receipt); }
  need(Object.entries(CONSTANTS).every(([key,value])=>receipt[key]===value) && receipt.devSha===comparison.devSha && receipt.publicSha===comparison.publicSha &&
    same(canonical(receipt.treeHashes),canonical(comparison.objects)) && receipt.runId===String(run.id) && receipt.runAttempt===String(run.attempt) &&
    receipt.repository===run.repository && receipt.workflowPath===run.workflowPath && receipt.job==='verify-collector' && receipt.signedArtifactName===names[0] &&
    receipt.sdkVersion==='10.0.115' && receipt.signtoolExit===0, 'receipt');
  need(['dotnetSha256','lockFileSha256','packsSha256','unsignedSha256','signedSha256','leafDerSha256','signtoolSha256'].every(key=>sha256(receipt[key])) &&
    contentHashes && sha256(contentHashes.lockFileSha256) && sha256(contentHashes.packsSha256) &&
    receipt.lockFileSha256===contentHashes.lockFileSha256 && receipt.packsSha256===contentHashes.packsSha256 &&
    receipt.signedSha256===hash(executable) && receipt.signedSha256===hash(entries[0].get('witness-collector.exe')) &&
    receipt.signedSha256!==receipt.unsignedSha256 && receipt.signedSha256===jobOutputs.signed_sha256 && hash(receiptBytes)===jobOutputs.receipt_sha256, 'receipt');
  need(typeof receipt.signtoolPath==='string' && /^[A-Za-z]:\\Program Files(?: \(x86\))?\\Windows Kits\\10\\bin\\[0-9.]+\\x64\\signtool\.exe$/i.test(receipt.signtoolPath), 'receipt');
  const {leaf,certs}=embeddedSigner(executable);
  const identity=verifySignerIdentity({leaf:leaf.raw,certificates:certs.map(cert=>cert.raw),expected:input.identity});
  // Compare DN values across Windows and Node rendering without pinning addresses.
  need(identity.leafDerSha256===receipt.leafDerSha256 && sameDn(receipt.subject,identity.subject) && sameDn(receipt.issuer,identity.issuer) &&
    Array.isArray(receipt.chainSubjects) && receipt.chainSubjects.length===identity.chainSubjects.length &&
    receipt.chainSubjects.every((dn,n)=>sameDn(dn,identity.chainSubjects[n])) &&
    Number.isFinite(Date.parse(receipt.notBefore)) && Date.parse(receipt.notBefore)===Date.parse(identity.notBefore) &&
    Number.isFinite(Date.parse(receipt.notAfter)) && Date.parse(receipt.notAfter)===Date.parse(identity.notAfter) && Array.isArray(receipt.ekus) && same([...receipt.ekus].sort(),[...identity.ekus].sort()), 'receipt');
  return {status:'verified',collectorSha256:hash(executable),receiptSha256:hash(receiptBytes),comparisonRecordSha256:comparison.recordSha256,devSha:comparison.devSha,runId:String(run.id),attempt:String(run.attempt),artifactIds:artifacts.map(a=>String(a.id)).sort()};
}
/** Re-verifies bytes before considering deletion observations; returns no pin on failure. */
export function pinRecord(input) {
  try {
    const verified=verifyFetched(input), deletions=input.deletions;
    need(Array.isArray(deletions) && deletions.length===2 && same(deletions.map(d=>String(d.id)).sort(),verified.artifactIds) &&
      deletions.every(d=>positive(d.id) && [204,404].includes(d.deleteStatus) && d.getStatus===404), 'verify');
    const {artifactIds,status,...pin}=verified;
    return {...pin,core:'PARTIAL',pass:false,use:'witness-host-only'};
  } catch { return {status:STRINGS.deletion}; }
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [, ,command,file,...extra]=process.argv;
  if(!['preapprove','verify','pin'].includes(command) || !file || extra.length) {
    console.error(STRINGS.usage); process.exitCode=64;
  } else {
    try {
      const input=JSON.parse(readFileSync(file,'utf8'));
      const result=({preapprove,verify:verifyFetched,pin:pinRecord})[command](input);
      console.log(JSON.stringify(result));
      if(result.status===STRINGS.deletion) process.exitCode=2;
    } catch(error) {
      console.error(Object.values(STRINGS).includes(error.message)?error.message:STRINGS.input);
      process.exitCode=1;
    }
  }
}
