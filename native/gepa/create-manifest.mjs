// Explicit build-stage utility only. Never downloads, executes or signs a worker.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gepaResourceManifestSchema, inventoryGepaBundle, verifyGepaBundle } from "../../server/gepa-resource.ts";

const sourceRoot=fileURLToPath(new URL("./",import.meta.url));
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");

/** Caller supplies a completed, already signed native tree and new receipt path. */
export function createGepaManifest(directory,target,receiptPath){
  if(!isAbsolute(directory)||!isAbsolute(receiptPath))throw Error("GEPA_MANIFEST_ABSOLUTE_PATHS_REQUIRED");
  const rel=relative(directory,receiptPath);
  if(rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel))throw Error("GEPA_RECEIPT_MUST_BE_OUTSIDE_BUNDLE");
  const manifest=gepaResourceManifestSchema.parse({schema:1,protocol:1,target,python:"3.13.15",gepa:"0.1.4",pyinstaller:"6.22.3",
    pythonSourceSha256:"1e66a7945a48390ee4c2a4268a0e4185884059a13c4aab6d148aa208deea4a76",
    gepaWheelSha256:"12b971039599625c156d2231f6d72a29c31a22e9c237689459b5f1a3c353f532",
    workerSourceSha256:sha(readFileSync(join(sourceRoot,"gepa-worker.py"))),
    buildLockSha256:sha(readFileSync(join(sourceRoot,"requirements-build.txt"))),
    entrypoint:target==="win32-x64"?"gepa-worker.exe":"gepa-worker",files:inventoryGepaBundle(directory)});
  const text=JSON.stringify(manifest,null,2)+"\n",manifestSha256=sha(text);
  writeFileSync(join(directory,"manifest.json"),text,{flag:"wx",mode:0o644});
  verifyGepaBundle(directory,target,manifestSha256);
  // Feed this explicit configuration fragment to electron-builder. It is baked
  // into the app's package metadata, never discovered from an untrusted env var.
  const receipt={extraMetadata:{murageGepaManifests:{[target]:manifestSha256}}};
  writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+"\n",{flag:"wx",mode:0o600});
  return {target,manifestSha256,receiptPath};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==5)throw Error("Usage: node create-manifest.mjs ABSOLUTE_BUNDLE TARGET ABSOLUTE_NEW_RECEIPT");
  console.log(JSON.stringify(createGepaManifest(...process.argv.slice(2))));
}
