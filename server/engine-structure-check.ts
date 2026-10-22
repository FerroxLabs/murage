// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The rules that keep engine-history deletion honest, checked on the SYNTAX of the source (the TypeScript compiler's own parse),
// not on its text. engine-plan-structure.test.ts runs them over the real files, and over the real files with a forbidden thing
// added, which they must reject.
//
// There is one reader and one writer of the engines' files: engine-fs.ts (`fsOps` for reads, `mutOps` for changes). Planners
// reach the world through that reader only; the executor through both layers; the driver and the worker through neither. So:
//  - every module has a CLOSED list of modules it may import as a value (a type import is erased and free). Anything else, however
//    it is spelled (an alias, a re-export, a second statement on the same line), is a violation, and so is any route that is not
//    a static import: require, createRequire, import(), import.meta, process.binding / dlopen / getBuiltinModule, a bare `process`,
//    globalThis, eval and Function. A planner or helper that can reach engine-fs.ts or engine-exec.ts through the imports it IS
//    allowed (transitively) is a violation too.
//  - the executor may not call a raw file-system or database function by name, may use `fsOps` only for lstat, and may not call
//    the readers that exist for planning (it never discovers).
//  - the three layers (`fsOps`, `mutOps`, `exclOps`) and the reader the executor gets from realEngineFs() are used only as a direct
//    named property (`mutOps.rename`): never destructured, aliased, indexed by a computed name, spread or passed on.
//  - the audited leaf modules are walked like every other file: each has a closed list of imports. Only engine-fs.ts may load the
//    native addon module (engine-exclusion.ts, role "loader"), and no planner can reach it.
//  - a worker started from a string (`new Worker(src, { eval: true })`) is read as a worker source; engine modules may not start
//    one, and wal-maintenance.ts may start only the one whose source requires nothing but its own allowlist (evalWorkerViolations).
//    The options are followed through a const, a spread or an alias of the constructor: options this check cannot read could carry
//    eval: true and are a violation too.
//  - the three layers are tracked through the names an import gives them (`import { fsOps as f }`), not only by their own names.
import ts from "typescript";

export type Role = "reader" | "loader" | "leaf" | "planner" | "helper" | "executor" | "driver" | "worker" | "offthread";

/** Which role each deletion module plays. */
export const ENGINE_FILES: Readonly<Record<string, Role>> = {
  "engine-fs.ts": "reader",
  "engine-exclusion.ts": "loader",
  "engine-plan-core.ts": "planner",
  "engine-plan-acp.ts": "planner",
  "engine-plan-files.ts": "planner",
  "engine-keys.ts": "helper",
  "engine-history-deletion.ts": "helper",
  "engine-closed.ts": "executor",
  "engine-exec.ts": "executor",
  "engine-redo.ts": "executor",
  "engine-history-run.ts": "driver",
  "engine-history-worker.ts": "worker",
  "engine-history-offthread.ts": "offthread",
  "blake3.ts": "leaf",
  "sqlite-checkpoint.ts": "leaf",
  "proxy-paths.ts": "leaf",
  "observe.ts": "leaf",
};

/** Modules that reach the file system, a database, zlib, a process, the network or the module loader. */
const WORLD = /^(?:node:)?(?:fs|fs\/promises|sqlite|zlib|child_process|vm|module|net|http|https|http2|tls|dgram|cluster|worker_threads|os|v8|inspector|repl|readline)$/;

