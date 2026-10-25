// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The attachment read gate (r3 R12/R13, without any containment claim). With
// the server program's own type checker, not a regex:
// 1. every call whose callee resolves (through aliases, namespaces and
//    destructuring) to a byte-read API of node:fs or node:fs/promises is
//    listed, with its root, in attachment-read-gate.inventory.json; a new,
//    moved or extra call fails until it is registered (a reviewed change);
// 2. sites with root "attachments" live only in server/attachment-read.ts;
// 3. server/attachments.ts opens files only to write them: exactly
//    open(partialPath, "wx", 0o600), writeFileSync(partialPath, bytes,
//    { mode: 0o600, flag: "wx" }) and the empty Remove marker
//    writeFileSync(markerPath, "", { mode: 0o600, flag: "wx" }) (1.0.4
//    SL-H), nothing else;
// 4. the folder path is reached only by the writer: attachmentsFolderForWriter
//    is called only from server/attachments.ts, and no AttachmentsHome value
//    is ever turned into a string (concatenation, template, String()).
// ATTACHMENT_GATE_WRITE=1 regenerates the inventory (new sites get root
// "unreviewed", which this test refuses until a person names the root).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = join(REPO, "server", "attachment-read-gate.inventory.json");
const READ_FUNCTIONS = new Set(["readFile", "readFileSync", "createReadStream", "open", "openSync", "read", "readSync", "readv", "readvSync", "opendir"]);
const HANDLE_READS = new Set(["read", "readFile", "readv", "createReadStream"]);
const WRITE_OPENS = new Set(["open", "openSync", "writeFile", "writeFileSync", "createWriteStream", "appendFile", "appendFileSync", "copyFile", "copyFileSync", "cp", "cpSync"]);

interface Site { file: string; function: string; callee: string }
interface Entry extends Site { root: string; count: number }
interface Finding { sites: Site[]; writerViolations: string[]; boundaryViolations: string[] }

const isFsDeclaration = (file: string) => /[\\/]@types[\\/]node[\\/](fs|fs[\\/]promises)\.d\.ts$/.test(file);

function fsCallee(checker: ts.TypeChecker, call: ts.CallExpression): string | undefined {
  const target = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  let symbol = checker.getSymbolAtLocation(target);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  // const { open } = fsp: follow the destructured property to its declaration
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding && ts.isObjectBindingPattern(binding.parent) && ts.isVariableDeclaration(binding.parent.parent) && binding.parent.parent.initializer) {
    const property = (binding.propertyName ?? binding.name).getText();
    const from = checker.getTypeAtLocation(binding.parent.parent.initializer).getProperty(property);
    if (from) symbol = from.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(from) : from;
  }
  for (const declaration of symbol.declarations ?? []) {
    const file = declaration.getSourceFile().fileName;
    if (!isFsDeclaration(file)) continue;
    const parent = declaration.parent;
    if (ts.isInterfaceDeclaration(parent) && parent.name.text === "FileHandle") return HANDLE_READS.has(symbol.name) ? `FileHandle.${symbol.name}` : `FileHandle.${symbol.name}:other`;
    return symbol.name;
  }
  return undefined;
}

function enclosingName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isClassDeclaration(at)) && at.name) return at.name.getText();
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent)) return at.parent.name.getText();
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isPropertyAssignment(at.parent)) return at.parent.name.getText();
  }
  return "<module>";
}

const isHomeType = (checker: ts.TypeChecker, node: ts.Node) => {
  const type = checker.getTypeAtLocation(node);
  return (type.aliasSymbol?.name ?? checker.typeToString(type)) === "AttachmentsHome";
};

function writerOpenAllowed(callee: string, call: ts.CallExpression): boolean {
  const [path, second, third] = call.arguments;
  // The Remove marker: an empty file, created exclusively (SL-H H1).
  if (callee === "writeFileSync" && path && ts.isIdentifier(path) && path.text === "markerPath") {
    if (call.arguments.length !== 3 || !second || !ts.isStringLiteral(second) || second.text !== "" || !third || !ts.isObjectLiteralExpression(third)) return false;
    const flags = third.properties.filter(p => ts.isPropertyAssignment(p) && p.name.getText() === "flag");
    return flags.length === 1 && ts.isStringLiteral((flags[0] as ts.PropertyAssignment).initializer) && ((flags[0] as ts.PropertyAssignment).initializer as ts.StringLiteral).text === "wx";
  }
  if (!path || !ts.isIdentifier(path) || path.text !== "partialPath") return false;
  if (callee === "open") return call.arguments.length === 3 && !!second && ts.isStringLiteral(second) && second.text === "wx";
  if (callee === "writeFileSync") {
    if (call.arguments.length !== 3 || !third || !ts.isObjectLiteralExpression(third)) return false;
    const flags = third.properties.filter(p => ts.isPropertyAssignment(p) && p.name.getText() === "flag");
    return flags.length === 1 && ts.isStringLiteral((flags[0] as ts.PropertyAssignment).initializer) && ((flags[0] as ts.PropertyAssignment).initializer as ts.StringLiteral).text === "wx";
  }
  return false;
}

