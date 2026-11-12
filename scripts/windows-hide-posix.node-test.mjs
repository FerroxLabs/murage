import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { withHideInherit } from '../shared/win-hide-child-process.mjs';
import { openBlankTerminal } from '../electron/terminal-launch.mjs';

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: terminal passes the pre-lane options to Node byte for byte`, async () => {
    let received;
    const run = (_file, _args, options, callback) => {
      received = options;
      const child = new EventEmitter();
      queueMicrotask(() => { child.emit('spawn'); callback?.(null); });
      return child;
    };
    assert.equal(await openBlankTerminal(platform, run), true);
    assert.equal(JSON.stringify(received), JSON.stringify(platform === 'darwin' ? { timeout: 15000 } : undefined));
  });
  test(`${platform}: procs plain, seatbelt and bwrap options match pre-lane bytes`, () => {
    const source = readFileSync(new URL('../server/procs.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('procs.ts', source, ts.ScriptTarget.Latest, true);
    const options = new Map();
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'spawn') options.set(node.arguments[0].getText(ast), node.arguments[2].getText(ast));
      ts.forEachChild(node, visit);
    };
    visit(ast);
    const rest = { cwd: '/fixture', env: { FIXTURE: 'isolated' } }, stdio = ['pipe', 'pipe', 'pipe'];
    const context = { withHideInherit, process: { platform }, rest, stdio, launch: null, plan: { env: { PATH: '/fixture' } }, opts: rest, wrappedStdio: [...stdio, 'pipe'] };
    const expected = new Map([
      ['command', { ...rest, stdio, detached: true }],
      ['posixPower.command', { ...rest, stdio, detached: true }],
      ['plan.command', { env: context.plan.env, cwd: rest.cwd, stdio: context.wrappedStdio, detached: true }],
    ]);
    for (const [target, before] of expected) {
      const js = ts.transpile(`(${options.get(target)})`, { target: ts.ScriptTarget.ESNext });
      assert.equal(JSON.stringify(runInNewContext(js, context)), JSON.stringify(before), target);
    }
  });
}

// Freeze the pre-lane expressions, including insertion order, undefined
// options and caller spreads. Combined with the native-boundary POSIX tests,
// equality prevents future local annotations from changing Node's options.
test('every call-site option changed by the lane retains its pre-lane expression', () => {
  const inventory = JSON.parse(readFileSync(new URL('./windows-hide-posix-options.json', import.meta.url), 'utf8'));
  assert.ok(inventory.sites.length > 60);
  const printer = ts.createPrinter({ removeComments: true });
  const canonical = expression => {
    if (expression == null) return null;
    if (expression.startsWith('withHideInherit(')) expression = expression.slice(16, -1);
    const ast = ts.createSourceFile('option.ts', `(${expression});`, ts.ScriptTarget.Latest, true);
    return printer.printFile(ast);
  };
  const cache = new Map();
  for (const site of inventory.sites) {
    if (!cache.has(site.file)) {
      const source = readFileSync(new URL('../' + site.file, import.meta.url), 'utf8');
      const ast = ts.createSourceFile(site.file, source, ts.ScriptTarget.Latest, true), calls = [], counts = new Map();
      const visit = node => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText(ast), ordinal = counts.get(callee) ?? 0;
          counts.set(callee, ordinal + 1);
          calls.push({ callee, ordinal, args: node.arguments.map(arg => arg.getText(ast)) });
        }
        ts.forEachChild(node, visit);
      };
      visit(ast); cache.set(site.file, calls);
    }
    const call = cache.get(site.file).find(call => call.callee === site.callee && call.ordinal === site.ordinal);
    assert.ok(call, `${site.file}: ${site.callee} #${site.ordinal}`);
    assert.equal(canonical(call.args[site.index]), canonical(site.options), `${site.file}: ${site.callee} #${site.ordinal}`);
  }
});