/** The modules each file may import as a value, and nothing else. Relative names are the deletion modules and the audited
 * single-purpose leaves, which are walked like the rest. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "engine-fs.ts": ["node:child_process", "node:fs", "node:os", "node:sqlite", "node:zlib", "./engine-exclusion.ts", "./engine-plan-core.ts"],
  "engine-exclusion.ts": ["node:module", "node:fs", "node:path", "node:url"],
  "engine-plan-core.ts": ["node:path", "node:crypto"],
  "engine-plan-acp.ts": ["./engine-history-deletion.ts", "./engine-plan-core.ts"],
  "engine-plan-files.ts": ["./engine-keys.ts", "./engine-plan-core.ts"],
  "engine-keys.ts": ["./blake3.ts", "./engine-plan-core.ts"],
  "engine-history-deletion.ts": ["node:crypto", "node:path", "./engine-plan-core.ts"],
  "engine-closed.ts": ["node:path", "./engine-fs.ts"],
  "engine-exec.ts": ["node:path", "./engine-closed.ts", "./engine-fs.ts", "./engine-plan-core.ts", "./engine-redo.ts", "./sqlite-checkpoint.ts"],
  "engine-redo.ts": ["node:path", "node:crypto", "./engine-fs.ts", "./engine-plan-core.ts"],
  "engine-history-run.ts": ["./engine-closed.ts", "./engine-exec.ts", "./engine-redo.ts", "./engine-fs.ts", "./engine-plan-acp.ts", "./engine-plan-files.ts", "./engine-plan-core.ts"],
  "engine-history-worker.ts": ["node:worker_threads", "./engine-history-run.ts"],
  "engine-history-offthread.ts": ["node:worker_threads", "./proxy-paths.ts"],
  // audited leaves: single-purpose modules, each with a closed list of its own
  "blake3.ts": [],
  "sqlite-checkpoint.ts": ["./observe.ts"],
  // shared/spawned-proxies.mjs is the proxy name list the desktop main process reads too (4adf5e642); it is data with no
  // imports of its own, which engine-plan-structure.test.ts checks, so the leaf stays closed.
  "proxy-paths.ts": ["node:fs", "node:path", "node:url", "../shared/spawned-proxies.mjs"],
  "observe.ts": ["node:perf_hooks"],
};

/** Raw calls an engine file must never name (they belong to engine-fs.ts). */
const RAW_CALLS = new Set(["readFileSync", "readdirSync", "lstatSync", "statSync", "openSync", "readSync", "writeSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "mkdirSync", "writeFileSync", "appendFileSync", "copyFileSync", "createReadStream", "createWriteStream", "DatabaseSync", "zstdDecompressSync", "readFile", "writeFile", "opendirSync", "readlinkSync", "symlinkSync", "truncateSync", "ftruncateSync", "fsyncSync"]);
/** Readers that exist for planning; the executor never discovers, so it never calls them. */
const PLANNING_READERS = new Set(["withDb", "zstdFirstLine", "readHead", "jsonValue", "openDb", "zstd"]);
/** What a file may do with `process`: read the platform or the environment, nothing else (the loader also its architecture). */
const PROCESS_OK = new Set(["platform", "env"]);
const PROCESS_LOADER_OK = new Set(["platform", "env", "arch"]);
/** The three layers every touch of the engines' files goes through. */
const LAYERS = new Set(["fsOps", "mutOps", "exclOps"]);
/** The routes the loader needs to find and load a native addon, and no others. */
const LOADER_ESCAPES = new Set(["createRequire", "import.meta", "require"]);

const parse = (name: string, src: string): ts.SourceFile => ts.createSourceFile(name, src, ts.ScriptTarget.ES2022, true, name.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const isTypeOnlyImport = (node: ts.ImportDeclaration | ts.ExportDeclaration): boolean => {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false; // a side-effect import runs the module
    if (clause.isTypeOnly) return true;
    if (clause.name) return false;
    const bindings = clause.namedBindings;
    return !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
};

/** The module names a file brings in as VALUES by static import or re-export, and the routes that are not static imports. */
export function importsOf(src: string, name = "x.ts"): { modules: string[]; escapes: string[] } {
  const file = parse(name, src);
  const modules: string[] = [];
  const escapes: string[] = [];
  walk(file, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) modules.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      escapes.push("import = require");
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) escapes.push("import()");
      else if (ts.isIdentifier(callee) && (callee.text === "require" || callee.text === "createRequire" || callee.text === "eval" || callee.text === "Function")) escapes.push(callee.text);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      escapes.push("Function");
    } else if (ts.isIdentifier(node)) {
      const parent = node.parent;
      // a name that is only a property or a type (x.global, { Function: 1 }, a Function type) is not the global
      const onlyAName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node) || ts.isPropertySignature(parent) || ts.isTypeReferenceNode(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
      if (node.text === "createRequire" || node.text === "globalThis" || node.text === "__non_webpack_require__") escapes.push(node.text);
      // The global object and the Function constructor, however they are reached or renamed, are ways around every import rule here.
      else if (((node.text === "global" && ENGINE_FILES[name] === "executor") || node.text === "Function") && !onlyAName) escapes.push(node.text);
      else if (node.text === "require" && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) escapes.push("require");
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      escapes.push("import.meta");
    }
  });
  return { modules, escapes: [...new Set(escapes)] };
}

