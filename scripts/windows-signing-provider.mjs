// Provider staging/signing producer owner: win-sac-sign; CI credentials and Windows proof owner: MAIN.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import yauzl from "yauzl";
import { parse } from "yaml";
import { peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";

// Keep the reviewed Azure action as the provider implementation. Only its
// single-file invocation is used; recursive signing and module installation
// are replaced by common PE policy and content-pinned preparation respectively.
export const WINDOWS_SIGNING_PROVIDER = Object.freeze({
  action: "Azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82",
  actionSha256: "1c03dd7b58256fa0d69eb019347f29c45d67376a68e5341a35e56fe6db86e6c0",
  module: "ArtifactSigning", version: "0.1.8",
  moduleSha256: "3221344b8c627915d3870f23e80816f31a5d8c2bae1d7c0cdd6c9652f6c4e089",
  dependencies: [
    { name: "Microsoft.Windows.SDK.BuildTools", version: "10.0.26100.4188", sha256: "180deb372659029864c10a0c04787833234d64aacd1d2c0661d2c00295d8e022" },
    { name: "Microsoft.ArtifactSigning.Client", version: "1.0.128", sha256: "74bd7d27e6ce1051409c38d9b46bc8df0400ecd643d51ffbf2ac00869061e40b" },
    { name: "sign", version: "0.9.1-beta.26227.3", sha256: "34fd0d4aeabdbc363a48883881865b4dd65e6c11ba916028082fa23f3e1b1ba1" },
  ],
});

export function verifyWindowsSigningProvider(actionBytes, moduleBytes, pin = WINDOWS_SIGNING_PROVIDER) {
  if (peSha256(actionBytes) !== pin.actionSha256 || peSha256(moduleBytes) !== pin.moduleSha256) throw Error("WINDOWS_SIGNING_PROVIDER_HASH_MISMATCH");
  const action = parse(actionBytes.toString("utf8"));
  const step = action.runs?.steps?.find(step => step.name === "Invoke signing");
  if (action.runs?.using !== "composite" || step?.shell !== "pwsh" || typeof step.run !== "string"
    || !step.run.includes("Invoke-ArtifactSigning @params")) throw Error("WINDOWS_SIGNING_PROVIDER_INVALID");
  const defaults = Object.fromEntries(Object.entries(action.inputs).filter(([, input]) => input.default !== undefined)
    .map(([key, input]) => [`INPUT_${key.replaceAll("-", "_").toUpperCase()}`, String(input.default)]));
  return { run: step.run, defaults };
}

async function extractModule(bytes, directory) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const files = [], seen = new Set();
  await new Promise((resolve, reject) => {
    zip.on("error", reject); zip.on("end", resolve);
    zip.on("entry", async entry => {
      try {
        const name = entry.fileName;
        if (/^\/|\\|:/.test(name) || name.split("/").some(part => part === ".." || part === ".") || seen.has(name.toLowerCase())
          || entry.uncompressedSize > 16 * 1024 ** 2 || (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) throw Error("WINDOWS_SIGNING_PROVIDER_ARCHIVE_UNSAFE");
        seen.add(name.toLowerCase());
        if (!name.endsWith("/")) {
          const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
          const chunks = []; for await (const chunk of stream) chunks.push(chunk);
          const contents = Buffer.concat(chunks), file = path.join(directory, name);
          await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents, { flag: "wx" });
          files.push({ path: file, sha256: peSha256(contents) });
        }
        zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.readEntry();
  });
  return files;
}

export async function stageWindowsSigningProvider({ directory, actionRef, env = process.env, download = async url => {
  const response = await fetch(url); if (!response.ok) throw Error("WINDOWS_SIGNING_PROVIDER_DOWNLOAD_FAILED");
  return Buffer.from(await response.arrayBuffer());
}, pin = WINDOWS_SIGNING_PROVIDER }) {
  if (env.AZURE_CLIENT_SECRET) throw Error("WINDOWS_SIGNING_PREPARATION_HAS_CREDENTIALS");
  if (actionRef !== pin.action || !path.isAbsolute(directory)) throw Error("WINDOWS_SIGNING_PROVIDER_PIN_REQUIRED");
  const revision = actionRef.split("@")[1];
  const action = await download(`https://raw.githubusercontent.com/Azure/artifact-signing-action/${revision}/action.yml`);
  const module = await download(`https://www.powershellgallery.com/api/v2/package/${pin.module}/${pin.version}`);
  const provider = verifyWindowsSigningProvider(action, module, pin);
  const dependencies = await Promise.all(pin.dependencies.map(async dependency => {
    const name = dependency.name.toLowerCase(), version = dependency.version;
    const bytes = await download(`https://api.nuget.org/v3-flatcontainer/${name}/${version}/${name}.${version}.nupkg`);
    if (peSha256(bytes) !== dependency.sha256) throw Error("WINDOWS_SIGNING_DEPENDENCY_HASH_MISMATCH");
    return { ...dependency, bytes };
  }));
  // Neither package is parsed, extracted, imported or run until both hashes pass.
  await mkdir(directory, { recursive: false });
  const moduleRoot = path.join(directory, pin.module, pin.version);
  const files = await extractModule(module, moduleRoot);
  const manifest = path.join(moduleRoot, `${pin.module}.psd1`);
  if (!files.some(file => file.path === manifest)) throw Error("WINDOWS_SIGNING_PROVIDER_MODULE_MISSING");
  // Satisfy the module's exact dependency paths in an isolated LocalAppData.
  // Its invocation then needs no package install while credentials are present.
  const localAppData = path.join(directory, "localappdata");
  await mkdir(localAppData);
  for (const dependency of dependencies) files.push(...await extractModule(dependency.bytes,
    path.join(localAppData, "ArtifactSigning", dependency.name, `${dependency.name}.${dependency.version}`)));
  const entry = path.join(directory, "invoke.ps1");
  const denied = ["Install-Module", "Save-Module", "Install-Package", "Save-Package", "Invoke-WebRequest", "Invoke-RestMethod", "Start-BitsTransfer"];
  const script = `$ErrorActionPreference = 'Stop'\n$PSModuleAutoLoadingPreference = 'None'\n`
    + denied.map(name => `function global:${name} { throw 'WINDOWS_SIGNING_ACQUISITION_DENIED' }\n`).join("")
    + `Import-Module -Name '${manifest.replaceAll("'", "''")}' -Force\n${provider.run}`;
  await writeFile(entry, script, { flag: "wx" }); files.push({ path: entry, sha256: peSha256(script) });
  const receipt = path.join(directory, "receipt.json"), text = JSON.stringify({ actionRef, entry, localAppData, defaults: provider.defaults, files });
  await writeFile(receipt, text, { flag: "wx" });
  return { receipt, sha256: peSha256(text) };
}

export async function loadWindowsSigningProvider(env = process.env) {
  const file = env.MURAGE_WINDOWS_SIGNER_RECEIPT, expected = env.MURAGE_WINDOWS_SIGNER_RECEIPT_SHA256;
  if (!file || !path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expected ?? "")) throw Error("WINDOWS_SIGNING_PROVIDER_RECEIPT_REQUIRED");
  const bytes = (await readWindowsPeSnapshot(file)).bytes;
  if (peSha256(bytes) !== expected) throw Error("WINDOWS_SIGNING_PROVIDER_HASH_MISMATCH");
  const provider = JSON.parse(bytes);
  if (provider.actionRef !== WINDOWS_SIGNING_PROVIDER.action) throw Error("WINDOWS_SIGNING_PROVIDER_PIN_REQUIRED");
  for (const file of provider.files) {
    if (peSha256((await readWindowsPeSnapshot(file.path)).bytes) !== file.sha256) throw Error("WINDOWS_SIGNING_PROVIDER_HASH_MISMATCH");
  }
  return provider;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await stageWindowsSigningProvider({ directory: process.argv[2], actionRef: process.env.MURAGE_WINDOWS_SIGNING_ACTION });
  await writeFile(process.env.GITHUB_ENV, `MURAGE_WINDOWS_SIGNER_RECEIPT=${result.receipt}\nMURAGE_WINDOWS_SIGNER_RECEIPT_SHA256=${result.sha256}\n`, { flag: "a" });
}
