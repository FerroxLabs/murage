import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { FRAME_PATH_DEFINE, frameFileName, frameHtml, murageRenderPlugins } from "../../scripts/vite-render-plugin.ts";
import { MERMAID_FRAME_PATH } from "./protocol";

// The page `vite build` emits as dist/mermaid-frame.html, built the same way.
it("builds a frame page whose only script is the inline one its CSP names by hash", async () => {
  const html = await frameHtml({ minify: true });
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
  expect(csp).toBeDefined();
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("img-src data:");
  expect(csp).not.toMatch(/https?:|\*|'self'|unsafe-eval|connect-src|frame-src|'unsafe-inline'[^;]*script/);
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  expect(scripts[0]![1]).toBe(""); // inline, classic: no src, no type=module
  const hash = createHash("sha256").update(scripts[0]![2]!, "utf8").digest("base64");
  expect(csp).toContain(`script-src 'sha256-${hash}'`);
  // the CSP meta comes before the script it governs
  expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
}, 60_000);

// The frame is 5 MB. Named by its content, the browser door can let a phone
// keep it for a year and a release still reaches it the day it ships.
it("names the built frame by its content, and tells the app that name before any module is built", async () => {
  const html = await frameHtml({ minify: true });
  const name = frameFileName(html);
  expect(name).toMatch(/^mermaid-frame-[0-9a-f]{16}\.html$/);
  expect(frameFileName(html)).toBe(name);
  expect(frameFileName(`${html}\n`)).not.toBe(name);

  const plugin = murageRenderPlugins().find((p) => p.name === "murage-mermaid-frame")!;
  type ConfigHook = (config: object, env: { command: "build" | "serve"; mode: string }) => Promise<unknown>;
  const config = plugin.config as unknown as ConfigHook;
  // The same bytes the test built, so the same name: a frame whose name
  // drifted between the define and the emitted file is a 404 in every chat.
  expect(await config({}, { command: "build", mode: "production" })).toEqual({
    define: { [FRAME_PATH_DEFINE]: JSON.stringify(`/${name}`) },
  });
  // The dev server keeps serving the plain name from its middleware.
  expect(await config({}, { command: "serve", mode: "development" })).toBeUndefined();

  const emitted: Array<{ fileName?: string; source?: unknown }> = [];
  const generateBundle = plugin.generateBundle as unknown as (this: { emitFile: (file: object) => void }) => Promise<void>;
  await generateBundle.call({ emitFile: (file) => emitted.push(file as { fileName?: string; source?: unknown }) });
  expect(emitted).toEqual([{ type: "asset", fileName: name, source: html }]);
}, 120_000);

it("keeps the plain name wherever no build has named the frame", () => {
  // dev, this test run, and the frame's own bundle all see no define
  expect(MERMAID_FRAME_PATH).toBe("/mermaid-frame.html");
});
