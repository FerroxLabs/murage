import ts from 'typescript';

const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };

// MAIN RULING 1115-IOMETER (GrokBuild). These are reference exceptions,
// not launch exceptions. Match the reviewed AST statement shapes (ignoring
// trivia), including the complete sync loop and forwarding trap, so a changed
// API list, escaped original, or rebuilt caller arguments fails closed. Keeping
// the trap scaffold exact also prevents reassignment/shadowing of its arguments
// or target from turning a superficially valid Reflect.apply into a bypass.
const tokensOf = source => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const tokens = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
    tokens.push([kind, scanner.getTokenText()]);
  return JSON.stringify(tokens);
};
const meterPrototype = tokensOf(`const prototype=childProcess.ChildProcess.prototype as childProcess.ChildProcess&{spawn:(options:NormalizedOptions)=>number};`);
const meterSyncLoop = tokensOf(`for(const api of ["spawnSync","execFileSync","execSync"] as const){
  const original=childProcess[api];
  Object.assign(childProcess,{[api]:new Proxy(original,{apply(target,receiver,args){
   if(inside.getStore())return Reflect.apply(target,receiver,args);
   const cls=api==="execSync"?"ENGINE_EXCLUDED":classifyChildIo(args[0],Array.isArray(args[1])?args[1]:[]);
   runCounts[cls]++;
   if(cls!=="ENGINE_EXCLUDED"){invalidateChildIo();markIoMeterUnknown();}
   return inside.run(true,()=>Reflect.apply(target,receiver,args));
  }})});
 }`);
export function inspectMeterReferences(file, source) {
  const allowed = new Set(), failures = [];
  const result = { starts: allowed, failures };
  if (file !== 'server/io-child-meter.ts') return result;
  const ast = typeof source === 'string'
    ? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true) : source;
  // A local Proxy/Reflect/Object or replacement module binding would change
  // the meaning of the reviewed statements without changing their tokens.
  let shadowed = false;
  walk(ast, node => {
    if (!(ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
      || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportSpecifier(node)
      || ts.isImportClause(node) || ts.isNamespaceImport(node)) || !node.name
      || !ts.isIdentifier(node.name) || !['childProcess', 'Proxy', 'Reflect', 'Object'].includes(node.name.text)) return;
    if (ts.isImportClause(node) && node.name.text === 'childProcess' && !node.isTypeOnly
      && node.parent.moduleSpecifier.text === 'node:child_process') return;
    shadowed = true;
    failures.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      kind: 'unrecognized-child-reference', text: 'meter reference globals may not be shadowed' });
  });
  if (shadowed) return result;
  for (const installer of ast.statements) {
    if (!ts.isFunctionDeclaration(installer) || installer.name?.text !== 'installChildProcessMeter' || !installer.body) continue;
    // Only direct statements of the installer qualify. Never bless a whole
    // function/file or aliases in neighbouring/nested scopes.
    for (const statement of installer.body.statements) {
      const tokens = tokensOf(statement.getText(ast));
      if (tokens !== meterPrototype && tokens !== meterSyncLoop) continue;
      walk(statement, node => {
        if (ts.isIdentifier(node) && ['childProcess', 'original'].includes(node.text)
          || ts.isPropertyAccessExpression(node) && node.getText(ast) === 'childProcess.ChildProcess')
          allowed.add(node.getStart(ast));
      });
    }
  }
  return result;
}
