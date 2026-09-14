import { useRef,useState } from "react";
import { parseRuntimeErrorDiagnostic } from "../../shared/error-diagnostic";

/** Only validated tracking facts, bound to the saved message's actual turn. */
export interface IncidentMessageSelection { threadId:string; messageId:string }
export function incidentSelection(diagnostic:unknown,turnId:string|undefined,message:IncidentMessageSelection|undefined) {
  const parsed=parseRuntimeErrorDiagnostic(diagnostic);
  if(!parsed||parsed.turnId!==turnId||!message||![message.threadId,message.messageId].every(id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id)))return;
  return {threadId:message.threadId,messageId:message.messageId,diagnosticId:parsed.diagnosticId};
}
export function DiagnosticDetails({ diagnostic, turnId, incident }: { diagnostic?: unknown; turnId?: string; incident?:IncidentMessageSelection }) {
  const [copied,setCopied]=useState<string|null>(null),[failed,setFailed]=useState<string|null>(null);
  const [exporting,setExporting]=useState(false),[exportResult,setExportResult]=useState<{key:string;state:"saved"|"cancelled"|"failed"}|null>(null);
  const exportGate=useRef(false);
  const parsed=parseRuntimeErrorDiagnostic(diagnostic);
  if(!parsed||parsed.turnId!==turnId)return null;
  const selection=incidentSelection(diagnostic,turnId,incident);
  const exportBridge=typeof window!=="undefined"?window.muragebox?.exportDiagnostics:undefined;
  const selectionKey=selection?`${selection.threadId}:${selection.messageId}:${selection.diagnosticId}`:null;
  const exportIncident=async()=>{
    const current=incidentSelection(diagnostic,turnId,incident);
    const bridge=window.muragebox?.exportDiagnostics;
    if(!current||typeof bridge!=="function"||exportGate.current)return;
    const key=`${current.threadId}:${current.messageId}:${current.diagnosticId}`;
    exportGate.current=true;setExporting(true);setExportResult(null);
    try{const result=await bridge(current);setExportResult({key,state:result===null?"cancelled":typeof result==="string"&&result.length>0?"saved":"failed"});}
    catch{setExportResult({key,state:"failed"});}
    finally{exportGate.current=false;setExporting(false);}
  };
  const rows:[string,string|number|undefined][]=[
    ["Diagnostic ID",parsed.diagnosticId],["Turn ID",parsed.turnId],["Process generation",parsed.processGeneration],
    ["RPC request ID",parsed.rpcId],["RPC method",parsed.method],["RPC error code",parsed.rpcCode],
    ["HTTP status",parsed.httpStatus],["Terminal error kind",parsed.terminalKind],["Observed error kind (not terminal)",parsed.observedKind],
  ];
  const copy=async()=>{
    const current=parseRuntimeErrorDiagnostic(diagnostic);
    if(!current||current.turnId!==turnId)return;
    setCopied(null);setFailed(null);
    try{await navigator.clipboard.writeText(current.diagnosticId);setCopied(current.diagnosticId);}
    catch{setFailed(current.diagnosticId);}
  };
  return <div className="mt-3 min-w-0 rounded-lg bg-inset p-3" aria-label="Diagnostic tracking facts">
    <dl className="space-y-2">
      {rows.filter(([,value])=>value!==undefined).map(([label,value])=><div key={label}>
        <dt className="font-medium text-ink">{label}</dt><dd className="mt-0.5 select-text break-all font-mono text-ink-secondary">{value}</dd>
      </div>)}
    </dl>
    <button type="button" onClick={()=>void copy()} className="mt-3 min-h-11 rounded-lg border border-hairline/70 bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">Copy diagnostic ID</button>
    {selection&&typeof exportBridge==="function"&&<button type="button" disabled={exporting} onClick={()=>void exportIncident()} className="mt-3 ml-2 min-h-11 rounded-lg border border-hairline/70 bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50">{exporting?"Preparing incident export…":"Export this incident"}</button>}
    {copied===parsed.diagnosticId&&<p role="status" className="mt-2">Diagnostic ID copied.</p>}
    {failed===parsed.diagnosticId&&<p role="alert" className="mt-2">Could not copy. Select the diagnostic ID above and copy it manually.</p>}
    {exportResult?.key===selectionKey&&exportResult?.state==="saved"&&<p role="status" className="mt-2">Incident diagnostics saved.</p>}
    {exportResult?.key===selectionKey&&exportResult?.state==="cancelled"&&<p role="status" className="mt-2">Export cancelled. No report was saved.</p>}
    {exportResult?.key===selectionKey&&exportResult?.state==="failed"&&<p role="alert" className="mt-2">Incident diagnostics could not be exported. Your original data is unchanged. Try again from this saved error.</p>}
  </div>;
}
