import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const evidence = join(root, ".planning/flux-native-evidence");
mkdirSync(evidence, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "murage-flux-native-"));
const candidate = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
let server, childExited = false, passed = false;
try {
  server = await launchVerificationServer({}, undefined, { instrumentationSource: `
    process.env.FLUX_API_KEY='sk-flux-FAKE_NATIVE_ORIGINAL';
    process.env.MURAGE_MODEL_PROVIDER_CONNECTIONS=JSON.stringify([{id:'other-native',preset:'mistral',label:'Other fixture',enabled:false,key:'FAKE_OTHER_NATIVE',revision:'other-revision'}]);
    process.env.MURAGE_FLUX_CONNECTION_ALIASES=JSON.stringify([{id:'old-native-flux',label:'Historical',enabled:false,revision:'old-revision'}]);
    process.env.MURAGE_MODEL_PROVIDER_COMMIT_TOKEN='${"b".repeat(64)}';
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{
      const url=new URL(String(input));
      if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('Provider network forbidden in native fixture');
      return originalFetch(input,init);
    };
  ` });
  const proof = await (await fetch(server.info.url + "/api/desktop-secret")).json();
  writeFileSync(join(scratch, "context.json"), JSON.stringify({ root, evidence, scratch, candidate, url: server.info.url, proof: proof.secret, dataDir: server.info.dataDir, token: "b".repeat(64) }), { mode: 0o600 });
  const childEnv = { PATH: "/usr/bin:/bin", HOME: scratch, USERPROFILE: scratch, MURAGE_FLUX_NATIVE_CONTEXT: join(scratch, "context.json") };
  for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR"]) if (process.env[name]) childEnv[name] = process.env[name];
  try {
    const output = await promisify(execFile)(electron, [join(root, ".planning/flux-native-electron.mjs")], { cwd: root, env: childEnv, timeout: 60_000, maxBuffer: 512 * 1024 });
    childExited = true;
    writeFileSync(join(evidence, "native-output.log"), output.stdout + output.stderr);
    const result = JSON.parse(readFileSync(join(evidence, "result.json"), "utf8"));
    passed = result.passed === true;
    if (!passed) throw Error("Native fixture did not report acceptance");
  } catch (error) {
    childExited = true; // execFile settles only after this exact child closes.
    writeFileSync(join(evidence, "native-output.log"), String(error.stdout ?? "") + String(error.stderr ?? ""));
    throw Error("Native Flux fixture failed; inspect bounded fixture evidence");
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  await server?.close();
  const receipt = { passed, driverNode: process.versions.node, electronChildExited: childExited, serverClosed: Boolean(server), scope: "native Flux IPC with fixture encryption; no OS keychain proof" };
  writeFileSync(join(evidence, "lifecycle.json"), JSON.stringify(receipt, null, 2));
  if (childExited || !server) safeWipeSync(scratch);
  console.log(JSON.stringify(receipt));
}
