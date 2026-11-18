// Provider injection owner: win-sac-sign; protected driver/producer registration consumer: MAIN.
let active;
export function beginWindowsSigningSession(session) {
  if (active || typeof session?.sign !== "function") throw Error("WINDOWS_SIGNING_SESSION_INVALID");
  active = session;
  return () => { if (active !== session) throw Error("WINDOWS_SIGNING_SESSION_INVALID"); active = undefined; };
}
export function windowsSigningSession(context) {
  if (typeof context.windowsPeSigner === "function") return { sign: context.windowsPeSigner, receipts: context.windowsPeStageReceipts };
  if (!active) throw Error("WINDOWS_SIGNING_DRIVER_REQUIRED");
  return active;
}

export function windowsSigningGraph() { return active?.graph; }
export function windowsSigningAdapters() { return active?.adapters; }