/** Every use of the identifier `process` that is not `process.platform` or `process.env...`. */
function processEscapes(file: ts.SourceFile, ok: ReadonlySet<string> = PROCESS_OK): string[] {
  const out: string[] = [];
  walk(file, (node) => {
    if (!ts.isIdentifier(node) || node.text !== "process") return;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (!ok.has(parent.name.text)) out.push(`process.${parent.name.text}`);
      return;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      const arg = parent.argumentExpression;
      if (ts.isStringLiteralLike(arg) && ok.has(arg.text)) return;
      out.push("process[...]");
      return;
    }
    // a property named `process` (x.process) or a declaration of that name is not the global
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return;
    if (ts.isTypeReferenceNode(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return;
    out.push("process (used as a value)");
  });
  return [...new Set(out)];
}

/** The local names that mean one of the three layers in this file: the layers' own names, and every name an import gives them
 * (`import { fsOps as f }`), and a namespace import of the module that exports them is not allowed at all. */
function layerNamesOf(name: string, file: ts.SourceFile): { names: Map<string, string>; violations: string[] } {
  const names = new Map<string, string>(); // local name -> layer
  const out: string[] = [];
  for (const layer of LAYERS) names.set(layer, layer);
  walk(file, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier) || node.moduleSpecifier.text !== "./engine-fs.ts") return;
    const clause = node.importClause;
    if (!clause) return;
    if (clause.name) out.push(`${name}: default-imports engine-fs.ts, a way to reach the layers by another name`);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) out.push(`${name}: imports engine-fs.ts as a namespace, a way to reach the layers by another name`);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (LAYERS.has(imported)) names.set(element.name.text, imported);
      }
    }
  });
  return { names, violations: out };
}

/** Every use of `fsOps`, `mutOps` or `exclOps` (or the name an import gives one) must be a direct named property (`mutOps.rename`):
 * not destructured, aliased, indexed by a computed name, spread, or handed to anything. (An import or export of the name is checked
 * as an import.) */
function layerViolations(name: string, file: ts.SourceFile): string[] {
  const { names, violations: imported } = layerNamesOf(name, file);
  const out: string[] = [...imported];
  walk(file, (node) => {
    if (!ts.isIdentifier(node) || !names.has(node.text)) return;
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return;
    out.push(`${name}: uses ${node.text} other than as a direct named property (${node.text}.name); it may not be destructured, aliased, indexed or passed on`);
  });
  return out;
}

/** The reader the executor gets from realEngineFs() is held in a plain const and used as `reader.method(...)`, or handed to
 * associationsOf (a planner function that only reads). Nothing else: no destructuring, no computed method, no spread, no alias. */
function readerViolations(name: string, file: ts.SourceFile): string[] {
  const out: string[] = [];
  const readers = new Set<string>();
  walk(file, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "realEngineFs") return;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) { readers.add(parent.name.text); return; }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return;
    out.push(`${name}: uses the reader other than as a plain const or a direct method (realEngineFs().name)`);
  });
  walk(file, (node) => {
    if (!ts.isIdentifier(node) || !readers.has(node.text)) return;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return;
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "associationsOf" && parent.arguments.includes(node as unknown as ts.Expression)) return;
    out.push(`${name}: uses the reader \`${node.text}\` other than as ${node.text}.method(...); it may not be destructured, aliased, indexed or passed on`);
  });
  return [...new Set(out)];
}

