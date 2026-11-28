import { it, expect } from 'vitest';
import { build } from 'esbuild';
import { windowsHideBundlePlugin } from './windows-hide-bundle-plugin.mjs';
import ts from 'typescript';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as installer from '../shared/win-hide-child-process.mjs';
import { stagePiWindowsHide } from './stage-pi-windows-hide.mjs';
import { removeTempDir } from '../server/testing/cleanup.ts';

it('installs before external dependencies evaluate in an esbuild bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'winhide-bundle-'));
  try {
    const entry = join(dir, 'entry.mjs'), output = join(dir, 'bundle.mjs');
    const launcher = join(dir, 'external.mjs');
    writeFileSync(entry, `import ${JSON.stringify(fileURLToPath(new URL('../shared/win-hide-child-process.mjs', import.meta.url)))}; import './external.mjs';`);
    writeFileSync(launcher, `import {spawn} from 'node:child_process'; const run = spawn; run('fixture');`);
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', external: ['./external.mjs'], plugins: [windowsHideBundlePlugin()], banner: { js: installer.windowsHideImport ?? '' } });
    const bootstrap = `import cp from 'node:child_process';
      Object.defineProperty(process,'platform',{value:'win32'});
      cp.ChildProcess.prototype.spawn=function(o){process.stdout.write(JSON.stringify({hidden:o.windowsHide}));throw Error('captured')};
      try {await import(${JSON.stringify(pathToFileURL(output).href)})}catch(e){if(e.message!=='captured')throw e}`;
    expect(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', bootstrap], { windowsHide: true, encoding: 'utf8' }))).toEqual({ hidden: true });
  } finally { await removeTempDir(dir); }
});
it('all production Node bundlers put the installer import in their banner', () => {
  for (const file of ['bundle-server.mjs', 'bundle-companion.mjs', 'prepare-browser-extension.mjs']) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const field = (node, name) => node?.properties?.find(p => p.name?.getText(ast) === name)?.initializer;
    let builds = 0;
    const visit = node => {
      if (ts.isCallExpression(node) && ['build', 'buildImpl'].includes(node.expression.getText(ast))) {
        const options = node.arguments[0];
        if (field(options, 'platform')?.text === 'node') {
          builds++;
          expect(field(field(options, 'banner'), 'js')?.getText(ast), file).toMatch(/^windowsHideImport(?:$| \+)/);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(builds, file).toBeGreaterThan(0);
  }
});
it('copied Pi extensions carry a resolvable installer in the packaged server tree', async () => {
  const source = readFileSync(new URL('./bundle-server.mjs', import.meta.url), 'utf8');
  expect(source).toContain('stagePiWindowsHide');
  const dir = mkdtempSync(join(tmpdir(), 'murage-winhide-pi-'));
  try {
    stagePiWindowsHide(process.cwd(), dir);
    for (const name of ['pi-mcp-extension.ts', 'pi-permission-gate.ts']) {
      expect(readFileSync(join(dir, 'drivers', name), 'utf8')).not.toContain('../../shared/win-hide-child-process.mjs');
      expect(readFileSync(join(dir, 'drivers', name), 'utf8')).toMatch(/^import "\.\.\/shared\/win-hide-child-process\.mjs";/);
    }
    expect(readFileSync(join(dir, 'shared/win-hide-child-process.mjs'), 'utf8')).toBe(readFileSync(new URL('../shared/win-hide-child-process.mjs', import.meta.url), 'utf8'));
    const gate = readFileSync(join(dir, 'drivers/pi-permission-gate.ts'), 'utf8');
    // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: the gate carries the approved checker as a staged generated copy, not the hand-written floor.
    expect(gate).toContain('import { noLimitsWipe, nativeWipeBreaker, RootRegistry } from "./pi-wipe-check.generated.mjs";');
    expect(gate).not.toContain('function visibleWipe(');
    expect(readFileSync(join(dir, 'drivers/pi-wipe-check.generated.mjs'), 'utf8')).toBe(readFileSync(new URL('../server/drivers/pi-wipe-check.generated.mjs', import.meta.url), 'utf8'));
    // Bundling from this isolated output resolves the complete runtime graph
    // of BOTH extensions, including exports and the MCP bridge's shared files.
    for (const name of ['pi-permission-gate.ts', 'pi-mcp-extension.ts']) {
      const bundled = await build({ entryPoints: [join(dir, 'drivers', name)], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, nodePaths: [join(process.cwd(), 'node_modules')] });
      expect(Object.keys(bundled.metafile.inputs).some(file => file.endsWith(name))).toBe(true);
    }
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    // Load the staged extension in a fresh process with no repository siblings.
    for (const name of ['pi-permission-gate.ts', 'pi-mcp-extension.ts']) execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import {pathToFileURL} from 'node:url'; await import(pathToFileURL(${JSON.stringify(join(dir, 'drivers', name))}).href);`], {timeout: 20_000});

  } finally { await removeTempDir(dir); }
});

it('the portable Pi gate carries the shared payload identity marker exactly', () => {
  const shared = readFileSync(new URL('../shared/flux-route.ts', import.meta.url), 'utf8');
  const gate = readFileSync(new URL('../server/drivers/pi-permission-gate.ts', import.meta.url), 'utf8');
  const marker = shared.match(/export (function registerBusyloopPayloadSite<T>[\s\S]*?\n})/)[1];
  expect(gate).toContain(marker);
});

it('the standalone installer archive includes its shared startup dependency', () => {
  const archive = readFileSync(new URL('../.github/workflows/package-linux-service-qualification.yml', import.meta.url), 'utf8');
  expect(archive).toMatch(/package.json installer\/bin installer\/lib shared\/win-hide-child-process\.mjs/);
});

it('Pi staging discovers new nested, re-exported and dynamic dependencies with cycles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'murage-pi-graph-'));
  const output = join(root, 'isolated');
  try {
    mkdirSync(join(root, 'server/drivers'), { recursive: true });
    mkdirSync(join(root, 'shared/nested'), { recursive: true });
    writeFileSync(join(root, 'shared/win-hide-child-process.mjs'), "import './nested/leaf.mjs';");
    writeFileSync(join(root, 'shared/nested/leaf.mjs'), "export { value } from '../new-dependency.mjs';");
    writeFileSync(join(root, 'shared/new-dependency.mjs'), "import './nested/leaf.mjs'; export const value = 42;");
    writeFileSync(join(root, 'server/drivers/pi-mcp-extension.ts'), 'import "../../shared/win-hide-child-process.mjs"; export const load = () => import("../../shared/new-dependency.mjs");');
    writeFileSync(join(root, 'server/drivers/pi-permission-gate.ts'), 'export { value } from "../../shared/nested/leaf.mjs";');
    stagePiWindowsHide(root, output);
    const gate = join(output, 'drivers/pi-permission-gate.ts');
    const mcp = join(output, 'drivers/pi-mcp-extension.ts');
    const result = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const gate = await import(${JSON.stringify(pathToFileURL(gate).href)}); const mcp = await import(${JSON.stringify(pathToFileURL(mcp).href)}); console.log(gate.value, (await mcp.load()).value);`], { encoding: 'utf8', timeout: 20_000 });
    expect(result.trim()).toBe('42 42');
  } finally { await removeTempDir(root); }
});
