const operations = new Set(["backup", "inspect", "plan-restore", "restore", "rollback", "review", "activate", "backup-encrypted", "inspect-encrypted", "restore-encrypted-new"]);
const fields = ["path", "sha256", "snapshotId", "status", "previousDataDir", "receipt", "retainedCandidate", "activationAvailable", "reviewHash", "activationId", "connectionProfileId", "engines", "schedules", "pendingWork"];

/** The desktop never receives archive content or an unbounded omissions list.
 * Full receipts remain on disk; the recovery screen gets a bounded summary. */
export function recoveryDesktopSummary(result) {
  if (!result || result.ok !== true || !operations.has(result.operation)) throw new Error("INVALID_RECOVERY_RESULT");
  const invalid = () => { throw new Error("INVALID_RECOVERY_RESULT"); };
  const file = value => typeof value === "string" && value.length > 0 && value.length <= 8192;
  if(result.operation.includes("encrypted")){
    const sha=result.operation==="restore-encrypted-new"?result.encryptedSha256:result.sha256;
    if(!/^[a-f0-9]{64}$/.test(sha)||!/^[a-f0-9-]{36}$/.test(result.snapshotId))invalid();
    if(result.operation==="backup-encrypted"&&!file(result.path))invalid();
    if(result.operation==="inspect-encrypted"&&result.activationAvailable!==false)invalid();
    if(result.operation==="restore-encrypted-new"&&(result.activationAvailable!==false||result.rawFidelityActivated!==false||result.previousDataDir!==null||result.status!=="restored-review-required"||!file(result.receipt)||!/^[a-f0-9]{64}$/.test(result.archiveSha256)))invalid();
  }
  if (["backup", "inspect", "plan-restore", "restore"].includes(result.operation) && (!/^[a-f0-9]{64}$/.test(result.sha256 ?? result.archiveSha256) || !/^[a-f0-9-]{36}$/.test(result.snapshotId))) invalid();
  if (["review", "activate"].includes(result.operation) && (!/^[a-f0-9-]{36}$/.test(result.snapshotId) || !/^[a-f0-9-]{36}$/.test(result.connectionProfileId) || result.engines !== "disabled" || result.schedules !== "paused")) invalid();
  if (result.operation === "review" && (result.status !== "ready-for-review" || !/^[a-f0-9]{64}$/.test(result.reviewHash) || result.activationAvailable !== true)) invalid();
  if (result.operation === "activate" && (result.status !== "reviewed-engines-disabled" || !/^[a-f0-9-]{36}$/.test(result.activationId) || result.activationAvailable !== false)) invalid();
  if (result.operation === "backup" && !file(result.path)) invalid();
  if (["inspect", "plan-restore", "restore"].includes(result.operation) && result.activationAvailable !== false) invalid();
  if (result.operation === "restore" && (result.status !== "restored-review-required" || !file(result.receipt) || !(result.previousDataDir === null || file(result.previousDataDir)))) invalid();
  if (result.operation === "rollback" && (result.status !== "rolled-back" || !file(result.receipt) || !(result.retainedCandidate === null || file(result.retainedCandidate)))) invalid();
  const summary = { ok: true, operation: result.operation };
  if(result.operation.includes("encrypted")){
    const coverage=result.coverage;
    if(coverage?.scope!=="application-data"||coverage.fullInstallation!==false)invalid();
    const components=coverage.components;
    if(components!==undefined&&(!Array.isArray(components)||components.length>100000))invalid();
    const included=components?components.filter(item=>item.status==="included").length:coverage.includedCount;
    const excluded=components?components.filter(item=>item.status!=="included").length:coverage.excludedCount;
    if(!Number.isSafeInteger(included)||included<0||!Number.isSafeInteger(excluded)||excluded<0||included+excluded>100000)invalid();
    summary.coverage={scope:"application-data",fullInstallation:false,includedCount:included,excludedCount:excluded};
    if(result.operation==="restore-encrypted-new"){summary.rawFidelityActivated=false;summary.archiveSha256=result.archiveSha256;summary.encryptedSha256=result.encryptedSha256;}
  }
  for (const key of fields) {
    const value = result[key];
    if (value === undefined) continue;
    if (key === "activationAvailable") {
      if (value !== false && !(result.operation === "review" && value === true)) throw new Error("INVALID_RECOVERY_RESULT");
    } else if (value !== null && (typeof value !== "string" || value.length > 8192)) throw new Error("INVALID_RECOVERY_RESULT");
    summary[key] = value;
  }
  if (result.operation === "restore") summary.sha256 = result.sha256 ?? result.archiveSha256;
  for (const key of ["files", "bytes"]) if (result[key] !== undefined) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) invalid();
    summary[key] = result[key];
  }
  for (const key of ["omitted", "missing", "quarantined", "modifications"]) {
    if (result[key] !== undefined && !Array.isArray(result[key])) throw new Error("INVALID_RECOVERY_RESULT");
    const count = result[key]?.length ?? result[key + "Count"] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count > 100_000) invalid();
    summary[key + "Count"] = count;
  }
  if (JSON.stringify(summary).length > 64 * 1024) throw new Error("INVALID_RECOVERY_RESULT");
  return summary;
}