/** The local names that mean the Worker constructor in this file: `Worker`, a name an import of worker_threads gives it, a name a
 * variable or a destructuring gives it, and a namespace import of worker_threads (`wt.Worker`). */
function workerNamesOf(file: ts.SourceFile): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>(["Worker"]);
  const namespaces = new Set<string>();
  const isWorkerRef = (expr: ts.Expression): boolean =>
    (ts.isIdentifier(expr) && names.has(expr.text)) || (ts.isPropertyAccessExpression(expr) && expr.name.text === "Worker");
  walk(file, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && /^(?:node:)?worker_threads$/.test(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === "Worker") names.add(element.name.text);
      if (node.importClause?.name) namespaces.add(node.importClause.name.text);
    }
  });
  // two passes so `const W = Worker; const V = W;` is followed
  for (let pass = 0; pass < 2; pass++) {
    walk(file, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      if (ts.isIdentifier(node.name) && (isWorkerRef(node.initializer) || (ts.isPropertyAccessExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && namespaces.has(node.initializer.expression.text) && node.initializer.name.text === "Worker"))) names.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(node.initializer) && namespaces.has(node.initializer.text)) {
        for (const element of node.name.elements) if (ts.isIdentifier(element.name) && (element.propertyName ? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : "") : element.name.text) === "Worker") names.add(element.name.text);
      }
    });
  }
  return { names, namespaces };
}

const stripWrappers = (expr: ts.Expression): ts.Expression => {
  let at = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isNonNullExpression(at) || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at)) at = at.expression;
    else return at;
  }
};

/** Could this object literal carry `eval: true`? Yes unless every property is a plain, named, non-computed one that is not `eval`
 * (or is `eval: false`). A spread, a computed key, an accessor or a method named eval all count as "could". */
function objectMayEval(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) return true;
    const key = property.name;
    if (!key) return true;
    if (ts.isComputedPropertyName(key)) return true;
    const text = ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) || ts.isPrivateIdentifier(key) ? key.text : undefined;
    if (text === undefined) return true;
    if (text !== "eval") return false;
    return !(ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword);
  });
}

/** What the options of a `new Worker(source, options)` can say about `eval`: "no", "yes" (eval: true spelled out), or "maybe" (the
 * options are an expression this check cannot read: a parameter, a call, a variable used anywhere but here, and so on). */
function evalOf(optionsArg: ts.Expression, file: ts.SourceFile, depth = 0): "no" | "yes" | "maybe" {
  const expr = stripWrappers(optionsArg);
  if (ts.isObjectLiteralExpression(expr)) {
    if (!objectMayEval(expr)) return "no";
    const spelled = expr.properties.find((property) => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === "eval");
    return spelled && ts.isPropertyAssignment(spelled) && spelled.initializer.kind === ts.SyntaxKind.TrueKeyword ? "yes" : "maybe";
  }
  if (ts.isIdentifier(expr) && depth < 4) {
    // a const bound once, to something readable, and used nowhere else but here (no mutation, no hand-off)
    const declarations: ts.VariableDeclaration[] = [];
    let uses = 0;
    walk(file, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === expr.text) declarations.push(node);
      else if (ts.isIdentifier(node) && node.text === expr.text && node !== expr && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) uses++;
    });
    const only = declarations.length === 1 ? declarations[0]! : undefined;
    const isConst = !!only && ts.isVariableDeclarationList(only.parent) && (only.parent.flags & ts.NodeFlags.Const) !== 0;
    if (only?.initializer && isConst && uses === 0) return evalOf(only.initializer, file, depth + 1);
  }
  return "maybe";
}

