// Fast lint only: runtime defaults are installed by shared/win-hide-child-process.mjs.
// This deliberately does not claim complete inter-module/data-flow analysis.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { windowsHidePrelude } from "../shared/win-hide-child-process.mjs";

const launchNames = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
// Entire files only; never exempt a Windows launch because a neighbour is POSIX-only.
export const POSIX_ONLY = new Map([
  ["electron/vendor/dbus-next.cjs", "Vendored D-Bus transport, loaded only by the Linux desktop integration."],
  ["electron/build-speech-helper.mjs", "Builds the macOS Swift speech helper with xcrun/lipo."],
  ["electron/build-recorder-helper.mjs", "Builds the macOS Swift recorder helper with xcrun/lipo."],
]);
// Exact reviewed uses of -e that do not contain Node source. Pi's extension
// files are independently checked by the entry-order test.
export const NON_NODE_EVAL_ARGUMENTS = new Map([
  ['server/checkpoints.ts:`${hash}^{commit}`', 'git cat-file -e checks that an object exists; its argument is not executable source.'],
  ['server/vps-computer.ts:`VNC_PW=${viewerSecret}`', 'docker run -e sets a container environment variable; it does not evaluate Node source.'],
  ['server/drivers/pi.ts:SPAWNED_PROXIES.piMcpExtension', 'Pi -e loads the registered extension file, whose first installer import is structurally checked.'],
  ['server/drivers/pi.ts:SPAWNED_PROXIES.piPermissionGate', 'Pi -e loads the registered permission extension, whose first installer import is structurally checked.'],
]);
const unwrap = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
};
const property = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
const childModule = node => node && ts.isStringLiteral(node) && /^(?:node:)?child_process$/.test(node.text);
const utilModule = node => node && ts.isStringLiteral(node) && /^(?:node:)?util$/.test(node.text);
const nodeModule = node => node && ts.isStringLiteral(node) && /^(?:node:)?module$/.test(node.text);

/** Parse JS/TS, including import aliases, require(), dynamic imports and promisify.
 * Regex.exec, database.exec and Electron utilityProcess.fork are different APIs.
 * Named wrappers (for example spawnCli) are checked at their underlying launch.
 */
