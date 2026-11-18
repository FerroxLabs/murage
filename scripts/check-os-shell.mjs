// r3.1 §2: inspect source AND final package bytes, including vendor bundles,
// nested node_modules and ASAR members. Only test files are omitted.
import { closeSync, existsSync, globSync, openSync, readSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse } from 'yaml';

const isSource = file => /\.(?:mjs|cjs|js|ts)$/i.test(file) && !/\.(?:test|node-test|electron-smoke|spec)\./.test(path.posix.basename(file));
const member = node => ts.isPropertyAccessExpression(node) ? node.name.text
  : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
const access = node => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
const unwrap = node => { while (ts.isParenthesizedExpression(node)) node = node.expression; return node; };

export function shellViolations(source, file) {
  const failures = [], ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const main = file === 'electron/main.mjs', boundary = file === 'electron/os-shell.mjs';
  const fail = (node, reason) => failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${reason}`);
  const safeBinding = name => ts.isObjectBindingPattern(name) && name.elements.every(item =>
    !item.dotDotDotToken && ts.isIdentifier(item.name) &&
    (ts.isIdentifier(item.propertyName ?? item.name) || ts.isStringLiteral(item.propertyName)) &&
    (item.propertyName ?? item.name).text !== 'shell');
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'electron') {
      if (node.importClause?.name || node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) fail(node, 'unrecognized Electron module import');
      for (const item of node.importClause?.namedBindings?.elements ?? []) {
        if ((item.propertyName ?? item.name).text === 'shell' && !(main && item.name.text === 'electronShell')) fail(item, 'raw shell import');
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier?.text === 'electron') fail(node, 'Electron re-export escapes the wrapper');
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'electron') {
      let parent = node.parent;
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
      // CJS vendor/preload imports may name non-shell Electron APIs directly.
      // Whole module aliases, computed keys, rest/spread and shell destructuring
      // fail closed, so a shell alias cannot disappear into another file.
      const direct = access(parent) && unwrap(parent.expression) === node && member(parent) && member(parent) !== 'shell';
      const destructured = ts.isVariableDeclaration(parent) && parent.initializer === node && safeBinding(parent.name);
      if (!direct && !destructured) fail(node, 'unrecognized Electron module loader (raw shell or module escape)');
    }
    if (ts.isIdentifier(node) && node.text === 'electronShell' && !ts.isImportSpecifier(node.parent)
      && !(main && ts.isCallExpression(node.parent) && node.parent.expression.getText(ast) === 'createOsShell' && node.parent.arguments[0] === node)) fail(node, 'raw Electron shell escape');
    if (!boundary && access(node) && node.expression.getText(ast) === 'shell' && ['openPath', 'openExternal', 'showItemInFolder'].includes(member(node))) fail(node, 'raw shell access');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return failures;
}

function inventory() {
  const files = [], failures = [];
  return { files, failures, inspect(file, source, policyFile = file) {
    if (!isSource(file)) return;
    files.push(file);
    failures.push(...shellViolations(source, policyFile).map(value => file === policyFile ? value : `${file}: ${value}`));
  }};
}

// No directory exclusions, including fixtures/testing/vendor/node_modules.
function walk(root, visit, relative = '', ancestors = new Set()) {
  const absolute = path.join(root, relative), real = realpathSync(absolute);
  const stat = statSync(absolute);
  if (!stat.isDirectory()) { visit(relative, absolute); return; }
  if (ancestors.has(real)) throw new Error(`Cyclic shipped directory: ${absolute}`);
  const next = new Set(ancestors).add(real);
  for (const item of readdirSync(absolute)) walk(root, visit, path.join(relative, item), next);
}

export function checkSourceShell(root) {
  const result = inventory(), roots = new Set(['electron', 'shared', 'server', 'src', 'companion/src', 'installer/lib', 'installer/bin']);
  // Include every positive packaging input, even inputs excluded by packaging
  // filters. Missing generated resources are checked in the final package gate.
  for (const configFile of ['electron-builder.yml', 'electron-builder.qualification.yml']) {
    const config = parse(readFileSync(path.join(root, configFile), 'utf8'));
    for (const configPart of [config, config.win, config.mac, config.linux].filter(Boolean)) {
      for (const input of [...configPart.files ?? [], ...configPart.extraResources ?? [], ...configPart.extraFiles ?? []]) {
        const pattern = typeof input === 'string' ? input : input.from;
        if (!pattern || pattern.startsWith('!')) continue;
        for (const match of globSync(pattern.replaceAll(/\$\{[^}]+\}/g, '*'), { cwd: root })) roots.add(match);
      }
    }
  }
  const seen = new Set();
  for (const entry of roots) if (existsSync(path.join(root, entry))) walk(root, (file, absolute) => {
    file = file.split(path.sep).join('/');
    if (seen.has(file)) return;
    seen.add(file);
    if (isSource(file)) result.inspect(file, readFileSync(absolute, 'utf8'));
  }, entry);
  return result;
}

function scanArchive(archive, result) {
  const fd = openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error('Truncated ASAR');
    const headerSize = prefix.readUInt32LE(12), dataOffset = 8 + prefix.readUInt32LE(4);
    if (headerSize > 64 * 1024 * 1024 || dataOffset < 16 + headerSize) throw new Error('Invalid ASAR header');
    const header = Buffer.alloc(headerSize);
    if (readSync(fd, header, 0, headerSize, 16) !== headerSize) throw new Error('Truncated ASAR header');
    const entries = JSON.parse(header.toString('utf8'));
    const scan = (tree, prefix = '') => { for (const [name, entry] of Object.entries(tree.files ?? {})) {
      if (name === '..' || name.includes('/') || name.includes('\\')) throw new Error('Invalid ASAR path');
      const file = prefix + name;
      if (entry.files) { scan(entry, file + '/'); continue; }
      if (!isSource(file)) continue;
      if (entry.link) throw new Error(`Unreviewed ASAR source link: ${file}`);
      let bytes;
      if (entry.unpacked === true) bytes = readFileSync(path.join(archive + '.unpacked', file));
      else {
        const offset = Number(entry.offset);
        if (!/^(0|[1-9][0-9]*)$/.test(entry.offset) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Invalid ASAR member: ${file}`);
        bytes = Buffer.alloc(entry.size);
        if (readSync(fd, bytes, 0, entry.size, dataOffset + offset) !== entry.size) throw new Error(`Truncated ASAR member: ${file}`);
      }
      result.inspect(`app.asar/${file}`, bytes.toString('utf8'), file);
    }};
    scan(entries);
  } finally { closeSync(fd); }
}

export function checkPackagedShell(root) {
  const result = inventory();
  walk(root, (file, absolute) => {
    file = file.split(path.sep).join('/');
    if (file.endsWith('.asar')) scanArchive(absolute, result);
    else if (isSource(file)) {
      const policyFile = file.replace(/^(?:(?:.*\/)?[Rr]esources\/)?app(?:\.asar\.unpacked)?\//, '');
      result.inspect(file, readFileSync(absolute, 'utf8'), policyFile);
    }
  });
  return result;
}
export function assertPackagedShell(root) {
  const result = checkPackagedShell(root);
  if (!result.files.length) throw new Error('OS shell guard found no shipped JS');
  if (result.failures.length) throw new Error(result.failures.join('\n'));
  return { files: result.files.length, failures: 0 };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = process.argv[2] ? checkPackagedShell(path.resolve(process.argv[2])) : checkSourceShell(fileURLToPath(new URL('../', import.meta.url)));
  console.log(`OS shell guard: ${result.files.length} JS files; ${result.failures.length} failures.`);
  for (const failure of result.failures) console.error(failure);
  if (!result.files.length || result.failures.length) process.exitCode = 1;
}
