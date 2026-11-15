// Startup ordering is the runtime boundary; check-windows-hide.mjs is only lint.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse } from 'yaml';
import { inspectSource } from './check-windows-hide.mjs';
import { SPAWNED_PROXY_FILES } from '../shared/spawned-proxies.mjs';

const installer = 'win-hide-child-process.mjs';
const astOf = source => ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true);
const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
export function firstInstaller(source, file) {
  const first = astOf(source).statements.find(node => !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
    && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node) && !ts.isEmptyStatement(node));
  const specifier = first && ts.isImportDeclaration(first) && !first.importClause ? first.moduleSpecifier
    : first && ts.isExpressionStatement(first) && ts.isCallExpression(first.expression)
      && first.expression.expression.getText() === 'require' && first.expression.arguments.length === 1 ? first.expression.arguments[0] : undefined;
  return !!specifier && ts.isStringLiteral(specifier) && specifier.text.endsWith('/' + installer)
    && (!file || path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.text)) === 'shared/' + installer);
}
function sources(root, dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return /(?:testing|fixtures|vendor|node_modules)$/.test(file) ? [] : sources(root, file);
    return /\.[cm]?[jt]s$/.test(file) && !/\.(?:test|node-test|d)\./.test(file) ? [file] : [];
  });
}
// Only roots are entries. Descendant filenames are intentionally opaque: Node
// carries the preload through execArgv/NODE_OPTIONS, even for eval and CWD paths.
// API discovery is shared with the launch lint; options are NEVER resolved via
// assignments. Overrides must be wrapped at the call itself.
export function inspectChildEntries(file, source) {
  if (!/(child_process|worker_threads|\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(|\.(?:fork|forkFn)\s*\()/.test(source)) return { entries: [], failures: [], sites: [] };
  const ast = astOf(source), failures = [], sites = [];
  const imports = new Set();
  walk(ast, node => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && node.moduleSpecifier.text?.endsWith('/' + installer)
      && path.posix.normalize(path.posix.join(path.posix.dirname(file), node.moduleSpecifier.text)) === 'shared/' + installer) {
      for (const item of node.importClause?.namedBindings?.elements ?? [])
        if (!item.isTypeOnly && (item.propertyName ?? item.name).text === 'withHideInherit') imports.add(item.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
      && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(ast) === 'require'
      && node.initializer.arguments.length === 1 && ts.isStringLiteral(node.initializer.arguments[0])
      && path.posix.normalize(path.posix.join(path.posix.dirname(file), node.initializer.arguments[0].text)) === 'shared/' + installer) {
      for (const item of node.name.elements) if ((item.propertyName ?? item.name).text === 'withHideInherit') imports.add(item.name.text);
    }
  });
  const calls = inspectSource(file, source).filter(call => !call.embedded && call.start !== undefined);
  failures.push(...calls.filter(call => call.kind === 'unrecognized-child-reference').map(call => `${file}:${call.line}: unrecognized child_process reference: ${call.text}`));
  const byStart = new Map(calls.filter(call => call.kind !== 'unrecognized-child-reference').map(call => [call.start, call]));
  const workers = new Set(['Worker']);
  const launchAliases = new Set(['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']);
  // A mutable alias cannot erase an earlier launch: reject it rather than
  // infer which function an assignment selected at runtime.
  walk(ast, node => {
    if (ts.isImportSpecifier(node) && launchAliases.has((node.propertyName ?? node.name).text)) launchAliases.add(node.name.text);
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'Worker' && ts.isIdentifier(node.initializer)) workers.add(node.initializer.text);
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'Worker') workers.add(node.name.text);
    if (ts.isBindingElement(node) && (node.propertyName ?? node.name).text === 'Worker') workers.add(node.name.text);
  });
  // Names are conservatively unioned, never overwritten by later assignments.
  // This is API discovery only; no target or options value is followed.
  let known;
  do {
    known = workers.size + launchAliases.size;
    walk(ast, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && (workers.has(node.initializer.getText(ast)) || /\.Worker$/.test(node.initializer.getText(ast)))) workers.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (launchAliases.has(node.initializer.getText(ast)) || /\.(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/.test(node.initializer.getText(ast)))) launchAliases.add(node.name.text);
    });
  } while (known !== workers.size + launchAliases.size);
  const fail = (node, reason) => failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${reason}`);
  walk(ast, node => {
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && imports.has(node.name.getText(ast))) fail(node, 'inheritance helper may not be shadowed');
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (workers.has(node.right.getText(ast)) || launchAliases.has(node.right.getText(ast)) || /\.(?:Worker|spawn|spawnSync|exec|execFile|execSync|execFileSync|fork)$/.test(node.right.getText(ast))))
      fail(node, 'mutable launch API aliases are not allowed');
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
    const worker = ts.isNewExpression(node) && (workers.has(node.expression.getText(ast)) || /\.Worker$/.test(node.expression.getText(ast)));
    const call = byStart.get(node.getStart(ast)) ?? (launchAliases.has(node.expression.getText(ast)) && !['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'].includes(node.expression.getText(ast)) ? { kind: 'launch' } : undefined);
    // Electron utilityProcess.fork and dependency-injected launchers also
    // override inheritance; check these at the same boundary.
    const injected = /\.(?:fork|forkFn)$/.test(node.expression.getText(ast));
    if (!worker && !call && !injected) return;
    const args = node.arguments ?? [];
    if (args.some(ts.isSpreadElement)) {
      fail(node, 'spread launch arguments make the options position ambiguous');
      return;
    }
    // Do not guess which overload wins. Inspect EVERY slot Node can use as
    // options. In particular fork(file, opts, undefined) uses slot 1.
    const indices = worker || ['exec', 'execSync'].includes(call?.kind) ? [1] : [1, 2];
    let unsafe = false;
    for (const index of indices) {
      const options = args[index];
      if (!options || ts.isArrayLiteralExpression(options) || options.kind === ts.SyntaxKind.NullKeyword
        || options.getText(ast) === 'undefined' || ts.isArrowFunction(options) || ts.isFunctionExpression(options)
        || ts.isStringLiteral(options) || ts.isNumericLiteral(options)
        || options.kind === ts.SyntaxKind.TrueKeyword || options.kind === ts.SyntaxKind.FalseKeyword) continue;
      if (ts.isCallExpression(options) && imports.has(options.expression.getText(ast)) && options.arguments.length === 1) continue;
      if (ts.isObjectLiteralExpression(options) && !options.properties.some(p => ts.isSpreadAssignment(p)
        || p.name && ts.isComputedPropertyName(p.name) || ['env', 'execArgv'].includes(p.name?.text))) continue;
      sites.push({ start: options.getStart(ast), end: options.end });
      unsafe = true;
    }
    if (unsafe) fail(node, 'ambiguous or overriding launch options must use withHideInherit(...) directly');
  });
  return { entries: [], failures, sites };
}
export function checkWindowsHideEntries(root) {
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const entries = new Set([
    'server/index.ts', 'server/sentinel/cli.ts', 'companion/src/index.ts',
    'electron/sentinel-trampoline-entry.mjs', 'electron/browser-extension-host-entry.mjs',
    'server/drivers/browser-extension-mcp.ts', 'scripts/dev-server.mjs', 'scripts/control-murage.ts',
    'scripts/mcp-server.ts', 'scripts/installation-recovery.ts', 'scripts/installation-recovery-worker.ts',
    'scripts/backup-schedule-trigger.ts',
    ...Object.values(SPAWNED_PROXY_FILES).map(file => `server/${file}.ts`),
  ]);
  const failures = [];
  for (const file of ['package.json', 'companion/package.json']) {
    const pkg = JSON.parse(read(file));
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
    for (const entry of [pkg.main, ...bins].filter(Boolean)) entries.add(path.posix.join(path.posix.dirname(file), entry));
  }
  for (const file of ['electron-builder.yml', 'electron-builder.qualification.yml']) {
    const config = parse(read(file));
    if (config.extraMetadata?.main) entries.add(config.extraMetadata.main);
    // Electron's module is in asar; ordinary Node needs the require file outside it.
    if (file === 'electron-builder.yml' && (!config.files.includes('shared/' + installer) || !config.files.includes('shared/win-hide-child-process.cjs'))) failures.push(`${file}: installer missing from files`);
    if (file === 'electron-builder.yml' && !config.extraResources.some(item => item.from === 'shared/win-hide-child-process.cjs' && item.to === 'shared/win-hide-child-process.cjs')) failures.push(`${file}: external require preload missing`);
  }
  // Every server bundle is potentially executable, including new entries.
  const bundle = astOf(read('scripts/bundle-server.mjs'));
  walk(bundle, node => {
    if (ts.isVariableDeclaration(node) && /^(?:ENTRY_POINTS|WHATSAPP_ENTRY_POINTS)$/.test(node.name.getText(bundle))) {
      const value = node.initializer;
      const array = value && ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) ? value.expression.expression : value;
      if (!array || !ts.isArrayLiteralExpression(array)) throw new Error('unresolved bundle entry list');
      for (const item of array.elements) if (ts.isStringLiteral(item)) entries.add('server/' + item.text);
    }
  });
  const files = new Set(['server', 'electron', 'companion/src', 'installer/bin', 'installer/lib', 'shared'].flatMap(dir => sources(root, dir)));
  files.add('electron/vendor/electron-updater.cjs');
  const checked = new Set();
  // Registered script roots are scanned without following descendant targets.
  for (const file of entries) files.add(file);
  for (const file of files) {
    let source;
    try { source = read(file); }
    catch { failures.push(`${file}: child entry cannot be read`); continue; }
    if (source.startsWith('#!')) entries.add(file);
    const found = inspectChildEntries(file, source);
    for (const entry of found.entries) { entries.add(entry); files.add(entry); }
    failures.push(...found.failures);
    checked.add(file);
  }
  for (const file of entries) {
    if (checked.has(file) && !firstInstaller(read(file), file)) failures.push(`${file}: first executable import must install windowsHide`);
  }
  return { entries: [...entries].sort(), failures };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = checkWindowsHideEntries(fileURLToPath(new URL('../', import.meta.url)));
  for (const failure of result.failures) console.error(failure);
  console.log(`Windows entry order: ${result.entries.length} entries; ${result.failures.length} failures.`);
  if (result.failures.length) process.exitCode = 1;
}