function analyze(program: ts.Program, files: readonly ts.SourceFile[], root: string): Finding {
  const checker = program.getTypeChecker();
  const found: Finding = { sites: [], writerViolations: [], boundaryViolations: [] };
  for (const source of files) {
    const file = relative(root, source.fileName).split(sep).join("/");
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = fsCallee(checker, node);
        if (callee && (READ_FUNCTIONS.has(callee) || callee.startsWith("FileHandle.") && !callee.endsWith(":other"))) {
          found.sites.push({ file, function: enclosingName(node), callee });
        }
        if (file === "server/attachments.ts" && callee && (WRITE_OPENS.has(callee) || READ_FUNCTIONS.has(callee) || callee.startsWith("FileHandle.") && !callee.endsWith(":other"))) {
          if (!writerOpenAllowed(callee, node)) found.writerViolations.push(`${file}: ${node.getText().slice(0, 120)}`);
        }
        const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        if (target.getText() === "attachmentsFolderForWriter" && file !== "server/attachments.ts" && file !== "server/attachment-read.ts") {
          found.boundaryViolations.push(`${file}: attachmentsFolderForWriter outside the writer`);
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === "String" && node.arguments.some(arg => isHomeType(checker, arg))) {
          found.boundaryViolations.push(`${file}: String() of an AttachmentsHome`);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && (isHomeType(checker, node.left) || isHomeType(checker, node.right))) {
        found.boundaryViolations.push(`${file}: an AttachmentsHome in string concatenation`);
      }
      if (ts.isTemplateSpan(node) && isHomeType(checker, node.expression)) found.boundaryViolations.push(`${file}: an AttachmentsHome in a template string`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

function count(sites: readonly Site[]): Map<string, Site & { count: number }> {
  const counted = new Map<string, Site & { count: number }>();
  for (const site of sites) {
    const key = `${site.file}\0${site.function}\0${site.callee}`;
    const entry = counted.get(key) ?? { ...site, count: 0 };
    entry.count++; counted.set(key, entry);
  }
  return counted;
}

function serverProgram(): { program: ts.Program; files: ts.SourceFile[] } {
  const config = ts.getParsedCommandLineOfConfigFile(join(REPO, "tsconfig.server.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
  const roots = config.fileNames.filter(name => {
    const rel = relative(REPO, name).split(sep).join("/");
    return rel.startsWith("server/") && rel.endsWith(".ts") && !/\.test\.ts$|\.typetest\.ts$|\.fixture\.ts$/.test(rel) && !rel.startsWith("server/testing/");
  });
  const program = ts.createProgram(roots, config.options);
  return { program, files: roots.map(name => program.getSourceFile(name)!).filter(Boolean) };
}

/** A small program over in-memory fixture files, with the real @types/node. */
function fixtureProgram(sources: Record<string, string>): Finding {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], strict: true, noEmit: true, allowImportingTsExtensions: true };
  const host = ts.createCompilerHost(options);
  const names = Object.keys(sources).map(name => join(REPO, name));
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) => {
    const rel = relative(REPO, name).split(sep).join("/");
    return rel in sources ? ts.createSourceFile(name, sources[rel]!, version) : getSourceFile(name, version, ...rest);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = name => relative(REPO, name).split(sep).join("/") in sources || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = name => sources[relative(REPO, name).split(sep).join("/")] ?? readFile(name);
  const program = ts.createProgram(names, options, host);
  return analyze(program, names.map(name => program.getSourceFile(name)!), REPO);
}

describe("attachment read gate", () => {
  it("every fs byte-read site is registered with its root; attachment reads live only in attachment-read.ts; the writer only writes", () => {
    const { program, files } = serverProgram();
    const found = analyze(program, files, REPO);
    const current = [...count(found.sites).values()].sort((a, b) => `${a.file}${a.function}${a.callee}`.localeCompare(`${b.file}${b.function}${b.callee}`));
    const inventory = JSON.parse(readFileSync(INVENTORY, "utf8")) as Entry[];
    if (process.env.ATTACHMENT_GATE_WRITE === "1") {
      const roots = new Map(inventory.map(entry => [`${entry.file}\0${entry.function}\0${entry.callee}`, entry.root]));
      writeFileSync(INVENTORY, `${JSON.stringify(current.map(site => ({ file: site.file, function: site.function, callee: site.callee, root: roots.get(`${site.file}\0${site.function}\0${site.callee}`) ?? "unreviewed", count: site.count })), null, 1)}\n`);
      return;
    }
    expect(current.map(({ file, function: fn, callee, count: n }) => ({ file, function: fn, callee, count: n })))
      .toEqual(inventory.map(({ file, function: fn, callee, count: n }) => ({ file, function: fn, callee, count: n })));
    expect(inventory.filter(entry => !entry.root || entry.root === "unreviewed")).toEqual([]);
    expect(inventory.filter(entry => entry.root === "attachments" && entry.file !== "server/attachment-read.ts")).toEqual([]);
    expect(inventory.some(entry => entry.root === "attachments" && entry.file === "server/attachment-read.ts")).toBe(true);
    expect(found.writerViolations).toEqual([]);
    expect(found.boundaryViolations).toEqual([]);
  }, 240_000);

  it("fixtures: aliased, namespaced and destructured reads are found; writer flags other than exactly \"wx\" fail; the home never becomes a string", () => {
    const found = fixtureProgram({
      "server/fixture-alias.ts": `import { readFileSync as r } from "node:fs";\nexport const a = (row: { path: string }) => r(row.path);\n`,
      "server/fixture-namespace.ts": `import * as f from "node:fs";\nexport function b(row: { path: string }) { return f.readFileSync(row.path); }\n`,
      "server/fixture-destructure.ts": `import * as fsp from "node:fs/promises";\nconst { open } = fsp;\nexport async function c(p: string) { const h = await open(p); return h.read(Buffer.alloc(1), 0, 1, 0); }\n`,
      "server/attachments.ts": [
        `import { open } from "node:fs/promises";`, `import { writeFileSync } from "node:fs";`,
        `declare const partialPath: string; declare const markerPath: string; declare const flag: string; declare const b: Buffer;`,
        `export async function w() {`,
        `  await open(partialPath, "wx", 0o600);`,
        `  writeFileSync(partialPath, b, { mode: 0o600, flag: "wx" });`,
        `  writeFileSync(markerPath, "", { mode: 0o600, flag: "wx" });`,
        `  await open(partialPath, "r");`, `  await open(partialPath, "wx+", 0o600);`, `  await open(partialPath, flag, 0o600);`, `  writeFileSync(partialPath, b);`,
        `  writeFileSync(markerPath, b, { mode: 0o600, flag: "wx" });`, `  writeFileSync(markerPath, "", { mode: 0o600, flag: "w" });`,
        `}`,
      ].join("\n"),
      "server/attachment-read.ts": `declare const homeKey: unique symbol;\nexport type AttachmentsHome = { readonly [homeKey]: true };\nexport declare function attachmentsFolderForWriter(home: AttachmentsHome): string;\n`,
      "server/fixture-home.ts": `import { attachmentsFolderForWriter, type AttachmentsHome } from "./attachment-read.ts";\ndeclare const home: AttachmentsHome;\nexport const x = home + "/x.png", y = \`\${home}/y.png\`, z = String(home), w = attachmentsFolderForWriter(home);\n`,
    });
    const callees = found.sites.map(site => `${site.file}:${site.function}:${site.callee}`);
    expect(callees).toEqual(expect.arrayContaining([
      "server/fixture-alias.ts:a:readFileSync", "server/fixture-namespace.ts:b:readFileSync",
      "server/fixture-destructure.ts:c:open", "server/fixture-destructure.ts:c:FileHandle.read",
    ]));
    expect(found.writerViolations).toHaveLength(6);
    expect(found.writerViolations.join("\n")).toMatch(/"r"\)[\s\S]*"wx\+"[\s\S]*flag, 0o600[\s\S]*writeFileSync\(partialPath, b\)[\s\S]*writeFileSync\(markerPath, b,[\s\S]*flag: "w" \}/);
    expect(found.boundaryViolations).toHaveLength(4);
    expect(found.boundaryViolations).toEqual(expect.arrayContaining([
      "server/fixture-home.ts: String() of an AttachmentsHome",
      "server/fixture-home.ts: attachmentsFolderForWriter outside the writer",
      "server/fixture-home.ts: an AttachmentsHome in string concatenation",
      "server/fixture-home.ts: an AttachmentsHome in a template string",
    ]));
  }, 120_000);
});
