import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
const read = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');
it('Ubuntu retains the complete required TypeScript gate with 12 GB heap',()=>{
 const ci=parse(read('.github/workflows/ci.yml'));
 const step=ci.jobs.quality.steps.find(s=>s.name==='Typecheck');
 expect(step.run).toBe('pnpm typecheck');expect(step.if).toBe("matrix.os != 'macos-latest'");
 expect(ci.jobs.quality.env.NODE_OPTIONS).toContain('--max-old-space-size=12288');
 const pkg=JSON.parse(read('package.json'));
 expect(pkg.scripts.typecheck).toBe('tsc -b && tsc -p tsconfig.server.json && tsc -p tools/flux-stream-conformance/tsconfig.json');
 expect(ci.jobs.required.needs).toContain('quality');
});
it('Mac packaging bundles the renderer and other platforms retain the checked build',()=>{
 const source=read('scripts/build-package-renderer.mjs');
 expect(source).toContain('process.platform === "darwin" ? ["exec", "vite", "build"] : ["build"]');
 expect(JSON.parse(read('package.json')).scripts['package:prepare']).toContain('node scripts/build-package-renderer.mjs');
 for(const file of ['.github/workflows/package-linux.yml','.github/workflows/package-win.yml','.github/workflows/release.yml']) {
  const jobs=parse(read(file)).jobs;
  for(const job of Object.values(jobs)) {
   const runner=job['runs-on'];
   if(typeof runner !== 'string'||!/^(ubuntu|windows)/.test(runner)) continue;
   if(job.steps?.some(step=>/pnpm (?:build|typecheck|package:)/.test(step.run??''))) expect(job.env?.NODE_OPTIONS,file).toBe('--max-old-space-size=12288');
  }
 }
});
