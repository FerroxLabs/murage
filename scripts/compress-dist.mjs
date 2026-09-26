// Pre-compressed copies of the built UI, for the browser door.
//
// The door (companion/src/browser.ts `relayPrecompressed`) asks the harness
// for `<file>.br` or `<file>.gz` before it compresses anything itself, and
// this is where those files come from. Brotli at its maximum quality is far
// too slow to run per request and costs nothing here, once per build — and it
// is the difference that matters for the 5.5 MB main script on a phone.
//
// Only files whose names change when their content does: everything in
// `assets/` (vite's hashes) and the content-hashed diagram frame. The shell,
// the service worker and the manifest keep their names across releases and
// the door rewrites the shell per response anyway, so a copy of any of them
// would be stale or wrong; the door compresses those on the fly.
//
// A vite plugin rather than a step in `pnpm build`, because CI runs
// `pnpm exec vite build` directly (.github/workflows/ci.yml:228, :305), and a
// post-step nothing runs is a build that ships without its copies. No
// dependency: node's zlib has had brotli since v11.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Worth compressing. Images and fonts in `assets/` are compressed formats already. */
export const COMPRESSIBLE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".json", ".svg", ".wasm", ".html"]);
/** Below this a copy is not worth a file. The door's floor is the same (companion/src/encoding.ts). */
export const MIN_COMPRESS_BYTES = 1024;
const FRAME = /^mermaid-frame-[0-9a-f]{16}\.html$/;

/** Write `.br` and `.gz` beside every hashed text file in a built `dist/`.
 * Returns the paths written. A second run rewrites the same copies and adds
 * none, because `.br` and `.gz` are not extensions it compresses. */
export async function compressDist(dir) {
  const assets = join(dir, "assets");
  const files = [
    ...(await readdir(assets).catch(() => [])).map((name) => join(assets, name)),
    ...(await readdir(dir)).filter((name) => FRAME.test(name)).map((name) => join(dir, name)),
  ];
  const written = [];
  for (const file of files) {
    const ext = extname(file);
    if (!COMPRESSIBLE_EXTENSIONS.has(ext)) continue;
    const bytes = await readFile(file);
    if (bytes.byteLength < MIN_COMPRESS_BYTES) continue;
    const br = await brotli(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_MODE]: ext === ".wasm" ? constants.BROTLI_MODE_GENERIC : constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
      },
    });
    const gz = await gzipAsync(bytes, { level: constants.Z_BEST_COMPRESSION });
    for (const [suffix, packed] of [[".br", br], [".gz", gz]]) {
      // A copy no smaller than the file is a worse answer than the file.
      if (packed.byteLength >= bytes.byteLength) continue;
      await writeFile(`${file}${suffix}`, packed);
      written.push(`${file}${suffix}`);
    }
  }
  return written;
}

/** The vite half: runs after the bundle, the diagram frame included, is on disk. */
export function precompressPlugin() {
  let outDir = resolve("dist");
  return {
    name: "murage-precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      await compressDist(outDir);
    },
  };
}