interface WorkerUse { node: ts.NewExpression; eval: "no" | "yes" | "maybe" }
/** Every `new Worker(...)` in the file and what its options can say about `eval`. */
function workerUses(file: ts.SourceFile): WorkerUse[] {
  const { names } = workerNamesOf(file);
  const out: WorkerUse[] = [];
  walk(file, (node) => {
    if (!ts.isNewExpression(node)) return;
    const target = node.expression;
    const isWorker = (ts.isIdentifier(target) && names.has(target.text)) || (ts.isPropertyAccessExpression(target) && target.name.text === "Worker");
    if (!isWorker) return;
    const args = node.arguments ?? [];
    if (args.some((arg) => ts.isSpreadElement(arg))) { out.push({ node, eval: "maybe" }); return; }
    if (args.length < 2) { out.push({ node, eval: "no" }); return; }
    out.push({ node, eval: evalOf(args[1]!, file) });
  });
  return out;
}

/** A worker started from a string, or with options that could ask for that: an engine module may not start one, and the string it
 * would run is read as a worker source. */
function evalWorkerUses(name: string, file: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const use of workerUses(file)) {
    if (use.eval === "no") continue;
    if (use.eval === "maybe") { out.push(`${name}: starts a worker whose options could carry eval: true, which would run a string as code`); continue; }
    out.push(`${name}: starts a worker from a string (eval), which can run anything`);
    const source = use.node.arguments![0]!;
    if (ts.isStringLiteralLike(source)) for (const item of violations("<eval worker>", source.text, "worker")) out.push(`${name}: its eval worker source: ${item}`);
  }
  return out;
}

/** The modules a plain script (the text of an eval worker) brings in: static imports and require("literal"). A require of anything
 * but a literal is returned as "<computed>". */
function scriptModules(text: string): string[] {
  const file = parse("<eval worker>.js", text);
  const modules: string[] = [];
  walk(file, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) modules.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const arg = node.arguments[0];
      modules.push(arg && ts.isStringLiteralLike(arg) ? arg.text : "<computed>");
    }
  });
  return modules;
}

/** For a module outside the deletion set that must start an eval worker (wal-maintenance.ts): the worker's source (a literal, or a
 * top-level const holding one) may require only the modules in `allowed`, and may use no other route to code. */
export function evalWorkerViolations(name: string, src: string, allowed: readonly string[]): string[] {
  const out: string[] = [];
  const file = parse(name, src);
  const constants = new Map<string, string>();
  walk(file, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) constants.set(node.name.text, node.initializer.text);
  });
  for (const use of workerUses(file)) {
    if (use.eval === "no") continue;
    if (use.eval === "maybe") { out.push(`${name}: starts a worker whose options could carry eval: true and cannot be read here`); continue; }
    const first = use.node.arguments![0]!;
    const text = ts.isStringLiteralLike(first) ? first.text : ts.isIdentifier(first) ? constants.get(first.text) : undefined;
    if (text === undefined) { out.push(`${name}: starts a worker from a string that cannot be read here`); continue; }
    for (const module of scriptModules(text)) if (!allowed.includes(module)) out.push(`${name}: its eval worker requires ${module}, which is not on its list (${allowed.join(", ")})`);
    const { escapes } = importsOf(text, "<eval worker>.js");
    for (const escape of escapes) if (escape !== "require") out.push(`${name}: its eval worker uses ${escape}`);
  }
  return out;
}

/** The functions of engine-exec.ts that may name a raw destructive call: the guarded primitives (each asks its guard first), and the two
 * that work on Murage's own folders (a conversation's workspace), never on an engine's file. */
const GUARDED_PRIMITIVES = new Set(["gUnlink", "gRmdir", "gLink", "gMove", "gPwrite", "removeConfined", "allowOwnerWrites"]);
const DESTRUCTIVE_MUT = new Set(["unlink", "rmdir", "link", "rename", "pwrite", "removeTree"]);
/** What engine-exec.ts may export: nothing that writes an engine's file except through executeEnginePlans (a scrub that runs outside the
 * gate and the hold is a way around both). */
