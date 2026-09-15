import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readSafeLogTail, redactSecretsInLine } from "../electron/diagnostics.mjs";

export function collectGepaBuildEvidence(root, destination) {
  const statePath = path.join(root, "state.json");
  const source = readSafeLogTail(statePath, 64 * 1024);
  if (!source) return false;
  let state;
  try { state = JSON.parse(source.tail); } catch { return false; }
  if (!state || typeof state !== "object" || !/^[a-z][a-z0-9-]{0,63}$/.test(state.stage ?? "")) return false;
  const logs = path.join(root, "logs");
  const directory = fs.lstatSync(logs, { throwIfNoEntry: false });
  if (!directory?.isDirectory() || directory.isSymbolicLink()) return false;
  const log = readSafeLogTail(path.join(logs, `${state.stage}.log`));
  const summary = { stage: state.stage, logAvailable: Boolean(log) };
  if (["RUNNING", "BLOCKED", "BUILT_SIGNED_STAGED", "BUILT_STAGED"].includes(state.status)) summary.status = state.status;
  if (Number.isSafeInteger(state.exitCode)) summary.exitCode = state.exitCode;
  if (Number.isFinite(state.elapsedSeconds) && state.elapsedSeconds >= 0) summary.elapsedSeconds = state.elapsedSeconds;
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "gepa-build-state.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (log) fs.writeFileSync(path.join(destination, "gepa-build-stage.log"), redactSecretsInLine(log.tail), { flag: "wx", mode: 0o600 });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error("Usage: collect-gepa-build-evidence.mjs BUILD_ROOT EVIDENCE_DIR");
  console.log(collectGepaBuildEvidence(process.argv[2], process.argv[3]) ? "GEPA stage evidence preserved" : "No readable GEPA stage evidence available");
}