export function inspectSource(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const scopes = new WeakMap();
  const initializers = new WeakMap();
  const members = new WeakMap();
  const owner = node => { while (node && !ts.isClassDeclaration(node) && !ts.isClassExpression(node)) node = node.parent; return node ?? ast; };
  const isScope = node => ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node);
  const scopeFor = node => { while (node && !isScope(node)) node = node.parent; return node ?? ast; };
  const bind = (declaration, name, kind) => {
    const scope = scopeFor(declaration.parent);
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    scopes.get(scope).set(name, kind);
  };
  const lookup = node => {
    for (let at = node.parent; at; at = at.parent) {
      const map = scopes.get(at);
      if (map?.has(node.text)) return map.get(node.text);
    }
    return undefined;
  };
  // Assignments update the declared binding, including assignments inside a
  // nested function. Do not create a new alias in the assignment's block.
  const assign = (node, kind) => {
    for (let at = node.parent; at; at = at.parent) {
      const map = scopes.get(at);
      if (map?.has(node.text)) { map.set(node.text, kind); return; }
    }
    bind(node, node.text, kind);
  };
  const nodes = [];
  const visit = node => { nodes.push(node); ts.forEachChild(node, visit); };
  visit(ast);
  // Unknown local declarations shadow imports; e.g. a test helper called spawn
  // or run is not the child_process function in a different lexical scope.
  for (const node of nodes) {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      const injected = (ts.isParameter(node) || ts.isBindingElement(node)) && !node.initializer && launchNames.has(node.name.text) && !["exec", "fork"].includes(node.name.text);
      bind(node, node.name.text, injected ? node.name.text : "other");
      const scope = scopeFor(node.parent);
      if (!initializers.has(scope)) initializers.set(scope, new Map());
      initializers.get(scope).set(node.name.text, node.initializer);
    }
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.name) bind(node, node.importClause.name.text, "other");
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const item of named.elements) bind(node, item.name.text, "other");
    }
  }
  function origin(raw) {
    const node = unwrap(raw);
    if (!node) return undefined;
    if (ts.isIdentifier(node)) return lookup(node);
    if (ts.isAwaitExpression(node)) return origin(node.expression);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) return origin(node.right) ?? origin(node.left);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : property(node.argumentExpression);
      const receiver = origin(node.expression);
      if (receiver === "module") return launchNames.has(key) ? key : "child-export";
      if (receiver === "util-module" && key === "promisify") return "promisify";
      if (receiver === "node-module" && key === "createRequire") return "create-require";
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) return members.get(owner(node))?.get(key);
    }
    if (ts.isCallExpression(node)) {
      const callee = origin(node.expression);
      if (callee === "create-require") return "require";
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || callee === "require" || ts.isIdentifier(node.expression) && /^(?:require|require_child_process)$/.test(node.expression.text)) {
        if (childModule(node.arguments[0]) || node.expression.text === "require_child_process") return "module";
        if (nodeModule(node.arguments[0])) return "node-module";
      }
      if (callee === "promisify" || ts.isIdentifier(node.expression) && /^(?:promisify|__toESM|__importStar)$/.test(node.expression.text)) return origin(node.arguments[0]);
    }
    return undefined;
  }
  // Resolve aliases without depending on declaration order.
  for (let pass = 0; pass < 8; pass++) {
    for (const node of nodes) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const kind = origin(node.right);
        const left = unwrap(node.left);
        if (ts.isIdentifier(left)) for (let at = node.parent; at; at = at.parent) {
          const map = initializers.get(at);
          if (map?.has(left.text)) { map.set(left.text, node.right); break; }
        }
        if (kind && kind !== "other") {
          if (ts.isIdentifier(left)) assign(left, kind);
          if (["module", "node-module"].includes(kind) && ts.isObjectLiteralExpression(left)) for (const item of left.properties) {
            const name = property(item.name);
            const target = ts.isPropertyAssignment(item) ? unwrap(item.initializer) : ts.isShorthandPropertyAssignment(item) ? item.name : undefined;
            if (target && ts.isIdentifier(target)) {
              if (kind === "module" && launchNames.has(name)) assign(target, name);
              if (kind === "node-module" && name === "createRequire") assign(target, "create-require");
            }
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const kind = origin(node.right);
        if (kind && kind !== "other") {
          const container = owner(node);
          if (!members.has(container)) members.set(container, new Map());
          members.get(container).set(node.left.name.text, kind);
        }
      }
      if (ts.isImportDeclaration(node) && childModule(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
        const clause = node.importClause;
        if (clause?.name) bind(node, clause.name.text, "module");
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) bind(node, named.name.text, "module");
        if (named && ts.isNamedImports(named)) for (const item of named.elements) {
          const name = (item.propertyName ?? item.name).text;
          if (!item.isTypeOnly) bind(node, item.name.text, launchNames.has(name) ? name : "child-export");
        }
      }
      if (ts.isImportDeclaration(node) && nodeModule(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
        const clause = node.importClause;
        if (clause?.name) bind(node, clause.name.text, "node-module");
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) bind(node, named.name.text, "node-module");
        if (named && ts.isNamedImports(named)) for (const item of named.elements) {
          if (!item.isTypeOnly && (item.propertyName ?? item.name).text === "createRequire") bind(node, item.name.text, "create-require");
        }
      }
      if (ts.isImportDeclaration(node) && utilModule(node.moduleSpecifier)) {
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) bind(node, named.name.text, "util-module");
        if (named && ts.isNamedImports(named)) for (const item of named.elements) {
          if ((item.propertyName ?? item.name).text === "promisify") bind(node, item.name.text, "promisify");
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "then" && origin(node.expression.expression) === "module") {
        const callback = node.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          const parameter = callback.parameters[0];
          if (parameter && ts.isObjectBindingPattern(parameter.name)) for (const item of parameter.name.elements) {
            const name = property(item.propertyName ?? item.name);
            if (launchNames.has(name) && ts.isIdentifier(item.name)) bind(parameter, item.name.text, name);
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isArrayLiteralExpression(unwrap(node.initializer))) {
        node.name.elements.forEach((item, i) => {
          const kind = origin(unwrap(node.initializer).elements[i]);
          if (kind && item.name && ts.isIdentifier(item.name)) bind(node, item.name.text, kind);
        });
      }
      if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
        const kind = origin(node.initializer);
        if (kind && kind !== "other" && ts.isIdentifier(node.name)) bind(node, node.name.text, kind);
        if (kind === "module" && ts.isObjectBindingPattern(node.name)) for (const item of node.name.elements) {
          const name = property(item.propertyName ?? item.name);
          if (ts.isIdentifier(item.name)) bind(node, item.name.text, launchNames.has(name) ? name : "child-export");
        }
        if (kind === "node-module" && ts.isObjectBindingPattern(node.name)) for (const item of node.name.elements) {
          if (property(item.propertyName ?? item.name) === "createRequire" && ts.isIdentifier(item.name)) bind(node, item.name.text, "create-require");
        }
      }
    }
  }
  const calls = [];
  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue;
    // TS emits (0, child_process.spawn)(...), too.
    let callee = unwrap(node.expression);
    if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) callee = callee.right;
    // Also cover injected launch functions without an import in this file.
    const directName = ts.isIdentifier(callee) ? callee.text : undefined;
    const kind = origin(callee) ?? (directName && launchNames.has(directName) && !["exec", "fork"].includes(directName) ? directName : undefined);
    if (!launchNames.has(kind)) continue;
    const args = node.arguments;
    const index = kind === "exec" || kind === "execSync" ? 1
      : !args[1] || ts.isObjectLiteralExpression(unwrap(args[1])) || ts.isArrowFunction(unwrap(args[1])) || ts.isFunctionExpression(unwrap(args[1])) ? 1 : 2;
    const options = unwrap(args[index]);
    let hidden = false;
    if (options && ts.isObjectLiteralExpression(options)) for (const p of options.properties) {
      // A later spread/computed key can override true. Require the final value.
      if (ts.isSpreadAssignment(p) || p.name && ts.isComputedPropertyName(p.name)) hidden = false;
      else if (property(p.name) === "windowsHide") hidden = ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    calls.push({ file, line, kind, hidden: !!hidden, start: node.getStart(ast), optionsStart: options?.getStart(ast), optionsEnd: options?.end, index, end: node.end, argumentEnds: [...args].map(arg => arg.end), text: node.getText(ast) });
  }
  // Fail closed on references that API discovery cannot prove are a direct
  // launch, a declaration alias, or a supported promisify adapter. In particular
  // .call/.apply/.bind and passing a module/function to unknown code are escapes.
  for (const node of nodes) {
    // An unrecognized loader cannot silently hide the module from discovery.
    if (childModule(node) && (ts.isCallExpression(node.parent) && origin(node.parent) !== 'module'
      || ts.isVariableDeclaration(node.parent) && node.parent.initializer === node)) {
      calls.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind: 'unrecognized-child-reference', start: node.getStart(ast), text: node.getText(ast) });
    }
    if (ts.isExportDeclaration(node) && childModule(node.moduleSpecifier)) {
      calls.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind: 'unrecognized-child-reference', start: node.getStart(ast), text: node.getText(ast) });
      continue;
    }
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node) && !ts.isCallExpression(node) && !ts.isBinaryExpression(node) && !ts.isParenthesizedExpression(node) && !ts.isAsExpression(node) && !ts.isNonNullExpression(node) && !ts.isAwaitExpression(node) && !ts.isSatisfiesExpression(node)) continue;
    const kind = origin(node);
    if (kind !== 'module' && kind !== 'child-export' && !launchNames.has(kind)) continue;
    const parent = node.parent;
    let typeOnly = false;
    for (let at = parent; at && !ts.isStatement(at); at = at.parent) if (ts.isTypeNode(at)) { typeOnly = true; break; }
    if (typeOnly) continue;
    // This exact module-to-installer handoff is the native boundary audited by
    // the generated differential; other uses in this file still fail closed.
    if (file === 'shared/win-hide-child-process.cjs' && ts.isIdentifier(node) && node.text === 'childProcess'
      && ts.isCallExpression(parent) && parent.expression.getText(ast) === 'installWindowsHide' && parent.arguments[0] === node) continue;
    if (ts.isTypeQueryNode(parent) || ts.isTypeOfExpression(parent)) continue;
    if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) continue;
    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)) continue;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isIdentifier(parent.left) || ts.isPropertyAccessExpression(parent.left) && parent.left.expression.kind === ts.SyntaxKind.ThisKeyword
        || ts.isObjectLiteralExpression(parent.left) && origin(parent.right) === 'module')) continue;
    // Declarations do not execute an API. References to their aliases are
    // checked independently, so an unknown later use cannot disappear here.
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isBindingElement(parent)) continue;
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && (parent.name === node || parent.initializer === node)) continue;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) continue;
    if (ts.isPropertyAssignment(parent) && parent.initializer === node && ts.isObjectLiteralExpression(parent.parent)
      && ts.isBinaryExpression(parent.parent.parent) && parent.parent.parent.left === parent.parent
      && origin(parent.parent.parent.right) === 'module') continue;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node && kind === 'module' && launchNames.has(origin(parent))) continue;
    if (ts.isCallExpression(parent) && parent.expression === node && launchNames.has(kind)) continue;
    if (ts.isCallExpression(parent) && parent.arguments[0] === node && (origin(parent.expression) === 'promisify' || /^(?:promisify|__toESM|__importStar)$/.test(parent.expression.getText(ast)))) continue;
    if (ts.isAwaitExpression(parent) && kind === 'module') continue;
    // Supported TS/CJS emit wrappers are transparent to discovery.
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isNonNullExpression(parent)) continue;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken && parent.right === node) continue;
    calls.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind: 'unrecognized-child-reference', start: node.getStart(ast), text: node.getText(ast) });
  }
  // Executable source inside argv is not an AST child of the host program.
  // Resolve literal strings/aliases/joins without executing repository code,
  // then parse -e/--eval payloads, including argv handed to another launcher
  // through configuration (Codex MCP), not only direct child_process calls.
  function staticText(raw, seen = new Set()) {
    const node = unwrap(raw);
    if (!node || seen.has(node)) return undefined;
    const next = new Set(seen).add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(ast) === 'String.raw' && ts.isNoSubstitutionTemplateLiteral(node.template)) return node.template.rawText ?? node.template.text;
    if (ts.isIdentifier(node)) {
      // Resolve the exact shared prelude so the embedded realm can prove it
      // installs before any of its own launches.
      if (node.text === 'windowsHidePrelude' && nodes.some(item => ts.isImportDeclaration(item)
        && item.moduleSpecifier.text?.endsWith('/win-hide-child-process.mjs')
        && item.importClause?.namedBindings?.elements?.some(binding => binding.name.text === node.text))) return windowsHidePrelude;
      for (let at = node.parent; at; at = at.parent) {
        const map = initializers.get(at);
        if (map?.has(node.text)) return staticText(map.get(node.text), next);
      }
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = staticText(span.expression, next);
        if (part === undefined) return undefined;
        value += part + span.literal.text;
      }
      return value;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticText(node.left, next), right = staticText(node.right, next);
      if (left !== undefined && right !== undefined) return left + right;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join") {
      const array = unwrap(node.expression.expression);
      const separator = node.arguments.length ? staticText(node.arguments[0], next) : ",";
      if (ts.isArrayLiteralExpression(array) && separator !== undefined) {
        const parts = array.elements.map(part => staticText(part, next));
        if (parts.every(part => part !== undefined)) return parts.join(separator);
      }
    }
    return undefined;
  }
  for (const node of nodes) {
    if (!ts.isArrayLiteralExpression(node)) continue;
    for (let i = 0; i + 1 < node.elements.length; i++) {
      if (!["-e", "--eval"].includes(staticText(node.elements[i]))) continue;
      const payload = node.elements[i + 1];
      if (NON_NODE_EVAL_ARGUMENTS.has(`${file}:${payload.getText(ast)}`)) continue;
      const code = staticText(payload);
      if (code === undefined) {
        calls.push({ file, line: ast.getLineAndCharacterOfPosition(payload.getStart(ast)).line + 1,
          kind: 'unresolved-eval', hidden: false, embedded: true, text: payload.getText(ast) });
        continue;
      }
      for (const call of inspectSource(file + ".eval.js", code)) {
        calls.push({...call, hidden: call.hidden || code.startsWith(windowsHidePrelude), file, line: ast.getLineAndCharacterOfPosition(payload.getStart(ast)).line + 1,
          embedded: true, embeddedLine: call.line});
      }
    }
  }
  // Ban explicit opt-outs even behind an unknown re-export or third-party wrapper.
  // There are no approved production opt-outs. New exceptions require an exact,
  // reasoned site here, never an entire wrapper or file exemption.
  for (const node of nodes) {
    const literalFalse = ts.isPropertyAssignment(node) && property(node.name) === 'windowsHide' && unwrap(node.initializer)?.kind === ts.SyntaxKind.FalseKeyword;
    const assignedFalse = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && unwrap(node.right)?.kind === ts.SyntaxKind.FalseKeyword
      && (ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'windowsHide'
        || ts.isElementAccessExpression(node.left) && property(node.left.argumentExpression) === 'windowsHide');
    if (!(literalFalse || assignedFalse)) continue;
    const start = node.getStart(ast);
    const containing = calls.find(call => !call.hidden && start >= call.start && start < call.end);
    if (containing) containing.optOut = true;
    else calls.push({
      file, line: ast.getLineAndCharacterOfPosition(start).line + 1, kind: 'windowsHide:false', hidden: false, text: node.getText(ast),
    });
  }
  return calls;
}

