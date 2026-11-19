import { windowsHideBundlePlugin } from './windows-hide-bundle-plugin.mjs';
import { windowsHideImport } from "../shared/win-hide-child-process.mjs";
// The companion is packaged outside the asar. Bundle its shared installer so
// its first import cannot resolve into a source-only ../../shared directory.
import { build } from 'esbuild';
await build({
  entryPoints: ['companion/src/index.ts'],
  outfile: 'dist-companion/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  plugins: [windowsHideBundlePlugin()],
  banner: { js: windowsHideImport },
  allowOverwrite: true,
});