const EXEC_EXPORTS = new Set(["executeEnginePlans", "removeConfined", "allowOwnerWrites", "recoverAll", "lstatOrNull", "HOLD_MAX_MS"]);

/** The rules that keep the guard inside every destructive call of the executor: a raw unlink, rmdir, link, rename, overwrite or removal
 * only inside a guarded primitive; no rmdir of a lock folder's PUBLIC path (only of a private name, after its identity was checked);
 * and no exported function that writes an engine's file outside executeEnginePlans. */
function writerViolations(name: string, file: ts.SourceFile): string[] {
  const out: string[] = [];
  const enclosing = (node: ts.Node): string => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
      if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && at.initializer && (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))) return at.name.text;
    }
    return "";
  };
  walk(file, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const layer = node.expression.expression.text, member = node.expression.name.text;
      if ((layer === "mutOps" && DESTRUCTIVE_MUT.has(member)) || (layer === "exclOps" && member === "renameNoReplace")) {
        if (!GUARDED_PRIMITIVES.has(enclosing(node))) out.push(`${name}: ${layer}.${member} outside a guarded primitive (${[...GUARDED_PRIMITIVES].join(", ")}); every destructive call asks its guard first`);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "gRmdir") {
      const arg = node.arguments[1];
      const bad = !!arg && ((ts.isIdentifier(arg) && arg.text === "lock") || (ts.isTemplateExpression(arg) && /\.lock$/.test(arg.templateSpans[arg.templateSpans.length - 1]!.literal.text)) || (ts.isNoSubstitutionTemplateLiteral(arg) && /\.lock$/.test(arg.text)));
      if (bad) out.push(`${name}: removes the public path of a lock folder; a lock folder is removed only under a private name`);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      const names = ts.isFunctionDeclaration(node) ? (node.name ? [node.name.text] : []) : node.declarationList.declarations.filter((item) => ts.isIdentifier(item.name)).map((item) => (item.name as ts.Identifier).text);
      for (const exported of names) if (!EXEC_EXPORTS.has(exported)) out.push(`${name}: exports ${exported}; the executor exports no writer of an engine's file but executeEnginePlans`);
    }
  });
  return out;
}

