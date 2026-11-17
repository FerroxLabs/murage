// Build-contract implementation owner: win-sac-sign; toolchain selection, attestation and binary approval owner: MAIN.
import path from "node:path";
import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";
import { credentialFreeWindowsEnvironment } from "./windows-signing-config.mjs";
const source = fileURLToPath(new URL("../native/windows-trust-checker/check.c", import.meta.url));

/** A reviewed build contract pins every compiler/linker/SDK input. No vswhere,
 * tool downloads, discovery or signing credentials are allowed in this producer. */
export async function buildWindowsTrustChecker({ directory, contractFile, contractSha256, sourceRevision,
  platform = process.platform, env = process.env, run = promisify(execFile) }) {
  if (platform !== "win32" || !path.isAbsolute(directory ?? "") || !/^[a-f0-9]{40}$/.test(sourceRevision ?? "")
    || Object.keys(env).some(key => /^AZURE_/i.test(key))) throw Error("WINDOWS_CHECKER_BUILD_CONTEXT_INVALID");
  const raw = await readFile(contractFile);
  if (peSha256(raw) !== contractSha256) throw Error("WINDOWS_CHECKER_TOOLCHAIN_PIN_MISMATCH");
  const contract = JSON.parse(raw), sourceSha256 = peSha256(await readFile(source));
  if (contract.schema !== 1 || contract.sourceRevision !== sourceRevision || contract.sourceSha256 !== sourceSha256
    || contract.target !== "win32-x64" || !contract.toolchain?.version || !/^[a-f0-9]{64}$/.test(contract.toolchain.sha256 ?? "")
    || !Array.isArray(contract.files) || !contract.files.length || !path.isAbsolute(contract.compiler ?? "")
    || !contract.files.some(file => file.path === contract.compiler)
    || !Array.isArray(contract.include) || !contract.include.length || !Array.isArray(contract.lib) || !contract.lib.length) throw Error("WINDOWS_CHECKER_BUILD_CONTRACT_INVALID");
  const check = async () => {
    for (const file of contract.files) if (!path.isAbsolute(file.path) || peSha256((await readWindowsPeSnapshot(file.path)).bytes) !== file.sha256) throw Error("WINDOWS_CHECKER_TOOLCHAIN_PIN_MISMATCH");
  };
  await check(); await mkdir(directory, { recursive: false });
  const output = path.join(directory, "windows-trust-checker.exe");
  try {
    await run(contract.compiler, ["/nologo", "/std:c11", "/O2", "/W4", "/WX", "/MT",
      ...contract.include.map(dir => `/I${dir}`), source, `/Fo${directory}${path.sep}`, `/Fe${output}`, "/link",
      ...contract.lib.map(dir => `/LIBPATH:${dir}`), "wintrust.lib", "crypt32.lib", "/DYNAMICBASE", "/NXCOMPAT"],
    { env: credentialFreeWindowsEnvironment(env), windowsHide: true, timeout: 120_000, maxBuffer: 16_384 });
  } finally { await check(); }
  const attestation = { schema: 1, component: "windows-trust-checker", sourceRevision, sourceSha256,
    binarySha256: peSha256((await readWindowsPeSnapshot(output)).bytes), toolchain: contract.toolchain,
    tools: contract.files.map(file => ({ component: file.component, sha256: file.sha256 })), contract: "embedded-winverifytrust-v1" };
  const file = path.join(directory, "attestation.json"), text = JSON.stringify(attestation) + "\n";
  await writeFile(file, text, { flag: "wx" });
  await unlink(path.join(directory, "check.obj"));
  return { file: output, sha256: attestation.binarySha256, attestation: file, attestationSha256: peSha256(text) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Approval of the emitted binary digest is a separate MAIN-owned CI boundary.
  const result = await buildWindowsTrustChecker({ directory: process.argv[2], contractFile: process.env.MURAGE_WINDOWS_CHECKER_BUILD_CONTRACT,
    contractSha256: process.env.MURAGE_WINDOWS_CHECKER_BUILD_CONTRACT_SHA256, sourceRevision: process.env.MURAGE_BUILD_COMMIT });
  await writeFile(process.argv[3], JSON.stringify(result) + "\n", { flag: "wx" });
}
