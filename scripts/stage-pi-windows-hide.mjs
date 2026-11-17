// Pi loads these files itself, so keep its package imports external and ship
// the complete relative module graph beside the staged extensions.
import { statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export function stagePiWindowsHide(root, output = join(root, 'dist-server')) {
  root = resolve(root);
  output = resolve(output);
  const staged = new Set();
  const destination = file => join(output, relative(root, file).replace(/^server[\\/]/, ''));
  const resolveImport = (parent, specifier) => {
    const path = resolve(dirname(parent), specifier);
    const candidates = [path];
    if (/\.[cm]?js$/.test(path)) candidates.push(path.replace(/\.[cm]?js$/, '.ts'));
    if (!extname(path)) candidates.push(...['.ts', '.mts', '.mjs', '.js', '.cjs', '/index.ts', '/index.js'].map(suffix => path + suffix));
    const found = candidates.find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } });
    if (!found || relative(root, found).startsWith('..' + sep)) throw new Error(`${parent}: unresolved local import ${specifier}`);
    return found;
  };
  const stage = file => {
    if (staged.has(file)) return;
    staged.add(file);
    let source = readFileSync(file, 'utf8');
    if (file === join(root, 'server/drivers/pi-permission-gate.ts')) source = 'import "../../shared/win-hide-child-process.mjs";\n' + source;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const edits = [];
    const visit = node => {
      let literal;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) literal = node.arguments[0];
      if (literal && ts.isStringLiteralLike(literal) && literal.text.startsWith('.')) {
        const dependency = resolveImport(file, literal.text);
        stage(dependency);
        let specifier = relative(dirname(destination(file)), destination(dependency)).split(sep).join('/');
        if (!specifier.startsWith('.')) specifier = './' + specifier;
        // Preserve quote style so extension startup contracts remain readable.
        const quote = source[literal.getStart(ast)];
        edits.push({ start: literal.getStart(ast), end: literal.end, text: quote + specifier + quote });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    mkdirSync(dirname(destination(file)), { recursive: true });
    writeFileSync(destination(file), source);
  };
  for (const name of ['pi-mcp-extension.ts', 'pi-permission-gate.ts']) {
    const file = join(root, 'server/drivers', name);
    stage(file);
    if (!readFileSync(destination(file), 'utf8').startsWith('import "../shared/win-hide-child-process.mjs";')) throw new Error(`${name}: missing first Windows installer import`);
  }
}
