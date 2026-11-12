// Structural inventory: executable AST only, across all server/shared sources.
// No payload site list. New decodes need a typed marker; new sockets need a
// URL decision or an explicitly reviewed, content-pinned non-model source.
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = fileURLToPath(new URL('../', import.meta.url));
const exemptions = JSON.parse(readFileSync(new URL('./busyloop-nonmodel.json', import.meta.url), 'utf8'));
export function sourceFiles(dir) {
 return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory() && !['__fixtures__','testing','node_modules'].includes(e.name)
  ? sourceFiles(join(dir,e.name)) : e.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(e.name) && !/(?:\.test\.|\.config\.|\.d\.[cm]?ts$)/.test(e.name) ? [join(dir,e.name)] : []);
}
export function walk(node, fn) { fn(node); ts.forEachChild(node, child=>walk(child,fn)); }
export const classifiers = new Set(['fluxResponseDecision','acpRefusal','cliFluxBudget','claudeRefusal','cliRefusal']);
export function isDecode(n) { return ts.isCallExpression(n) && (n.expression.getText()==='JSON.parse' || ts.isPropertyAccessExpression(n.expression) && n.expression.name.text==='json'); }
export function fetchAliases(ast) {
 const aliases=new Set(['fetch','fetchImpl','fetcher']);
 walk(ast,n=>{
  if(ts.isImportDeclaration(n)&&/^(?:node:)?https?$/.test(n.moduleSpecifier.text)) {
   if(n.importClause?.name)aliases.add(n.importClause.name.text+'.request');
   const bindings=n.importClause?.namedBindings;
   if(bindings&&ts.isNamespaceImport(bindings))aliases.add(bindings.name.text+'.request');
   if(bindings&&ts.isNamedImports(bindings))for(const e of bindings.elements)if((e.propertyName??e.name).text==='request')aliases.add(e.name.text);
  }
 });
 // Follow aliases to a fixed point, including injected defaults and properties.
 for(let changed=true;changed;) { changed=false; walk(ast,n=>{
  if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer && !aliases.has(n.name.text)) {
   const x=n.initializer;
   if(aliases.has(x.getText()) || ts.isPropertyAccessExpression(x)&&/^(fetch|fetchImpl|fetcher)$/.test(x.name.text)
    || ts.isBinaryExpression(x)&&[x.left,x.right].some(v=>aliases.has(v.getText()))
    || ts.isConditionalExpression(x)&&[x.whenTrue,x.whenFalse].some(v=>aliases.has(v.getText()))) {aliases.add(n.name.text);changed=true;}
  }
 }); }
 return aliases;
}
export function isFetch(n, aliases) { return ts.isCallExpression(n) && (aliases.has(n.expression.getText()) || /^(?:http|https|transport)\.request$/.test(n.expression.getText()) || ts.isPropertyAccessExpression(n.expression)&&/^(fetch|fetchImpl|fetcher|#fetch)$/.test(n.expression.name.text)); }
function named(n,name) { return !!n && ts.isCallExpression(n) && n.expression.getText()===name; }
function contains(n,name) { let yes=false;if(n)walk(n,x=>{if(named(x,name))yes=true;});return yes; }
function statement(n) {while(n.parent&&!ts.isStatement(n))n=n.parent;return n;}
function nextStatement(n) {
 let current=statement(n);
 for(;;) {
  if(ts.isBlock(current.parent)||ts.isSourceFile(current.parent)) { const all=current.parent.statements,i=all.indexOf(current);if(i+1<all.length)return all[i+1]; }
  if(ts.isBlock(current.parent)&&ts.isTryStatement(current.parent.parent)&&current.parent.parent.tryBlock===current.parent){current=current.parent.parent;continue;}
  return undefined;
 }
}
function marker(n,kind) {return named(n,'registerBusyloopPayloadSite')&&n.arguments[0]?.text===kind;}
function routedUrl(n) {return !!n && ts.isPropertyAccessExpression(n)&&n.name.text==='requestUrl'&&named(n.expression,'fluxRouteFor');}
const paths=[...sourceFiles(join(base,'server')),...sourceFiles(join(base,'shared'))];
const cache=new Map();
function scan(file,source) {
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),sites=[],errors=[];
 const exempt=exemptions[file];
 const pinned=exempt && createHash('sha256').update(source).digest('hex')===(typeof exempt==='string'?exempt:exempt.sha256);
 if(exempt&&!pinned)errors.push('NON-MODEL DESTINATION NEEDS REVIEW '+file);
 let sharedRouteImport=false;
 walk(ast,n=>{
  if(ts.isImportDeclaration(n)&&resolve(base,dirname(file),n.moduleSpecifier.text)===join(base,'shared/flux-route.ts')) {
   const entries=n.importClause?.namedBindings;
   if(entries&&ts.isNamedImports(entries))sharedRouteImport ||= entries.elements.some(e=>e.name.text==='fluxRouteFor'&&(e.propertyName??e.name).text==='fluxRouteFor');
  }
 });
 if(file!=='shared/flux-route.ts'&&contains(ast,'fluxRouteFor')&&!sharedRouteImport)errors.push('UNROUTED '+file+':not the shared fluxRouteFor');
 const aliases=fetchAliases(ast);
 const bindings=new Map();
 walk(ast,n=>{if(ts.isVariableDeclaration(n)&&n.initializer)bindings.set(n.name.getText(),n.initializer);});
 function routeDecision(n,seen=new Set()) {
  if(!n)return false;
  if(ts.isParenthesizedExpression(n))return routeDecision(n.expression,seen);
  if(ts.isPropertyAccessExpression(n)&&n.name.text==='routed'&&named(n.expression,'fluxRouteFor'))return true;
  if(ts.isIdentifier(n)&&!seen.has(n.text)){seen.add(n.text);return routeDecision(bindings.get(n.text),seen);}
  return false;
 }

 const add=(n,kind,guarded,entry,reason)=>{const key=`${file}:${entry}(${n.arguments?.[0]?.getText()??n.getText().slice(0,90)})@${n.getStart()}`;sites.push({key,kind,guarded,entry,start:n.getStart(),end:n.end,scope:kind==='non-model'?'non-model':'request URL',...(reason?{reason}:{})});return key;};
 walk(ast,n=>{
  if(isFetch(n,aliases)) {
   if(exempt) {add(n,'non-model',!!pinned,n.expression.getText(),typeof exempt==='string'?'reviewed local control destination':exempt.reason);return;}
   const route=routedUrl(n.arguments[0]);
   const key=add(n,'request-route',route,n.expression.getText());
   if(!route)errors.push('UNROUTED '+key);
   // Conversation HTTP paths classify before any status/recovery branch.
   if(file.startsWith('server/drivers/')||file==='server/memory/extract.ts') {
    const guarded=contains(nextStatement(n),'inspectFluxResponse');
    add(n,'Flux-capable HTTP',guarded,n.expression.getText());
    if(!guarded)errors.push('UNCLASSIFIED '+key);
   }
  }
  if(ts.isVariableDeclaration(n)&&['budgetRoute','fluxRoutedTurn'].includes(n.name.getText())) {
   const guarded=routeDecision(n.initializer && ts.isConditionalExpression(n.initializer)?n.initializer.condition:n.initializer);const key=add(n,'request-route',guarded,n.name.getText());
   if(!guarded)errors.push('UNROUTED '+key);
  }
  if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&n.left.getText()==='fluxRoutedTurn') {
   const guarded=contains(n.right,'fluxRouteFor');const key=add(n,'request-route',guarded,'fluxRoutedTurn');
   if(!guarded)errors.push('UNROUTED '+key);
  }
  if(named(n,'inspectFluxResponse')&&!routeDecision(n.arguments[1]))errors.push('UNROUTED '+file+':inspectFluxResponse@'+n.getStart());
  if(named(n,'registerBusyloopRequestSite')) {
   const guarded=named(n.arguments[0],'fluxRouteFor');const key=add(n,'request-route',guarded,'registerBusyloopRequestSite');
   if(!guarded)errors.push('UNROUTED '+key);
  }
  // Byte sinks are inventoried independently by busyloop-sinks.mjs using
  // transport types, never prompt/envelope or RPC method shapes.
  if(named(n,'runHeadlessCli')&&ts.isObjectLiteralExpression(n.arguments[0])) {
   const prop=n.arguments[0].properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText()==='requestUrl');
   const guarded=prop&&routedUrl(prop.initializer);const key=add(n,'request-route',!!guarded,'runHeadlessCli');
   if(!guarded)errors.push('UNROUTED '+key);
  }
  if(ts.isCallExpression(n)&&classifiers.has(n.expression.getText())) {
   const guarded=marker(n.arguments[0],'classify'), key=add(n,'payload',guarded,n.expression.getText());
   if(!guarded)errors.push('UNCLASSIFIED '+key);
  }
  if(named(n,'registerBusyloopPayloadSite')) {
   const kind=n.arguments[0]?.text;
   if(kind==='classify'&&!(ts.isCallExpression(n.parent)&&classifiers.has(n.parent.expression.getText())&&n.parent.arguments[0]===n))errors.push('UNCLASSIFIED '+file+':orphan marker@'+n.getStart());
   if(kind==='read'&&!isDecode(n.arguments[1]))errors.push('INVALID PAYLOAD '+file+':read marker@'+n.getStart());
  }
  if(isDecode(n)&&!exempt) {
   const guarded=marker(n.parent,'read');const key=add(n,'payload-read',guarded,n.expression.getText());
   if(!guarded)errors.push('UNMARKED PAYLOAD '+key);
  }
 });
 return {sites,errors};
}
export function inventory(overrides=new Map()) {
 const sites=[],errors=[];
 for(const path of new Set([...paths,...[...overrides.keys()].filter(file=>/^(server|shared)\//.test(file)).map(file=>join(base,file))])) {
  const file=relative(base,path),source=overrides.get(file)??readFileSync(path,'utf8');
  let item=cache.get(file);
  if(!item||item.source!==source) {item={source,...scan(file,source)};if(!overrides.has(file))cache.set(file,item);}
  sites.push(...item.sites);errors.push(...item.errors);
 }
 return {sites,errors};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {const result=inventory();console.log(JSON.stringify(result,null,2));if(result.errors.length)process.exitCode=1;}
