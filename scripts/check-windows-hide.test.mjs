import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { inspectSource, POSIX_ONLY } from "./check-windows-hide.mjs";

const failures = source => inspectSource("fixture.ts", source).filter(call => !call.hidden);
it.each([
  `import {createRequire} from 'node:module'; const req = createRequire(import.meta.url); const {spawn: run} = req('node:child_process'); run('cmd', []);`,
  `import * as cp from 'node:child_process'; let run; ({spawn: run} = cp); run('cmd', []);`,
  `import {createRequire as makeRequire} from 'module'; const req = makeRequire(import.meta.url); const cp = req('child_process'); let run; run = cp.spawn; run('cmd', []);`,
  `import * as module from 'node:module'; const req = module.createRequire(import.meta.url); let cp; cp = req('child_process'); let run; function start() { ({spawn: run} = cp); } run('cmd', []);`,
])('rejects unhidden launches through assigned bindings: %s', source => {
  expect(failures(source)).toHaveLength(1);
  expect(failures(source.replace("run('cmd', [])", "run('cmd', [], {windowsHide:true})"))).toHaveLength(0);
});

it('checks both branches of the old Codex launcher passed through node -e configuration', () => {
  const source = readFileSync(new URL('../server/drivers/codex.ts', import.meta.url), 'utf8');
  const old = source.replaceAll('windowsHide:true,', '').replace('  windowsHidePrelude,', '');
  const embedded = failures(old).filter(call => call.embedded);
  expect(embedded).toHaveLength(2);
  expect(embedded.every(call => call.kind === 'spawn')).toBe(true);
});

it.each(['-e', '--eval'])("checks statically assembled executable strings after %s", flag => {
  const code = `const cp = require('node:child_process'); cp.spawn('cmd', []);`;
  for (const value of [JSON.stringify(code), `[${JSON.stringify(code)}].join('')`, '`' + code + '`']) {
    const source = `const program = ${value}; const alias = program; const config = {args: ['${flag}', alias]};`;
    expect(failures(source)).toHaveLength(1);
    expect(failures(source)[0]).toMatchObject({embedded: true, line: 1, kind: 'spawn'});
    expect(failures(source.replace("cp.spawn('cmd', [])", "cp.spawn('cmd', [], {windowsHide:true})"))).toHaveLength(0);
  }
});

describe("Windows child-process launch guard", () => {
  it.each(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"])("requires literal windowsHide: true for %s", name => {
    const prefix = `import { ${name} } from 'node:child_process';`;
    const args = name === "exec" || name === "execSync" ? "'cmd'" : "'cmd', []";
    expect(failures(`${prefix} ${name}(${args});`)).toHaveLength(1);
    expect(failures(`${prefix} ${name}(${args}, { env: {} });`)).toHaveLength(1);
    expect(failures(`${prefix} ${name}(${args}, { windowsHide: false });`)).toHaveLength(1);
    expect(failures(`${prefix} ${name}(${args}, options);`)).toHaveLength(1);
    expect(failures(`${prefix} ${name}(${args}, { windowsHide: true });`)).toHaveLength(0);
  });
  it.each([
    "import { spawn as start } from 'child_process'; start('x', []);",
    "import * as cp from 'node:child_process'; cp.spawn('x', []);",
    "import cp from 'child_process'; cp['execFile']('x', []);",
    "const {execFile: run} = require('node:child_process'); run('x', []);",
    "const cp = require('child_process'); (0, cp.spawn)('x', []);",
    "const {execFile} = await import('node:child_process'); const run = promisify(execFile); run('x', []);",
    "import {spawn} from 'child_process'; function f({start = spawn} = {}) { start('x', []); }",
    "import {spawn} from 'child_process'; const start = deps.spawn ?? spawn; start('x', []);",
  ])("finds aliases: %s", source => expect(failures(source)).toHaveLength(1));
  it("checks the underlying launch of a named helper", () => {
    const prefix = "import {spawn} from 'child_process';";
    expect(failures(`${prefix} function start(cmd,args,options) { return spawn(cmd,args,{...options,windowsHide:true}); } start('x',[]);`)).toHaveLength(0);
    expect(failures(`${prefix} function start(cmd,args,options) { return spawn(cmd,args,options); } start('x',[]);`)).toHaveLength(1);
  });
  it("does not mistake comments, strings, regex, SQL or Electron utility processes for Node launches", () => {
    expect(inspectSource("x.ts", `// spawn('x')\nconst text = "exec('x')"; /x/.exec(text); db.exec('BEGIN'); utilityProcess.fork('x');`)).toEqual([]);
  });
  it("keeps exemptions few, exact and explained", () => {
    expect(POSIX_ONLY.size).toBeLessThanOrEqual(5);
    for (const [file, reason] of POSIX_ONLY) { expect(file).not.toMatch(/[*?]/); expect(reason.length).toBeGreaterThan(30); }
  });
  it("runs in the blocking repository-check workflow", () => {
    const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    const step = Object.values(ci.jobs).flatMap(job => job.steps ?? []).find(step => step.run === 'node scripts/check-windows-hide.mjs');
    expect(step).toBeDefined();
    expect(step['continue-on-error']).toBeUndefined();
    expect(step.if).toBeUndefined();
  });
});

