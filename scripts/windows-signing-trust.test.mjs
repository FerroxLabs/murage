// Policy/fake witness owner: win-sac-sign; real Public Trust enrollment and Windows chain witness owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { peSha256, signPinnedWindowsPe, verifyFrozenWindowsPe } from "./windows-pe-signing.mjs";
import { requireWindowsPublisherPolicy, windowsSigningTrust } from "./windows-signing-trust.mjs";
import { fixturePeSource, fixtureRevision } from "./fixtures/windows-pe-provenance.mjs";
import { unsignedPeFixture, appendPeFixtureCertificate } from "./fixtures/windows-pe-signing.mjs";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const policy = { profile: "Public Trust", subjectDn: "CN=Fixture Publisher, O=Fixture", issuerDn: "CN=Fixture Issuer", profileEku: "1.2.3.4" };
const verdict = leaf => ({ status: "Valid", embedded: true, timestamp: true, publisher: "Ferrox Labs, LLC",
  subjectDn: policy.subjectDn, issuerDn: policy.issuerDn, ekus: ["1.3.6.1.5.5.7.3.3",policy.profileEku], leafCertificateSha256: leaf.repeat(64) });
it("accepts rotated leaves under the same durable subject, production EKU and issuer", () => {
  expect(requireWindowsPublisherPolicy(verdict("a"), policy)).toBe("a".repeat(64));
  expect(requireWindowsPublisherPolicy(verdict("b"), policy)).toBe("b".repeat(64));
});
export const policyMutations = [
  ["untrusted", v => { v.status="NotTrusted"; }], ["catalog", v => { v.embedded=false; }],
  ["timestamp", v => { v.timestamp=false; }], ["same CN wrong subject", v => { v.subjectDn="CN=Fixture Publisher"; }],
  ["issuer change", v => { v.issuerDn="CN=Other Fixture Issuer"; }],
  ["test profile EKU", v => { v.ekus=["1.2.3.5"]; }], ["private EKU", v => { v.ekus=[]; }],
  ["missing EKU", v => { delete v.ekus; }], ["missing leaf", v => { delete v.leafCertificateSha256; }],
  ["SHA1 leaf", v => { v.leafCertificateSha256="a".repeat(40); }],
];
it.each(policyMutations)("refuses %s even with the same publisher display name", (_name, mutate) => {
  const data=verdict("a"); mutate(data);
  expect(() => requireWindowsPublisherPolicy(data,policy)).toThrow("WINDOWS_SIGNING_PUBLISHER_POLICY_REJECTED");
});
it.each([undefined, { ...policy,profile:"Public Trust Test" }, { ...policy,profileEku:"" }, { ...policy,subjectDn:"" }, { ...policy,issuerDn:"" }])("refuses missing/unenrolled production policy %j", value => {
  expect(() => requireWindowsPublisherPolicy(verdict("a"),value)).toThrow("WINDOWS_SIGNING_PUBLISHER_POLICY_REJECTED");
});
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"signing-trust-")); roots.push(root);
  const file=path.join(root,"signtool.exe");fs.writeFileSync(file,"fixture verify tool");
  const pin={ path:file,sha256:peSha256(fs.readFileSync(file)),signer:"Fixture Tool Publisher" };
  const checker={path:path.join(root,"checker.exe"),sha256:"c".repeat(64),attestation:path.join(root,"checker-attestation.json"),attestationSha256:"d".repeat(64)};
  const launch={environment:{PATH:"fixture pinned tool directory",NODE_OPTIONS:"",PSModulePath:""},checker,
    files:[{path:file,sha256:pin.sha256}],signingAuthority:{enrolled:true,publisherPolicy:policy,
      executables:{signtool:pin,checker},checker:{attestationSha256:checker.attestationSha256}}};
  const tool={status:"Valid",embedded:true,publisher:pin.signer};
  const loadChecker=vi.fn(async()=>({authenticode:vi.fn(async target=> target===file ? tool : verdict("a"))}));
  const run=vi.fn(async()=>({stdout:"verified"}));
  return {root,file,launch,pin,tool,loadChecker,run,load:()=>windowsSigningTrust(launch,{run,loadChecker})};
}
it("runs the independent pinned second gate with exact argv and a credential-free explicit environment",async()=>{
  const f=fixture(),trust=await f.load();await trust.verifySigned("fixture.exe",verdict("a"));
  expect(f.run).toHaveBeenCalledExactlyOnceWith(f.file,["verify","/pa","/all","/v","/tw","fixture.exe"],
    expect.objectContaining({shell:false,env:f.launch.environment}));
  expect(f.loadChecker).toHaveBeenCalledWith(expect.objectContaining({MURAGE_WINDOWS_TRUST_CHECKER:f.launch.checker.path}));
});
it.each(["policy","tool-hash","tool-signer","tool-catalog","tool-status","exit","post-run-hash","post-run-signer"])("refuses %s without accepting a successful earlier verification",async change=>{
  const f=fixture(),trust=await f.load(),data=verdict("a");
  if(change==="policy") data.issuerDn="wrong";
  if(change==="tool-hash")fs.appendFileSync(f.file,"changed");
  if(change==="tool-signer")f.tool.publisher="wrong";
  if(change==="tool-catalog")f.tool.embedded=false;
  if(change==="tool-status")f.tool.status="NotTrusted";
  if(change==="exit")f.run.mockRejectedValue(Error("private diagnostic"));
  if(change==="post-run-hash")f.run.mockImplementation(async()=>{fs.appendFileSync(f.file,"changed");});
  if(change==="post-run-signer")f.run.mockImplementation(async()=>{f.tool.publisher="wrong";});
  await expect(trust.verifySigned("fixture.exe",data)).rejects.toThrow();
  if(["policy","tool-hash","tool-signer","tool-catalog","tool-status"].includes(change))expect(f.run).not.toHaveBeenCalled();
});
it.each(["lock","unenrolled","checker-path","checker-hash","attestation","tool"])("refuses unbound %s authority before executing anything",async change=>{
  const f=fixture();
  if(change==="lock")delete f.launch.signingAuthority;
  if(change==="unenrolled")f.launch.signingAuthority.enrolled=false;
  if(change==="checker-path")f.launch.checker={...f.launch.checker,path:"other.exe"};
  if(change==="checker-hash")f.launch.checker={...f.launch.checker,sha256:"e".repeat(64)};
  if(change==="attestation")f.launch.checker={...f.launch.checker,attestationSha256:"e".repeat(64)};
  if(change==="tool")f.launch.files=[];
  await expect(f.load()).rejects.toThrow("WINDOWS_SIGNING_TRUST_AUTHORITY_REQUIRED");
  expect(f.run).not.toHaveBeenCalled();expect(f.loadChecker).not.toHaveBeenCalled();
});
it("records the actual per-file leaf and rechecks that pair without invoking the provider on frozen bytes",async()=>{
  const f=fixture(),file=path.join(f.root,"Murage.exe"),bytes=unsignedPeFixture();fs.writeFileSync(file,bytes);
  const pin=fixturePeSource("Murage.exe",bytes,{kind:"build",component:"murage-app",sourceRevision:fixtureRevision,inputs:[{component:"source",sha256:"e".repeat(64)}],transformations:["fixture compile"]});
  let leaf="a";
  const trust={authenticode:async()=>fs.readFileSync(file).readUInt32LE(232) ? verdict(leaf) : {status:"NotSigned"},verifySigned:vi.fn(async()=>{})};
  const sign=vi.fn(async()=>{fs.writeFileSync(file,appendPeFixtureCertificate(bytes));return true;});
  const record=await signPinnedWindowsPe(file,pin,trust,sign,{sourceRevision:fixtureRevision});
  expect(record.leafCertificateSha256).toBe("a".repeat(64));expect(record.nativeVerdictSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(trust.verifySigned).toHaveBeenCalledOnce();
  await verifyFrozenWindowsPe(file,pin,record,trust);expect(sign).toHaveBeenCalledOnce();
  leaf="b";await expect(verifyFrozenWindowsPe(file,pin,record,trust)).rejects.toThrow("WINDOWS_PE_CERTIFICATE_MISMATCH");
});
it("does not return a signed record when the second gate refuses",async()=>{
  const f=fixture(),file=path.join(f.root,"Murage.exe"),bytes=unsignedPeFixture();fs.writeFileSync(file,bytes);
  const pin=fixturePeSource("Murage.exe",bytes);
  const trust={authenticode:async()=>fs.readFileSync(file).readUInt32LE(232)?verdict("a"):{status:"NotSigned"},verifySigned:async()=>{throw Error("SECOND_GATE_REFUSAL");}};
  await expect(signPinnedWindowsPe(file,pin,trust,async()=>{fs.writeFileSync(file,appendPeFixtureCertificate(bytes));return true;})).rejects.toThrow("SECOND_GATE_REFUSAL");
});