/** The syntax rules of one file for the role it plays. */
export function violations(name: string, src: string, role: Role | undefined = ENGINE_FILES[name]): string[] {
  const out: string[] = [];
  if (!role) return [`${name}: not a known engine-history module`];
  const file = parse(name, src);
  const { modules, escapes } = importsOf(src, name);
  if (role !== "reader") {
    const allowed = new Set(ALLOWED[name] ?? []);
    for (const module of modules) {
      if (allowed.has(module)) continue;
      out.push(WORLD.test(module)
        ? `${name}: imports ${module}; only engine-fs.ts may touch the file system, a database or zlib`
        : `${name}: imports ${module}, which is not one of the modules it is allowed (${[...allowed].join(", ") || "none"})`);
    }
    for (const escape of escapes) if (!(role === "loader" && LOADER_ESCAPES.has(escape)) && !(role === "leaf" && escape === "import.meta")) out.push(`${name}: uses ${escape}, a way around the single reader`);
    for (const escape of processEscapes(file, role === "loader" ? PROCESS_LOADER_OK : PROCESS_OK)) out.push(`${name}: uses ${escape}, a way around the single reader`);
    if (role !== "loader") out.push(...layerViolations(name, file));
    walk(file, (node) => {
      // A raw function of the file system or a database named at a call: `readFileSync(...)`, `fs.readFileSync (...)`, `new DatabaseSync(...)`.
      const target = (ts.isCallExpression(node) || ts.isNewExpression(node)) ? node.expression : undefined;
      const called = target && ts.isIdentifier(target) ? target.text : target && ts.isPropertyAccessExpression(target) ? target.name.text : undefined;
      if (called && RAW_CALLS.has(called)) out.push(`${name}: calls ${called} directly instead of going through engine-fs.ts`);
    });
  } else {
    for (const module of modules) if (!(ALLOWED[name] ?? []).includes(module)) out.push(`${name}: imports ${module}, which the reader is not allowed`);
    for (const escape of escapes) if (escape !== "require") out.push(`${name}: uses ${escape}`);
  }
  out.push(...evalWorkerUses(name, file)); // every role, the reader and the loader too
  if (role === "planner") {
    walk(file, (node) => {
      if (ts.isTryStatement(node) || ts.isCatchClause(node)) out.push(`${name}: a planner has no try or catch (a read that fails must end the home's plan)`);
      else if (ts.isPropertyAccessExpression(node) && node.name.text === "catch") out.push(`${name}: a planner has no try or catch (a read that fails must end the home's plan)`);
    });
  }
  if (role === "worker") {
    for (const module of modules) if (module !== "node:worker_threads" && module !== "./engine-history-run.ts") out.push(`${name}: the worker may import only node:worker_threads and engine-history-run.ts, not ${module}`);
  }
  if (role === "offthread") {
    for (const module of modules) if (module.startsWith("./engine-")) out.push(`${name}: the thread that serves the app must not load ${module}`);
  }
  if (role === "driver") {
    let catches = 0;
    walk(file, (node) => { if (ts.isCatchClause(node)) catches++; });
    if (catches !== 1) out.push(`${name}: the driver has exactly one try: the one that gives a home that cannot be read no plan`);
  }
  if (role === "executor") {
    const layers = layerNamesOf(name, file).names;
    walk(file, (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        if (PLANNING_READERS.has(node.name.text)) out.push(`${name}: calls ${node.name.text}, a reader for planning; the executor never discovers`);
        if (ts.isIdentifier(node.expression) && layers.get(node.expression.text) === "fsOps" && node.name.text !== "lstat") out.push(`${name}: uses fsOps.${node.name.text}; the executor reads through the strict reader (only lstat is raw)`);
      } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && layers.has(node.expression.text)) {
        out.push(`${name}: reaches ${node.expression.text} by a computed name`);
      }
    });
    out.push(...readerViolations(name, file));
    if (name === "engine-exec.ts") out.push(...writerViolations(name, file));
  }
  return [...new Set(out)];
}

/** The rules over the whole set of files: nothing a planner or helper imports (transitively) reaches the reader or the executor,
 * and the thread that serves the app reaches no deletion module at all. `sources` is the text of each file by name. */
export function graphViolations(sources: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  const edges = new Map<string, string[]>();
  for (const [name, src] of Object.entries(sources)) edges.set(name, importsOf(src, name).modules.filter((module) => module.startsWith("./")).map((module) => module.slice(2)));
  const reach = (from: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const at = stack.pop()!;
      for (const next of edges.get(at) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return seen;
  };
  for (const [name, role] of Object.entries(ENGINE_FILES)) {
    if (!(name in sources)) continue;
    const closure = reach(name);
    if (role === "planner" || role === "helper" || role === "leaf") for (const bad of ["engine-fs.ts", "engine-exec.ts", "engine-redo.ts", "engine-history-run.ts", "engine-exclusion.ts"]) if (closure.has(bad)) out.push(`${name}: reaches ${bad} through the modules it imports`);
    if (name !== "engine-fs.ts" && (edges.get(name) ?? []).includes("engine-exclusion.ts")) out.push(`${name}: imports engine-exclusion.ts; only engine-fs.ts loads the native addon`);
    if (role === "offthread") for (const reached of closure) if (reached.startsWith("engine-")) out.push(`${name}: reaches ${reached} through the modules it imports`);
    for (const reached of closure) if (!(reached in ENGINE_FILES)) out.push(`${name}: reaches ${reached}, which is not an engine-history module or an audited leaf`);
  }
  return out;
}

/** Kept for the tests that strip comments before matching text. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
