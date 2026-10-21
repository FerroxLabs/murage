// Bundle each harness-server entry point into a self-contained ESM file.
//
// Why this exists: the packaged app ships ZERO node_modules (see the files:
// exclusion in electron-builder.yml), so anything the server imports by bare
// specifier has to be inlined — `tsc` only transpiles, it leaves
// `import { z } from "zod"` verbatim and the packaged server dies at startup
// with ERR_MODULE_NOT_FOUND. That shipped once, in 0.1.24.
//
// Bundling every entry point rather than only index.ts is deliberate: the
// proxies are spawned as their own processes and today import nothing from
// node_modules, but nothing stops the next one from doing so, and the failure
// is invisible until a packaged build is actually launched.
//
// Entry points must keep their exact relative paths under dist-server — the
// server locates each proxy by path (server/index.ts:108,
// container-computer.ts:773, drivers/acp/core.ts:43), preferring the .ts in
// dev and falling back to the sibling .js in the packaged tree. outbase keeps
// drivers/ nested; import.meta.url still resolves to the same location, so
// that lookup is unaffected.
import { build } from "esbuild";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { checkRuntimeSibling } from "./runtime-sibling-mode.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");

// yaml's Node export is CommonJS and contains dynamic requires that cannot run
// after it is inlined into our ESM-only packaged server. Its browser export is
// the same pure-JS parser without those Node shims, so resolve only this package
// to that entry while leaving every other dependency on the Node condition.
const yamlEsmPlugin = {
  name: "yaml-esm",
  setup(build) {
    build.onResolve({ filter: /^yaml$/ }, () => ({
      path: join(root, "node_modules", "yaml", "browser", "index.js"),
    }));
  },
};

// Every file run as its own process. Keep in sync with the spawn sites above.
const ENTRY_POINTS = [
  "approval-notification-state.ts",
  "incident-diagnostics.ts",
  "backup-coordinator.ts",
  "backup-remote-host.ts",
  "backup-restic.ts",
  "windows-backup-resources.ts",
  "installation-windows-backup-transport.ts",
  "memory/worker.ts",
  "bot-package-guard-worker.ts",
  "engine-history-worker.ts",
  "inbox-fill-worker.ts",
  "transcript-read-worker.ts",
  "memory/restore.ts",
  // The Cloud launcher runs this as the browser user (modes browser-restore / browser-restore-mark).
  "browser-restore-cli.ts",
  "drivers/memory-proxy.ts",
  "index.ts",
  // The packaged smoke probe imports this manifest directly. Importing the
  // shared avatar contract widens TypeScript's inferred emit root to the repo,
  // so tsc may place its copy under dist-server/server/. Bundle an explicit
  // root sibling to keep the packaged runtime contract stable. The Linux
  // package smoke probe also imports local-computer.js directly.
  "proxy-paths.ts",
  "local-computer.ts",
  "computer-proxy.ts",
  "container-mcp.ts",
  "vps-container-mcp.ts",
  "cloud-home/vps-relay-mcp.ts",
  "permission-proxy.ts",
  "connector-proxy.ts",
  "drivers/agents-proxy.ts",
  "drivers/remote-mcp-proxy.ts",
  "drivers/dweb-proxy.ts",
  "drivers/phone-proxy.ts",
  "drivers/browser-proxy.ts",
  "drivers/headless-browser-proxy.ts",
  "drivers/unified-browser-proxy.ts",
  "drivers/host-computer-proxy.ts",
];

// Files a bundled module reads at run time from beside itself (`join(dirname(fileURLToPath(import.meta.url)), name)`),
// which esbuild cannot see. Once a module is inlined, import.meta.url is the OUTPUT file it landed in (index.ts's copy
// is dist-server/index.js), so each file is copied next to every output that inlines its reader, mode kept. The
// guard test scripts/bundle-server-runtime-files.test.mjs keeps this list in step with the readers in server/.
const RUNTIME_SIBLINGS = [
  // server/drivers/murage-exec.ts reads the shell wrapper at module load: missing, the packaged server dies at boot.
  { reader: "drivers/murage-exec.ts", file: "drivers/murage-exec", mode: 0o755 },
];

const main = await build({
  metafile: true,
  entryPoints: ENTRY_POINTS.map((entry) => join(server, entry)),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outbase: server,
  outdir: join(root, "dist-server"),
  // Bundled CommonJS ZIP dependencies still require Node built-ins.
  banner: { js: 'import { createRequire as __harnessRequire } from "node:module"; const require = __harnessRequire(import.meta.url);' },
  // Written after tsc, replacing its output for these entry points.
  allowOverwrite: true,
  logLevel: "info",
  plugins: [yamlEsmPlugin],
  external: ["@huggingface/transformers"],
});

