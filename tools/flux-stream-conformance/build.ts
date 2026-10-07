// Bundles the suite for plain node: `run.ts` and `owner-replay.ts`, each as one
// ESM file with ws and zod inside, the `@/` alias resolved to src/, and the
// fixtures copied next to them. Imported by launch.ts and pack.ts; run
// directly it builds into dist/flux-stream-conformance/.
//   node --experimental-strip-types tools/flux-stream-conformance/build.ts [outDir]
import { build as esbuild, type Plugin } from "esbuild";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");
export const defaultOut = join(repoRoot, "dist", "flux-stream-conformance");

/** The browser-only modules src/lib/call-turns.ts imports. Its replayed rules
 *  never call them (answerCallQuestion and micEndStep do, and the suite uses
 *  neither), so the bundle gets stubs that throw if they are ever reached. The
 *  app files are not touched. */
const BROWSER_ONLY: Record<string, string[]> = {
  "call-mic": ["isTranscriptionFailure"],
  "live-events": ["ensureDesktopSurfaceSecret"],
  "voice-host": ["callRouteHeaders"],
};

const stubs: Plugin = {
  name: "browser-only-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/(call-mic|live-events|voice-host)$/ }, (args) => {
      if (!args.importer.endsWith(join("src", "lib", "call-turns.ts"))) return undefined;
      return { path: args.path.slice(2), namespace: "browser-only-stub" };
    });
    b.onLoad({ filter: /.*/, namespace: "browser-only-stub" }, (args) => ({
      contents: BROWSER_ONLY[args.path].map((n) => `export const ${n} = () => { throw new Error("${args.path}.${n} is browser-only and is not available in the conformance bundle"); };`).join("\n"),
      loader: "js",
    }));
    // fixtures/analyse.ts runs its own command line when its file is the entry
    // point (process.argv[1] equals import.meta.url); in a bundle that is true of
    // run.mjs, so the guard is switched off here. The build fails if it moves.
    const guard = "process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2]";
    b.onLoad({ filter: /fixtures[\\/]analyse\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (!source.includes(guard)) throw new Error("analyse.ts no longer has the entry-point guard build.ts switches off");
      return { contents: source.replace(guard, "false"), loader: "ts" };
    });
  },
};

export async function buildSuite(outDir = defaultOut): Promise<{ outDir: string }> {
  mkdirSync(outDir, { recursive: true });
  await esbuild({
    entryPoints: { run: join(here, "run.ts"), "owner-replay": join(here, "owner-replay.ts") },
    outdir: outDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    alias: { "@": join(repoRoot, "src") },
    // ws's optional native add-ons are required inside try/catch; plain JS is used without them
    external: ["bufferutil", "utf-8-validate"],
    // ws is CommonJS: its require() of node built-ins needs a real require in an ESM file
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    plugins: [stubs],
    logLevel: "warning",
  });
  cpSync(join(here, "fixtures"), join(outDir, "fixtures"), {
    recursive: true,
    filter: (src) => /(^|[\\/])(fixtures|manifest\.json|f\d\d-[a-z]+\.pcm)$/.test(src),
  });
  return { outDir };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { outDir } = await buildSuite(process.argv[2] ? resolve(process.argv[2]) : defaultOut);
  process.stdout.write(`built ${outDir}\n`);
}
