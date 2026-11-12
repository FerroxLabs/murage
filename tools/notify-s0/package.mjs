// Generate a separate build configuration; do not edit the release config.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const { parse } = createRequire(import.meta.url)('yaml');
const config = parse(readFileSync('electron-builder.yml','utf8'));
config.extraMetadata = { ...config.extraMetadata, main:'tools/notify-s0/entry.mjs' };
config.files.push('tools/notify-s0/entry.mjs','tools/notify-s0/kit.mjs','server/testing/safe-wipe.mjs');
config.directories.output = 'release-notify-s0';
config.artifactName = 'Murage-S0-QUALIFICATION-${version}-${arch}.${ext}';
config.publish = null;
writeFileSync(resolve(process.argv[2] ?? 'notify-s0-builder.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
console.log('S0_CONFIG: build with electron-builder --config notify-s0-builder.json --publish never; never distribute as the product');