for (const { reader, file, mode } of RUNTIME_SIBLINGS) {
  const readerPath = relative(process.cwd(), join(server, reader)).split("\\").join("/");
  const source = join(server, file);
  const outputs = Object.entries(main.metafile.outputs).filter(([out, meta]) => out.endsWith(".js") && meta.inputs[readerPath]);
  if (!outputs.length) throw new Error(`bundle-server: no bundle inlines ${readerPath}; update RUNTIME_SIBLINGS`);
  for (const [out] of outputs) {
    const target = join(process.cwd(), dirname(out), file.split("/").at(-1));
    copyFileSync(source, target);
    chmodSync(target, mode);
    checkRuntimeSibling(target, mode); // the mode on macOS and Linux; presence only on Windows (NTFS has no exec bit)
  }
}

// The WhatsApp bridge runs as its own forked process and imports Baileys, which is an ESM package
// ("type":"module") with a wasm dependency and must not be inlined. It gets its own ESM build with `baileys`
// and `jimp` external (the mcp-server build below is the pattern); it is deliberately NOT in ENTRY_POINTS,
// whose build has only @huggingface/transformers external and would inline Baileys. The staged runtime below
// ships the installed packages under dist-server/node_modules and records this bundle's sha256
// (WHATSAPP-DESIGN.md 0a W1.1, 1.3).
const WHATSAPP_ENTRY_POINTS = ["channels/whatsapp/bridge.ts", "channels/whatsapp/bridge-host.ts"].filter((entry) => existsSync(join(server, entry)));
if (WHATSAPP_ENTRY_POINTS.length > 0) {
  await build({
    entryPoints: WHATSAPP_ENTRY_POINTS.map((entry) => join(server, entry)),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outbase: server,
    outdir: join(root, "dist-server"),
    banner: { js: 'import { createRequire as __harnessRequire } from "node:module"; const require = __harnessRequire(import.meta.url);' },
    allowOverwrite: true,
    logLevel: "info",
    external: ["baileys", "jimp"],
  });
}
await import("./stage-whatsapp-runtime.mjs");

copyFileSync(join(root,"shared","memory-model-manifest.json"),join(root,"dist-server","memory-model-manifest.json"));
await import("./stage-memory-runtime.mjs");

// Both stagers share one hoisted tree. Verify it resolves exactly as staged before anything is packaged.
{
  const { checkStagedTree } = await import("./staged-tree-check.mjs");
  const checked = checkStagedTree(join(root, "dist-server"));
  console.log(`staged tree: ${checked.packages} packages, ${checked.files} files, longest path ${checked.longest.length}`);
  if (checked.problems.length) throw Error(`staged runtime tree is inconsistent:\n${checked.problems.join("\n")}`);
}

// External MCP clients launch this as an independent stdio process. Keep its
// source under scripts for a pleasant checkout command (`pnpm mcp`), but ship
// the bundled output beside the packaged harness so release users do not need
// the repository, TypeScript, pnpm, or node_modules.
await build({
  entryPoints: [join(root, "scripts", "mcp-server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(root, "dist-server", "mcp-server.js"),
  allowOverwrite: true,
  logLevel: "info",
});

// Offline installation backup/inspection must remain usable when the harness
// cannot boot. ZIP libraries are CommonJS and use built-in Node requires.
await build({
  entryPoints: [join(root, "scripts", "installation-recovery.ts"), join(root, "scripts", "installation-recovery-worker.ts"), join(root,"scripts","backup-schedule-trigger.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outdir: join(root, "dist-server"),
  banner: { js: 'import { createRequire as __recoveryRequire } from "node:module"; const require = __recoveryRequire(import.meta.url);' },
  allowOverwrite: true,
  logLevel: "info",
});

// pi-mcp-extension.ts is NOT an Murage entry point: it is loaded by the
// external `pi` process (pi's own jiti), which resolves its
// @earendil-works/pi-coding-agent and typebox imports from pi's install. Ship
// it verbatim as .ts so the packaged app has it too — never bundle it, or
// esbuild would inline pi's packages and the extension would stop loading.
const piMcpExtSrc = join(server, "drivers", "pi-mcp-extension.ts");
const piMcpExtDest = join(root, "dist-server", "drivers", "pi-mcp-extension.ts");
mkdirSync(dirname(piMcpExtDest), { recursive: true });
copyFileSync(piMcpExtSrc, piMcpExtDest);
// pi-permission-gate.ts rides along the same way: pi loads it with `-e`.
copyFileSync(join(server, "drivers", "pi-permission-gate.ts"), join(root, "dist-server", "drivers", "pi-permission-gate.ts"));

