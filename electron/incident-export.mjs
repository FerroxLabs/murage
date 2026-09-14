const MAX_BYTES = 128 * 1024;
const unavailable = () => new Error("Incident diagnostics are unavailable. Your original data is unchanged.");

export function assertIncidentExportSender(event, window, {origin,ready,secret}) {
  try {
    if (!ready || !secret || !window || event.sender !== window.webContents
      || event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw unavailable();
  } catch { throw unavailable(); }
}

export async function saveDiagnosticsReport(report, {chooseFile,writeFile}) {
  const result = await chooseFile();
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath,report);
  return result.filePath;
}

export function validateIncidentSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "diagnosticId,messageId,threadId"
    || ![value.threadId,value.messageId].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))
    || typeof value.diagnosticId !== "string" || value.diagnosticId.length > 40
    || !/^ev-[0-9a-z]{1,16}-[0-9a-z]{1,16}$/.test(value.diagnosticId)) throw unavailable();
  return {threadId:value.threadId,messageId:value.messageId,diagnosticId:value.diagnosticId};
}

/** Explicit selected export only. No general logs or credential documents. */
export async function prepareSelectedIncidentReport(selection, {fetchIncident,parseIncident,appInfo={}}) {
  const selected = validateIncidentSelection(selection);
  try {
    const response = await fetchIncident(selected);
    if (!response.ok || !response.body) throw unavailable();
    let size = 0;const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw unavailable();
      chunks.push(Buffer.from(chunk));
    }
    const incident = parseIncident(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!incident || incident.diagnostic.diagnosticId !== selected.diagnosticId) throw unavailable();
    const lines = ["Murage selected-incident diagnostics",`Diagnostic ID: ${incident.diagnostic.diagnosticId}`,
      "Only validated request and lifecycle facts are included. Missing evidence is not proof of success.","","## App"];
    for (const key of ["version","electron","node"]) {
      const value = appInfo[key];
      if (typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,24})?$/.test(value)) lines.push(`${key}=${value}`);
    }
    if (["darwin","linux","win32"].includes(appInfo.platform)) lines.push(`platform=${appInfo.platform}`);
    if (["arm64","x64","ia32","arm"].includes(appInfo.arch)) lines.push(`arch=${appInfo.arch}`);
    lines.push("","## Diagnostic",JSON.stringify(incident.diagnostic),"","## Coverage",JSON.stringify(incident.coverage),"","## Lifecycle");
    for (const row of incident.rows) lines.push(JSON.stringify(row));
    if (!incident.rows.length) lines.push("No matching lifecycle rows available in the inspected segments.");
    const report = lines.join("\n")+"\n";
    if (Buffer.byteLength(report)>MAX_BYTES) throw unavailable();
    return report;
  } catch { throw unavailable(); }
}