export function checkWindowsHide(root) {
  // Include the desktop sidecar and cross-platform CLI as well as both requested runtime trees.
  const files = execFileSync("git", ["ls-files", "-z", "server", "electron", "companion/src", "installer/bin", "installer/lib", "shared"], { cwd: root, encoding: "utf8", windowsHide: true }).split("\0").filter(file => /\.[cm]?[jt]sx?$/.test(file));
  if (files.length === 0) throw new Error("Windows child-process guard found no tracked runtime sources");
  const calls = files.filter(file => !POSIX_ONLY.has(file) && !/\.(?:test|node-test)\./.test(file) && !file.includes("/testing/") && !file.includes("/fixtures/")).flatMap(file => inspectSource(file, readFileSync(path.join(root, file), "utf8")));
  // Entry-order verification and the runtime installer supply missing defaults.
  // Keep discovery for review, but do not force call sites to change POSIX
  // options just to satisfy this lint. Explicit opt-outs and unresolved eval
  // source still fail closed.
  return { files: files.length, calls, failures: calls.filter(call => call.kind === 'windowsHide:false' || call.kind === 'unrecognized-child-reference' || call.kind === 'unresolved-eval'
    || call.optOut || (call.embedded && !call.hidden)) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = checkWindowsHide(fileURLToPath(new URL("../", import.meta.url)));
  for (const { file, line, kind, embedded, embeddedLine } of result.failures) console.error(`${file}:${line}: ${kind}${embedded ? ` (embedded eval${embeddedLine ? `, line ${embeddedLine}` : ""})` : ""}: ${kind === "unresolved-eval" ? "resolve the executable source or record an exact, reasoned review" : kind === "unrecognized-child-reference" ? "unrecognized child_process reference; use a direct guarded launch" : "requires windowsHide: true; explicit false needs an exact, reasoned opt-out"}`);
  console.log(`Windows child-process guard: ${result.calls.length} launches in ${result.files} tracked sources; ${result.failures.length} failures.`);
  if (result.failures.length) process.exitCode = 1;
}
