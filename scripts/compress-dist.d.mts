import type { Plugin } from "vite";

/** Extensions the build writes `.br` and `.gz` copies of. */
export const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string>;
/** Files smaller than this get no copy. */
export const MIN_COMPRESS_BYTES: number;
/** Write `.br` and `.gz` beside every hashed text file in a built `dist/`; returns the paths written. */
export function compressDist(dir: string): Promise<string[]>;
/** The vite plugin that runs `compressDist` on the output directory after a build. */
export function precompressPlugin(): Plugin & {
  configResolved(config: { root: string; build: { outDir: string } }): void;
  closeBundle(): Promise<void>;
};
