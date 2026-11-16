// Receipt tests and builder witness adapters owner: win-sac-sign; controlled Windows witness execution owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { peSha256 } from "./windows-pe-signing.mjs";
import { windowsSigningReceipt, verifyWindowsSigningReceipt } from "./windows-signing-receipt.mjs";
import { receiptFixture } from "./fixtures/windows-signing-receipt.mjs";
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
export const headerViolations=[
  ["extra header",f=>{f.configuration.extra=true;}],["missing identity field",f=>{delete f.configuration.identity.runAttempt;}],
  ...["repositoryId","runId","runAttempt","workflowSha","sourceRevision","target","version"].map(key=>["identity "+key,f=>{f.configuration.identity[key]="invalid";}]),
  ["artifact ID",f=>{f.configuration.authority.inputArtifactId="0";}],["numeric artifact ID",f=>{f.configuration.authority.inputArtifactId=1;}],
  ["numeric run ID",f=>{f.configuration.identity.runId=1;}],["authority digest",f=>{f.configuration.authority.checkerSha256="invalid";}],
  ["empty coverage",f=>{f.coverage=[];}],["missing scope coverage",f=>{f.coverage.pop();}],
  ["duplicate PE",f=>{f.coverage.push({...f.coverage[0]});}],["case collision",f=>{f.coverage.push({...f.coverage[0],path:f.coverage[0].path.toUpperCase()});}],
  ["coverage traversal",f=>{f.coverage[0].path="../fixture.exe";}],["unknown scope",f=>{f.coverage[0].scope="unknown";}],
  ["missing producer flag",f=>{delete f.coverage[0].producerRequired;}],["nonboolean producer flag",f=>{f.coverage[0].producerRequired="yes";}],
];
it.each(headerViolations)("refuses %s before admitting operations",(_name,mutate)=>{
  const f=receiptFixture(roots);mutate(f);expect(()=>windowsSigningReceipt(f.configuration,f.coverage)).toThrow();
});
it("emits a validated dependency graph from real common signing calls and gated fake build operations",async()=>{
  const f=receiptFixture(roots);await f.build();const result=await f.complete(),bytes=fs.readFileSync(f.receiptFile);
  expect(result.sha256).toBe(peSha256(bytes));expect(verifyWindowsSigningReceipt(bytes,f.configuration,f.coverage)).toEqual(result.receipt);
  const at=event=>f.calls.indexOf(event);
  expect(at("sign:gepa")).toBeLessThan(at("freeze:gepa"));expect(at("freeze:gepa")).toBeLessThan(at("package:app"));
  expect(at("freeze:app")).toBeLessThan(at("package:installer"));expect(at("freeze:uninstaller")).toBeLessThan(at("package:installer"));
  expect(at("freeze:installer")).toBeLessThan(at("package:complete"));expect(at("package:complete")).toBeLessThan(at("verify:final"));
  expect(f.calls).not.toContain("provider:transient");expect(result.receipt.events.some(row=>row.event==="preserve"&&row.scope==="transient")).toBe(true);
});
export const orderViolations=[
  ["package before GEPA freeze",async f=>f.writer.package("app",f.action)],
  ["freeze before signing",async f=>f.writer.freeze("gepa",f.action)],
  ["producer before app begin",async f=>f.writer.producer("app","Murage.exe",f.action)],
  ["sign before producer",async f=>{await f.prepare("gepa");await f.writer.package("app",async()=>f.writer.sign("app","Murage.exe","d".repeat(64),f.action));}],
  ["installer before uninstaller freeze",async f=>{await f.prepare("gepa");await f.writer.package("app",async()=>f.writer.package("installer",f.action));}],
  ["re-sign frozen GEPA",async f=>{await f.prepare("gepa");await f.writer.sign("gepa",f.coverage[0].path,"d".repeat(64),f.action);}],
  ["undeclared PE",async f=>f.writer.sign("gepa","extra.exe","d".repeat(64),f.action)],
  ["wrong scope",async f=>f.writer.sign("app",f.coverage[0].path,"d".repeat(64),f.action)],
  ["incomplete package",async f=>f.writer.packageComplete(f.action)],
];
it.each(orderViolations)("refuses %s before the operation runs",async(_name,operation)=>{
  const f=receiptFixture(roots);f.action=vi.fn();await expect(operation(f)).rejects.toThrow("WINDOWS_SIGNING_RECEIPT_REJECTED");expect(f.action).not.toHaveBeenCalled();
  await expect(f.writer.sign("gepa",f.coverage[0].path,"d".repeat(64),vi.fn())).rejects.toThrow();
});
it.each(["app","uninstaller","transient"])("requires the %s freeze independently before installer compilation",async missing=>{
  const f=receiptFixture(roots);await f.prepare("gepa");const compile=vi.fn();
  await expect(f.writer.package("app",async()=>{
    for(const scope of ["app","uninstaller","transient"]){await f.produce(scope);await f.sign(scope);if(scope!==missing)await f.freeze(scope);}
    await f.writer.package("installer",compile);
  })).rejects.toThrow();expect(compile).not.toHaveBeenCalled();
});
it("checks the producer's pre-sign hash before invoking the signer",async()=>{
  const f=receiptFixture(roots);await f.prepare("gepa");const signer=vi.fn();
  await f.writer.package("app",async()=>{
    await f.produce("app");await expect(f.writer.sign("app","Murage.exe","f".repeat(64),signer)).rejects.toThrow();
  });expect(signer).not.toHaveBeenCalled();
});
it("refuses the complete marker while the builder operation is still active even after every freeze",async()=>{
  const f=receiptFixture(roots);await f.prepare("gepa");const complete=vi.fn();
  await expect(f.writer.package("app",async()=>{
    await f.prepare("app");await f.prepare("uninstaller");await f.prepare("transient");
    await f.writer.package("installer",async()=>f.prepare("installer"));
    await f.writer.packageComplete(complete);
  })).rejects.toThrow();expect(complete).not.toHaveBeenCalled();
});
it("requires installer freeze before package-complete and rejects duplicate sign/freeze operations",async()=>{
  const f=receiptFixture(roots);await f.prepare("gepa");const action=vi.fn();
  await f.writer.package("app",async()=>{
    await f.prepare("app");await f.prepare("uninstaller");await f.prepare("transient");
    await f.writer.package("installer",async()=>{await f.produce("installer");await f.sign("installer");});
  });await expect(f.writer.packageComplete(action)).rejects.toThrow();expect(action).not.toHaveBeenCalled();
  const r=receiptFixture(roots);await r.produce("gepa");await r.sign("gepa");
  await expect(r.writer.sign("gepa",r.coverage[0].path,r.pins.get("gepa").sourceSha256,action)).rejects.toThrow();expect(action).not.toHaveBeenCalled();
  const p=receiptFixture(roots);await p.prepare("gepa");await expect(p.writer.freeze("gepa",action)).rejects.toThrow();expect(action).not.toHaveBeenCalled();
});
export const receiptViolations=[
  ["header",r=>{r.identity.runAttempt="2";}],["authority",r=>{r.authority.checkerSha256="d".repeat(64);}],["incomplete",r=>{r.complete=false;}],
  ["sequence",r=>{r.events[0].seq=2;rechain(r);}],["rewrite chain",r=>{r.events[1].previousEventSha256="e".repeat(64);}],
  ["omit event",r=>{r.events.splice(2,1);}],["duplicate event",r=>{r.events.splice(2,0,r.events[1]);}],
  ["reorder event",r=>{[r.events[0],r.events[1]]=[r.events[1],r.events[0]];}],["unknown event",r=>{r.events[0].event="approved";}],
  ["unknown field",r=>{r.events[0].approved=true;}],["installer result",r=>{r.result.installerSha256="f".repeat(64);}],
  ["retained uninstaller record",r=>{r.result.uninstallerRecordSha256="f".repeat(64);}],["no final verification",r=>{r.events.pop();}],
  ["rewritten reordered graph",r=>{[r.events[1],r.events[2]]=[r.events[2],r.events[1]];r.events.forEach((row,i)=>{row.seq=i+1;});rechain(r);}],
];
function rechain(receipt){
  const encode=value=>JSON.stringify(value,(_key,row)=>row&&typeof row==="object"&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
  let previous=peSha256(encode(Object.fromEntries(["schema","kind","identity","authority"].map(key=>[key,receipt[key]]))));
  for(const row of receipt.events){row.previousEventSha256=previous;previous=peSha256(encode(row));}
}
it.each(receiptViolations)("rejects %s in a receipt emitted by the operations",async(_name,mutate)=>{
  const f=receiptFixture(roots);await f.build();const {receipt}=await f.complete();mutate(receipt);
  expect(()=>verifyWindowsSigningReceipt(JSON.stringify(receipt),f.configuration,f.coverage)).toThrow();
});
it("revokes the receipt after a signing crash and never publishes complete bytes",async()=>{
  const f=receiptFixture(roots);await f.produce("gepa");
  await expect(f.writer.sign("gepa",f.coverage[0].path,f.pins.get("gepa").sourceSha256,async()=>{throw Error("fixture signer stopped after writing");})).rejects.toThrow();
  await expect(f.writer.freeze("gepa",vi.fn())).rejects.toThrow();expect(fs.existsSync(f.receiptFile)).toBe(false);
});
it("holds a snapshot of the validated result across asynchronous final verification",async()=>{
  const f=receiptFixture(roots);await f.build();const result=f.result(),original=result.installerSha256;
  const {receipt}=await f.writer.complete(f.receiptFile,result,async()=>{result.installerSha256="f".repeat(64);});
  expect(receipt.result.installerSha256).toBe(original);
  expect(()=>verifyWindowsSigningReceipt(fs.readFileSync(f.receiptFile),f.configuration,f.coverage)).not.toThrow();
});
export const recordViolations=[
  ["wrong path",r=>{r.path="unknown.exe";}],["invalid disposition",r=>{r.disposition="approved";}],
  ["bad source",r=>{r.sourceSha256="invalid";}],["another source",r=>{r.sourceSha256="c".repeat(64);}],["bad final",r=>{r.finalSha256="invalid";}],
  ["missing native verdict",r=>{delete r.nativeVerdictSha256;}],["missing leaf",r=>{delete r.leafCertificateSha256;}],
  ["changed preserved bytes",r=>{r.disposition="preserved";r.finalSha256="f".repeat(64);}]
];
it.each(recordViolations)("refuses %s final signing records without a complete receipt",async(_name,mutate)=>{
  const f=receiptFixture(roots),row=f.coverage[0];
  const record={path:row.path,disposition:"signed",sourceSha256:"d".repeat(64),finalSha256:"e".repeat(64),nativeVerdictSha256:"a".repeat(64),leafCertificateSha256:"b".repeat(64)};
  mutate(record);await expect(f.writer.sign("gepa",row.path,"d".repeat(64),async()=>record)).rejects.toThrow();expect(fs.existsSync(f.receiptFile)).toBe(false);
});
it("refuses changed freeze hashes, duplicate completions and package-complete inside an unfinished build",async()=>{
  const f=receiptFixture(roots);await f.produce("gepa");await f.sign("gepa");
  await expect(f.writer.freeze("gepa",async()=>({[f.coverage[0].path]:"f".repeat(64)}))).rejects.toThrow();
  const r=receiptFixture(roots);await r.prepare("gepa");
  const action=vi.fn();await expect(r.writer.package("app",async()=>r.writer.packageComplete(action))).rejects.toThrow();expect(action).not.toHaveBeenCalled();
  const p=receiptFixture(roots);await p.prepare("gepa");await p.writer.package("app",async()=>{
    await p.produce("app");await expect(p.writer.producer("app","Murage.exe",action)).rejects.toThrow();
  });expect(action).not.toHaveBeenCalled();
});
it("rejects reentrant operations, changed frozen bytes and failed final verification",async()=>{
  const f=receiptFixture(roots);await f.build();fs.appendFileSync(f.file("uninstaller"),"changed");
  await expect(f.complete()).rejects.toThrow();expect(fs.existsSync(f.receiptFile)).toBe(false);
  const r=receiptFixture(roots);await r.produce("gepa");let release;const pending=r.writer.sign("gepa",r.coverage[0].path,r.pins.get("gepa").sourceSha256,()=>new Promise(resolve=>{release=resolve;}));
  const duplicate=vi.fn();await expect(r.writer.sign("gepa",r.coverage[0].path,r.pins.get("gepa").sourceSha256,duplicate)).rejects.toThrow();
  expect(duplicate).not.toHaveBeenCalled();release({});await expect(pending).rejects.toThrow();
});
it.each(["existing","partial","missing-directory"])("fails closed on %s output without replacing another attempt's evidence",async mode=>{
  const f=receiptFixture(roots);await f.build();let output=f.receiptFile;
  if(mode==="existing")fs.writeFileSync(output,"prior attempt");
  if(mode==="partial")fs.writeFileSync(`${output}.partial`,"prior partial");
  if(mode==="missing-directory")output=path.join(f.root,"absent","receipt.json");
  await expect(f.writer.complete(output,f.result(),async()=>{})).rejects.toThrow();
  if(mode==="existing")expect(fs.readFileSync(output,"utf8")).toBe("prior attempt");
  else expect(fs.existsSync(output)).toBe(false);
});
