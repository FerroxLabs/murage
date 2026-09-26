// Vite support for math and diagrams in chat.
//
// 1. The diagram frame page (/mermaid-frame-<hash>.html in a build, /mermaid-frame.html in dev). The frame runs in
//    <iframe sandbox="allow-scripts">, an opaque origin, so a module script
//    would be a CORS fetch the harness does not answer. The frame script is
//    therefore bundled by esbuild into ONE classic script, inlined into the
//    page, and allowed by its sha256 in the page's own CSP. Served by a dev
//    middleware under its plain name; a build names it by its content and
//    tells the app that name through a define, so it can be cached for good.
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

/** The global a build defines to the frame page's hashed address, read in
 * src/mermaid-frame/protocol.ts. */
export const FRAME_PATH_DEFINE = "__MURAGE_MERMAID_FRAME_PATH__";

/** The frame page's name in a build: its content's hash, so the browser door
 * can let a browser keep it for a year and a new release is a new name.
 * Sixteen hex digits, which is what the door's allowlist accepts. */
export function frameFileName(html: string): string {
  return `mermaid-frame-${createHash("sha256").update(html, "utf8").digest("hex").slice(0, 16)}.html`;
}

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
  // One build of the frame per plugin instance: the name the app is told in
  // `config` and the file `generateBundle` writes are the same bytes.
  let builtFrame: Promise<{ fileName: string; html: string }> | undefined;
  const buildFrame = () =>
    (builtFrame ??= frameHtml({ depsDir: options.depsDir, minify: true }).then((html) => ({ html, fileName: frameFileName(html) })));
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
      // Before any module is transformed: the app's frame URL is a define,
      // and a define has to exist before the code that reads it is built.
      async config(_config, env) {
        if (env.command !== "build") return undefined;
        const { fileName } = await buildFrame();
        return { define: { [FRAME_PATH_DEFINE]: JSON.stringify(`/${fileName}`) } };
      },
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
        const { fileName, html } = await buildFrame();
        this.emitFile({ type: "asset", fileName, source: html });
      },
    },
  ];
}
