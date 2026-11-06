import { expect, it } from "vitest";
import { build, type Plugin } from "vite";
import { build as rebundle } from "esbuild";
import { runInNewContext } from "node:vm";
import { resolve, posix } from "node:path";

// Use the real config and HTML entry. Only the disk-only compressor is disabled:
// write:false never supplies its input directory. No renderer transforms are replaced.
async function renderer(removeGuard = false) {
  let rewrites = 0;
  const probe = "\0help-runtime-probe";
  const plugin: Plugin = {
    name: "help-production-negative-control", enforce: "pre",
    configResolved(config) {
      const compressor = config.plugins.find(p => p.name === "murage-precompress");
      if (compressor) compressor.closeBundle = undefined;
    },
    resolveId(id) { if (id === probe) return probe; },
    load(id) { if (id === probe) return `import { askScope, askApi } from ${JSON.stringify(resolve("src/components/help/help-ask-port.ts"))}; globalThis.helpProbe = { askScope, askApi };`; },
    transform(source, id) {
      if (!removeGuard || !id.endsWith("/help-ask-port.ts")) return;
      const guard = 'if (import.meta.env.MODE === "help-fixture") {';
      expect(source).toContain(guard);
      rewrites++;
      return source.replace(guard, "if (true) {");
    },
  };
  const result = await build({ mode: "production", logLevel: "error", plugins: [plugin],
    build: { write: false, rollupOptions: { input: { app: resolve("index.html"), probe } } } });
  if ("on" in result) throw Error("Unexpected build watcher");
  const output = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  expect(output.some(c => c.type === "chunk" && Object.keys(c.modules).some(id => id.endsWith("/src/main.tsx")))).toBe(true);
  expect(rewrites).toBe(removeGuard ? 1 : 0);
  return output;
}
const scan = (output: Awaited<ReturnType<typeof renderer>>) => {
  for (const item of output) {
    const text = item.type === "chunk" ? item.code : String(item.source);
    if (/HELP_ASK_FIXTURE_ONLY|__helpAskFixture/.test(text)) throw Error(`Help fixture in ${item.fileName}`);
  }
};
it("scans every real Vite renderer chunk and rejects removal of the import guard", async () => {
  const output = await renderer();
  expect(() => scan(output)).not.toThrow();
  // Execute Vite's emitted port/probe graph in Node, without booting React/DOM.
  // Rebundling resolves exclusively from emitted chunks, never TypeScript sources.
  const chunks = new Map(output.filter(c => c.type === "chunk").map(c => [c.fileName, c.code]));
  const entry = output.find(c => c.type === "chunk" && c.name === "probe")!;
  const executable = await rebundle({ entryPoints: [entry.fileName], bundle: true, write: false, format: "iife",
    plugins: [{ name: "emitted-only", setup(b) {
      b.onResolve({ filter: /.*/ }, args => ({ path: args.importer ? posix.join(posix.dirname(args.importer), args.path) : args.path, namespace: "emitted" }));
      b.onLoad({ filter: /.*/, namespace: "emitted" }, args => {
        const contents = chunks.get(args.path); if (!contents) throw Error(`Not emitted: ${args.path}`);
        return { contents, loader: "js" };
      });
    } }] });
  const injected = { scope() { throw Error("Runtime opt-in reached fixture"); } };
  const context: any = { window: { __helpAskFixture: injected },
    localStorage: { getItem: () => "help-fixture" }, location: { search: "?mode=help-fixture&__helpAskFixture=1" },
    process: { env: { MODE: "help-fixture", HELP_ASK_FIXTURE: "1" } } };
  Object.assign(context.window, { localStorage: context.localStorage, location: context.location });
  runInNewContext(executable.outputFiles[0].text, context);
  const scope = { state: {}, dispatch() {} }; let calls = 0;
  expect(context.helpProbe.askScope(scope)).toBe(scope);
  const api = async () => { calls++; return "real"; };
  expect(context.helpProbe.askApi(api)).toBe(api);
  expect(await context.helpProbe.askApi(api)("/test")).toBe("real"); expect(calls).toBe(1);
  expect(context.window.__helpAskFixture).toBe(injected);
  const negative = await renderer(true);
  expect(() => scan(negative)).toThrow("Help fixture");
}, 180_000);
