// Vite support for math and diagrams in chat.
//
// 1. The diagram frame page (/mermaid-frame.html). The frame runs in
//    <iframe sandbox="allow-scripts">, an opaque origin, so a module script
//    would be a CORS fetch the harness does not answer. The frame script is
//    therefore bundled by esbuild into ONE classic script, inlined into the
//    page, and allowed by its sha256 in the page's own CSP. Served by a dev
//    middleware, emitted as dist/mermaid-frame.html in a build.
//
// 2. Optional packages. katex, mermaid and dompurify are loaded lazily; until
//    they are installed an import of one resolves to a stub that throws, and
//    the chat shows the source instead. Installing them is the only step that
//    turns the feature on.
//
// `depsDir` points both at a folder whose node_modules holds the packages.
// It exists for browser specs run before the packages are in the workspace;
// the app's own config never sets it.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild, type Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin } from "vite";

/** Packages the chat renderer imports lazily and can live without. */
export const OPTIONAL_RENDER_PACKAGES = ["katex", "mermaid", "dompurify"] as const;
const OPTIONAL = new RegExp(`^(?:${OPTIONAL_RENDER_PACKAGES.join("|")})(?:/|$)`);
const MISSING = "\0murage-missing-package:";
const FRAME_FILE = "mermaid-frame.html";
const FRAME_ENTRY = fileURLToPath(new URL("../src/mermaid-frame/frame.ts", import.meta.url));

/** The frame page's CSP, apart from the script hash. No network of any kind. */
export function frameCsp(scriptHash: string): string {
  return [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Headers the frame page is served with. `sandbox` makes the page opaque
 * even if it is opened directly rather than through the sandboxed iframe. */
export const FRAME_RESPONSE_CSP = "sandbox allow-scripts";

const missingStub = (name: string) =>
  `throw new Error(${JSON.stringify(`${name} is not installed; chat shows the source instead`)});`;

/** The frame page: CSP meta, one inline classic script allowed by hash. */
export async function frameHtml(options: { depsDir?: string; minify: boolean }): Promise<string> {
  const optional: EsbuildPlugin = {
    name: "murage-optional-render-packages",
    setup(build) {
      build.onResolve({ filter: OPTIONAL }, async (args) => {
        if (args.pluginData === "retry") return undefined;
        const found = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, pluginData: "retry" });
        if (!found.errors.length) return { path: found.path };
        return { path: args.path, namespace: "murage-missing" };
      });
      build.onLoad({ filter: /.*/, namespace: "murage-missing" }, (args) => ({ contents: missingStub(args.path), loader: "js" }));
    },
  };
  const result = await esbuild({
    entryPoints: [FRAME_ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: options.minify,
    legalComments: "none",
    logLevel: "silent",
    nodePaths: options.depsDir ? [join(options.depsDir, "node_modules")] : [],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [optional],
  });
  // An inline script ends at the first "</script"; esbuild already escapes it
  // inside strings, this is the belt to those braces.
  const script = result.outputFiles[0]!.text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
  const hash = `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${frameCsp(hash)}">
<meta name="referrer" content="no-referrer">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}#diagram{display:flex;justify-content:center;padding:8px 0}#diagram svg{max-width:100%;height:auto}</style>
</head>
<body><div id="diagram"></div><script>${script}</script></body>
</html>
`;
}

/** Vite plugins for chat math and diagrams. */
export function murageRenderPlugins(options: { depsDir?: string } = {}): Plugin[] {
  let devFrame: Promise<string> | undefined;
  return [
    {
      name: "murage-optional-render-packages",
      enforce: "pre",
      async resolveId(source, importer, resolveOptions) {
        if (!OPTIONAL.test(source)) return null;
        const found = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
        if (found) return found;
        if (options.depsDir) {
          // vite resolves a bare import from the importer's folder only when
          // the importer exists, so name a file that does
          const fromDeps = await this.resolve(source, join(options.depsDir, "package.json"), { ...resolveOptions, skipSelf: true });
          if (fromDeps) return fromDeps;
        }
        // no ".css" (or any extension) on the stub's id, or vite would run
        // the stub through its CSS pipeline
        return MISSING + encodeURIComponent(source).replace(/\./g, "%2E");
      },
      load(id) {
        if (id.startsWith(MISSING)) return missingStub(decodeURIComponent(id.slice(MISSING.length)));
        return null;
      },
    },
    {
      name: "murage-mermaid-frame",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.method !== "GET" || req.url?.split("?")[0] !== `/${FRAME_FILE}`) return next();
          devFrame ??= frameHtml({ depsDir: options.depsDir, minify: false });
          devFrame.then((html) => {
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.setHeader("content-security-policy", FRAME_RESPONSE_CSP);
            res.setHeader("cache-control", "no-store");
            res.end(html);
          }, (error: unknown) => {
            devFrame = undefined;
            next(error);
          });
        });
      },
      async generateBundle() {
        this.emitFile({ type: "asset", fileName: FRAME_FILE, source: await frameHtml({ depsDir: options.depsDir, minify: true }) });
      },
    },
  ];
}
