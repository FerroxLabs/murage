// The first paint loads only what a chat needs (spec §6).
//
// A phone over cellular pays for every byte of the entry chunk before it can
// show a single message, and Vite puts in that chunk everything reachable
// from src/main.tsx through static imports. The call screen with its speech
// model runtime, both Markdown editors with Tiptap, Settings, and the computer
// panel are each opened by a tap, so each is reached through `lazy()` or
// `await import()` instead. That is a property of the import graph, not of a
// build, so this reads the graph the way a bundler does: esbuild's metafile,
// which records for every import whether it is static or dynamic. No build
// output is written or needed.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

const graphOnly: Plugin = {
  name: "first-paint-graph",
  setup(build) {
    // Vite-only suffixes (?url, ?raw) name a file, not a module.
    build.onResolve({ filter: /\?(?:url|raw)$/ }, (args) => ({ path: args.path, external: true }));
    // `@/…` is the app (tsconfig paths); every other bare specifier is a
    // package, recorded by name and not walked. (esbuild filters are Go
    // regular expressions, which have no lookahead, hence the check inside.)
    build.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@/") ? undefined : { path: args.path, external: true }));
  },
};

let graph: Metafile;
beforeAll(async () => {
  const result = await build({
    entryPoints: [join(root, "src/main.tsx")],
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    loader: { ".css": "empty", ".webp": "empty", ".png": "empty", ".svg": "empty", ".jpg": "empty" },
    logLevel: "silent",
    plugins: [graphOnly],
  });
  graph = result.metafile;
}, 60_000);

/** Every module and package main.tsx reaches through static imports alone. */
export function staticallyReached(meta: Metafile, entry = "src/main.tsx"): Set<string> {
  const reached = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    for (const edge of meta.inputs[queue.pop()!]?.imports ?? []) {
      if (edge.kind === "dynamic-import" || reached.has(edge.path)) continue;
      reached.add(edge.path);
      if (!edge.external) queue.push(edge.path);
    }
  }
  return reached;
}

const importsOf = (file: string) => graph.inputs[file]?.imports ?? [];

describe("the first paint", () => {
  it("really is reading the app's graph, so an empty answer cannot pass", () => {
    const reached = staticallyReached(graph);
    expect(reached.size).toBeGreaterThan(200);
    for (const file of ["src/App.tsx", "src/components/ChatView.tsx", "src/components/ChatHeader.tsx", "react"]) {
      expect(reached, file).toContain(file);
    }
  });

  it("leaves the call screens and the speech model runtime to the first call", () => {
    const reached = staticallyReached(graph);
    for (const file of ["src/components/CallView.tsx", "src/components/GroupCallView.tsx", "src/lib/call-mic.ts", "src/lib/silero-vad.ts"]) {
      expect(reached, file).not.toContain(file);
      // …and they are still in the app, one dynamic import away
      expect(graph.inputs[file], file).toBeDefined();
    }
    expect([...reached].filter((path) => path.startsWith("onnxruntime-web"))).toEqual([]);
    // The buttons stay: the header shows them before anyone calls.
    expect(reached).toContain("src/components/CallControls.tsx");
  });

  it("loads the speech detector with the microphone, not with the call screen", () => {
    const silero = importsOf("src/lib/call-mic.ts").filter((edge) => edge.path === "src/lib/silero-vad.ts");
    expect(silero.map((edge) => edge.kind)).toEqual(["dynamic-import"]);
  });

  it("opens Settings, a bot's settings and the computer panel on first use", () => {
    const reached = staticallyReached(graph);
    for (const file of ["src/components/SettingsModal.tsx", "src/components/BotSettingsDialog.tsx", "src/components/SettingsPanel.tsx", "src/components/ComputerPanel.tsx"]) {
      expect(reached, file).not.toContain(file);
      expect(graph.inputs[file], file).toBeDefined();
    }
  });
});