it("respects lexical aliases and ignores unrelated helpers with the same name", () => {
  const source = `import {execFile} from 'node:child_process';
    function a(run = execFile) { run('x', [], {}); }
    function b(run = () => {}) { run('unrelated'); }
    function c() { const spawn = async model => model; spawn('model'); }`;
  expect(failures(source)).toHaveLength(1);
});
it("sees options checked with satisfies and injected process APIs", () => {
  expect(failures(`import {spawn} from 'child_process'; spawn('x', [], {windowsHide:true} satisfies SpawnOptions);`)).toHaveLength(0);
  expect(failures(`function start({spawn}) { spawn('x', []); }`)).toHaveLength(1);
});
it("does not let a later spread or duplicate key undo windowsHide", () => {
  const prefix = "import {spawn} from 'node:child_process';";
  for (const options of ["{windowsHide:true,...options}", "{windowsHide:true,windowsHide:false}", "{windowsHide:true,[key]:false}"]) {
    expect(failures(`${prefix} spawn('x', [], ${options});`)).toHaveLength(1);
  }
  expect(failures(`${prefix} spawn('x', [], {...options,windowsHide:true});`)).toHaveLength(0);
});

it("audits every updater launch without modifying upstream POSIX options", async () => {
  const source = readFileSync(new URL('../electron/vendor/electron-updater.cjs', import.meta.url), 'utf8');
  const launches = inspectSource('electron/vendor/electron-updater.cjs', source);
  expect(launches).toHaveLength(6);
  const { patchUpdaterWindowsHide } = await import('./patch-updater-windows-hide.mjs');
  expect(patchUpdaterWindowsHide(source)).toBe(source);
  expect(() => patchUpdaterWindowsHide(source.replace('child_process_1.spawnSync', 'changed.spawnSync'))).toThrow();
  const builder = readFileSync(new URL('./bundle-updater.mjs', import.meta.url), 'utf8');
  expect(builder).toContain('patchUpdaterWindowsHide(withQuitCauses)');
});
it("follows a process API stored on a class instance", () => {
  const source = `import {fork as nodeFork} from 'node:child_process';
    class Host { constructor(options) { this.forkFn = options.fork ?? nodeFork; }
      start() { this.forkFn('x', [], {}); } }`;
  expect(failures(source)).toHaveLength(1);
  expect(failures(source.replace("[], {}", "[], {windowsHide:true}"))).toHaveLength(0);
});

it.each([
  `import('node:child_process').then(({spawn: run}) => run('cmd', []));`,
  `import * as mod from 'node:module'; let make; ({createRequire: make} = mod); const cp = make(import.meta.url)('node:child_process'); cp.spawn('cmd', []);`,
  `import {promisify as later} from 'node:util'; import {execFile} from 'node:child_process'; const run = later(execFile); run('cmd', []);`,
  `import {spawn} from 'node:child_process'; const [run] = [spawn]; run('cmd', []);`,
  `import run from 'cross-spawn'; run('cmd', [], {windowsHide:false});`,
  `import {execa} from 'execa'; execa('cmd', [], {windowsHide:false});`,
  `import {run} from './reexport.js'; run('cmd', [], {windowsHide:false});`,
  `const options = {}; options.windowsHide = false;`,
  `const config = { args: ['-e', unknownPayload] };`,
  "const code = `const cp = require('node:child_process'); cp.spawn('${name}')`; const args = ['-e', code];",
  `let code; code = "require('child_process').spawn('cmd')"; const args = ['-e', code];`,
])('lints review counterexample: %s', source => expect(failures(source).length).toBeGreaterThan(0));

it('requires inline launchers to install the shared default or hide each launch', () => {
  const source = readFileSync(new URL('../server/drivers/codex.ts', import.meta.url), 'utf8');
  expect(failures(source).filter(call => call.embedded)).toEqual([]);
  expect(failures(source.replace('  windowsHidePrelude,', '')).filter(call => call.embedded)).toHaveLength(2);
});
