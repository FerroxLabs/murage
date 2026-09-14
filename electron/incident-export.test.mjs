import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {assertIncidentExportSender,prepareSelectedIncidentReport,saveDiagnosticsReport,validateIncidentSelection} from "./incident-export.mjs";
import {parseIncidentDiagnostics} from "../server/incident-diagnostics.ts";
const diagnostic={version:1,diagnosticId:"ev-abc-1",turnId:"11111111-1111-4111-8111-111111111111",httpStatus:402,method:"session/prompt",rpcCode:-32603};
const selection={threadId:"22222222-2222-4222-8222-222222222222",messageId:"message-1",diagnosticId:diagnostic.diagnosticId};
const incident=()=>({version:1,diagnostic:{...diagnostic},rows:[],coverage:{scope:"current-and-previous-tail",segments:{current:"not-requested",previous:"not-requested"},readBytes:0,missing:true,unavailable:false,generationMissing:true,tailLimited:false,truncated:false,invalidLines:0,oversizedLines:0,omittedRows:0}});
const prepare=(value,options={})=>prepareSelectedIncidentReport(selection,{parseIncident:parseIncidentDiagnostics,fetchIncident:async()=>Response.json(value),...options});
describe("selected incident export boundary",()=>{
  it("formats the same diagnostic ID and missing facts without generic logs or config",async()=>{
    let seen;
    const report=await prepare(incident(),{fetchIncident:async input=>{seen=input;return Response.json(incident());},appInfo:{version:"0.1.53",platform:"darwin",arch:"arm64",node:"24.20.0",logTail:"PRIVATE-CANARY",account:"PRIVATE-CANARY"}});
    expect(seen).toEqual(selection);expect(report).toContain("Diagnostic ID: ev-abc-1");expect(report).toContain('"httpStatus":402');expect(report).toContain("No matching lifecycle rows");expect(report).not.toContain("PRIVATE-CANARY");expect(report).not.toContain("Server log tail");
  });
  it("rejects unknown selection fields and paths before fetch",async()=>{
    let calls=0;
    for(const value of [null,{...selection,path:"/private"},{...selection,threadId:"../other"},{...selection,diagnosticId:"secret"}]){
      await expect(prepareSelectedIncidentReport(value,{fetchIncident:()=>{calls++;},parseIncident:parseIncidentDiagnostics})).rejects.toThrow("Incident diagnostics");
    }expect(calls).toBe(0);expect(validateIncidentSelection(selection)).toEqual(selection);
  });
  it("rejects private unknown response data and mismatched diagnostic identity",async()=>{
    for(const value of [{...incident(),body:"PRIVATE-CANARY"},{...incident(),diagnostic:{...diagnostic,diagnosticId:"ev-other-1"}},{...incident(),diagnostic:{...diagnostic,url:"https://private.invalid"}}])await expect(prepare(value)).rejects.toThrow(/^Incident diagnostics are unavailable/);
  });
  it("refuses errors, malformed JSON and oversized bodies without surfacing body text",async()=>{
    for(const response of [new Response("PRIVATE-CANARY",{status:403}),new Response("PRIVATE-CANARY"),new Response("x".repeat(128*1024+1))])await expect(prepare(null,{fetchIncident:async()=>response})).rejects.toThrow(/^Incident diagnostics are unavailable/);
  });
  it("requires the exact main frame, local origin and ready owned server",()=>{
    const frame={url:"http://127.0.0.1:1234"},sender={mainFrame:frame},event={sender,senderFrame:frame},window={webContents:sender},context={origin:frame.url,ready:true,secret:"fake"};
    expect(()=>assertIncidentExportSender(event,window,context)).not.toThrow();
    for(const [e,w,c] of [[{...event,senderFrame:{url:frame.url}},window,context],[event,{webContents:{}},context],[event,window,{...context,origin:"https://else.invalid"}],[event,window,{...context,secret:null}],[event,window,{...context,ready:false}],[{},window,context]])expect(()=>assertIncidentExportSender(e,w,c)).toThrow("Incident diagnostics");
  });
  it("cancelled save writes nothing and explicit selection writes exact report once",async()=>{
    const writes=[];const writeFile=(...args)=>writes.push(args);
    expect(await saveDiagnosticsReport("safe",{chooseFile:async()=>({canceled:true,filePath:"unused"}),writeFile})).toBeNull();expect(writes).toEqual([]);
    expect(await saveDiagnosticsReport("safe",{chooseFile:async()=>({canceled:false,filePath:"chosen.txt"}),writeFile})).toBe("chosen.txt");expect(writes).toEqual([["chosen.txt","safe"]]);
  });
  it("native wiring keeps selection and legacy export separate and shares the bundled parser",()=>{
    const main=readFileSync(new URL("./main.mjs",import.meta.url),"utf8"),preload=readFileSync(new URL("./preload.cjs",import.meta.url),"utf8");
    const block=main.slice(main.indexOf('ipcMain.handle("desktop:export-diagnostics"'),main.indexOf('// Bots hand users files'));
    expect(block).toContain("assertIncidentExportSender(event,mainWindow");expect(block).toContain("parseIncidentDiagnostics");expect(block).toContain('redirect:"error"');expect(block).toContain("else report = await gatherDiagnostics()");expect(block).toContain("saveDiagnosticsReport(report");expect(preload).toContain('ipcRenderer.invoke("desktop:export-diagnostics", selection)');
  });
});
