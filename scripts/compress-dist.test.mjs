// The build's compressed copies, for the browser door (companion/src/browser.ts
// `relayPrecompressed`). What matters: every hashed text file gets both, the
// shell and anything else whose name outlives its content gets neither, and a
// second run changes nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { compressDist, precompressPlugin } from "./compress-dist.mjs";

const FRAME = "mermaid-frame-0123456789abcdef.html";
let dist = "";

const build = () => {
  dist = mkdtempSync(join(tmpdir(), "murage-dist-"));
  mkdirSync(join(dist, "assets"));
  const js = "export const line = 1;\n".repeat(400);
  writeFileSync(join(dist, "assets", "index-AbC123.js"), js);
  writeFileSync(join(dist, "assets", "ort-wasm-simd-threaded-Q1w2.wasm"), Buffer.alloc(8192, 0));
  writeFileSync(join(dist, "assets", "logo-AbC123.png"), Buffer.alloc(8192, 7));
  writeFileSync(join(dist, "assets", "tiny-AbC123.css"), "a{color:red}");
  writeFileSync(join(dist, FRAME), `<!doctype html>${"<p>frame</p>".repeat(200)}`);
  writeFileSync(join(dist, "index.html"), `<!doctype html>${"<!-- shell -->".repeat(200)}`);
  writeFileSync(join(dist, "sw.js"), "self.addEventListener('fetch', () => {});\n".repeat(100));
  return js;
};

afterEach(() => {
  if (dist) rmSync(dist, { recursive: true, force: true });
  dist = "";
});

describe("compressed copies of the build", () => {
  it("writes both copies beside every hashed text file, and they decode to the file", async () => {
    const js = build();
    await compressDist(dist);
    const file = join(dist, "assets", "index-AbC123.js");
    expect(brotliDecompressSync(readFileSync(`${file}.br`)).toString()).toBe(js);
    expect(gunzipSync(readFileSync(`${file}.gz`)).toString()).toBe(js);
    expect(existsSync(join(dist, "assets", "ort-wasm-simd-threaded-Q1w2.wasm.br"))).toBe(true);
    expect(existsSync(join(dist, `${FRAME}.br`))).toBe(true);
    expect(existsSync(join(dist, `${FRAME}.gz`))).toBe(true);
  });

  it("leaves images, tiny files and everything whose name outlives its content alone", async () => {
    build();
    await compressDist(dist);
    for (const name of ["logo-AbC123.png", "tiny-AbC123.css"]) {
      expect(existsSync(join(dist, "assets", `${name}.br`)), name).toBe(false);
    }
    // The door rewrites the shell per response; a copy of it would be wrong.
    for (const name of ["index.html", "sw.js"]) {
      expect(existsSync(join(dist, `${name}.br`)), name).toBe(false);
      expect(existsSync(join(dist, `${name}.gz`)), name).toBe(false);
    }
  });

  it("changes nothing on a second run", async () => {
    build();
    await compressDist(dist);
    const first = readdirSync(join(dist, "assets")).sort();
    expect(await compressDist(dist)).toEqual(
      expect.arrayContaining([expect.stringMatching(/index-AbC123\.js\.br$/)]),
    );
    expect(readdirSync(join(dist, "assets")).sort()).toEqual(first);
    expect(first.some((name) => name.endsWith(".br.br") || name.endsWith(".gz.br"))).toBe(false);
  });

  it("runs from vite once the bundle is on disk, and only for a build", async () => {
    build();
    const plugin = precompressPlugin();
    expect(plugin.name).toBe("murage-precompress");
    expect(plugin.apply).toBe("build");
    plugin.configResolved({ root: dist, build: { outDir: "." } });
    await plugin.closeBundle();
    expect(existsSync(join(dist, "assets", "index-AbC123.js.br"))).toBe(true);
  });
});
