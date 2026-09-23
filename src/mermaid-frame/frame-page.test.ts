import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { frameHtml } from "../../scripts/vite-render-plugin.ts";

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
