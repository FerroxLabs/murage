// Transport inventory, independent of prompt/envelope/method names. A byte sink
// is model traffic until an executable, typed NotModelRequest says otherwise.
import ts from 'typescript';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles, walk, fetchAliases, isFetch } from './busyloop-sites.mjs';
const base = fileURLToPath(new URL('../', import.meta.url));
const drivers = sourceFiles(resolve(base, 'server/drivers'));
const roots = [...drivers, resolve(base, 'shared/flux-route.ts')];
const options = {target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,allowImportingTsExtensions:true,skipLibCheck:true};
let previous, baseline;
const parsed=new Map();
export function sinkInventory(overrides=new Map()) {
 if(!overrides.size && baseline)return baseline;
 const host=ts.createCompilerHost(options), read=host.readFile;
 const originalGet=host.getSourceFile;
 host.getSourceFile=(file,languageVersion,onError,shouldCreateNewSourceFile)=>{
  const text=host.readFile(file), cached=parsed.get(file);
  if(cached?.text===text)return cached.ast;
  const ast=originalGet(file,languageVersion,onError,shouldCreateNewSourceFile);
  if(!overrides.has(relative(base,file)))parsed.set(file,{text,ast});
  return ast;
 };
 host.readFile=p=>overrides.get(relative(base,p))??read(p);
 const program=ts.createProgram([...new Set([...roots,...overrides.keys()].map(p=>resolve(base,p)))],options,host,previous);
 if(!overrides.size)previous=program;
 const checker=program.getTypeChecker(),sinks=[],errors=[];
 const named=(n,name)=>n&&ts.isCallExpression(n)&&n.expression.getText()===name;
 function sharedCall(n,name) {
  if(!named(n,name))return false;
  let symbol=checker.getSymbolAtLocation(n.expression);
  if(symbol?.flags&ts.SymbolFlags.Alias)symbol=checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.some(d=>resolve(d.getSourceFile().fileName)===resolve(base,name==='NotModelRequest'?'shared/engine-transport.ts':'shared/flux-route.ts'));
 }
 function unwrap(n) {while(n&&(ts.isParenthesizedExpression(n)||ts.isAsExpression(n)||ts.isNonNullExpression(n)))n=n.expression;return n;}
 function decision(n) {
  n=unwrap(n);if(!sharedCall(n,'fluxRouteFor')||n.arguments.length!==1)return false;
  const url=n.arguments[0];
  if(named(url,'noFluxTraffic')) {
   if(!sharedCall(url,'noFluxTraffic')||!ts.isObjectLiteralExpression(url.arguments[0]))return false;
   const fields=url.arguments[0].properties;
   return ['citation','reason'].every(key=>fields.some(p=>ts.isPropertyAssignment(p)&&p.name.getText()===key&&ts.isStringLiteral(p.initializer)&&p.initializer.text.length>10));
  }
  return url.kind!==ts.SyntaxKind.NullKeyword&&url.getText()!=='undefined';
 }
 function proof(n) {
  n=unwrap(n);if(!n)return;
  if(sharedCall(n,'NotModelRequest')&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text.trim().length>10)return {kind:'NotModelRequest',reason:n.arguments[0].text};
  if(sharedCall(n,'registerBusyloopRequestSite')&&decision(n.arguments[0]))return {kind:'model-request'};
  if(ts.isPropertyAccessExpression(n)&&n.name.text==='requestUrl'&&decision(n.expression))return {kind:'model-request'};
 }
 function transportType(n) {
  const type=checker.getTypeAtLocation(n);
  if(type.flags & (ts.TypeFlags.Any|ts.TypeFlags.Unknown))return true; // Untyped transports cannot silently opt out.
  const names=new Set();
  function visit(t) {
   if(!t||names.has(t))return false;names.add(t);
   if(t.getProperty?.('engineTransport'))return true;
   if(t.isUnionOrIntersection?.()&&t.types.some(visit))return true;
   const decl=t.symbol?.declarations??[];
   if(t.symbol?.name==='WebSocket'&&decl.some(d=>/lib\.dom\.d\.ts$/.test(d.getSourceFile().fileName)))return true;
   if(decl.some(d=>/node_modules\/.*(?:@types\/node\/(?:stream|net|child_process|http)|@types\/ws|undici|openai|anthropic|generative-ai|@muse-code\/sdk)/.test(d.getSourceFile().fileName)))return true;
   return (t.getBaseTypes?.()??[]).some(visit);
  }
  return visit(type);
 }
 const markedFiles=[];
 for(const ast of program.getSourceFiles()) {
  const file=relative(base,ast.fileName);
  if(!/^(server|shared)\//.test(file)||/\.test\.|\.d\.[cm]?ts$/.test(file))continue;
  walk(ast,n=>{if(ts.isClassDeclaration(n)&&checker.getTypeAtLocation(n).getProperty('engineTransport'))markedFiles.push(ast.fileName);});
 }
 function transportAlias(n,seen=new Set()) {
  if(!n||seen.has(n))return false;seen.add(n);
  if(ts.isPropertyAccessExpression(n))return /^(send|write|end|request|notify|command|dispatch|fetch)$/.test(n.name.text)&&transportType(n.expression);
  if(ts.isElementAccessExpression(n))return transportType(n.expression);
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='bind')return transportAlias(n.expression.expression,seen);
  if(ts.isIdentifier(n))return (checker.getSymbolAtLocation(n)?.declarations??[]).some(d=>d.initializer&&transportAlias(d.initializer,seen));
  return false;
 }
 for(const path of new Set([...drivers,...markedFiles,...[...overrides.keys()].filter(k=>k.startsWith('server/drivers/')).map(k=>resolve(base,k))])) {
  const ast=program.getSourceFile(path);if(!ast)continue;
  const file=relative(base,path),aliases=fetchAliases(ast),sdkImports=new Set();
  walk(ast,n=>{
   if(ts.isImportDeclaration(n)&&/^(?:openai|@anthropic-ai\/sdk|@google\/(?:generative-ai|genai)|@muse-code\/sdk|@aws-sdk\/client-bedrock)(?:$|\/)/.test(n.moduleSpecifier.text)) {
    if(n.importClause?.name)sdkImports.add(n.importClause.name.text);
    for(const e of n.importClause?.namedBindings?.elements??[])sdkImports.add(e.name.text);
   }
  });
  function sdkReceiver(n,seen=new Set()) {
   if(!n||seen.has(n))return false;seen.add(n);
   if(ts.isPropertyAccessExpression(n)||ts.isElementAccessExpression(n))return sdkReceiver(n.expression,seen);
   if(ts.isNewExpression(n))return sdkImports.has(n.expression.getText());
   if(ts.isIdentifier(n)) {
    for(const d of checker.getSymbolAtLocation(n)?.declarations??[]) {
     if(d.type&&ts.isTypeReferenceNode(d.type)&&sdkImports.has(d.type.typeName.getText()))return true;
     if(d.initializer&&sdkReceiver(d.initializer,seen))return true;
    }
   }
   return false;
  }
  walk(ast,n=>{
   if(ts.isImportDeclaration(n)&&/^(?:undici|(?:node:)?https?)$/.test(n.moduleSpecifier.text)) {
    const bindings=n.importClause?.namedBindings;
    if(n.importClause?.name)for(const method of ['get','request','fetch'])aliases.add(n.importClause.name.text+'.'+method);
    if(bindings&&ts.isNamespaceImport(bindings))for(const method of ['get','request','fetch'])aliases.add(bindings.name.text+'.'+method);
    if(bindings&&ts.isNamedImports(bindings))for(const e of bindings.elements)if(/^(fetch|request|get)$/.test((e.propertyName??e.name).text))aliases.add(e.name.text);
   }
   if(ts.isClassDeclaration(n)&&n.members.some(m=>m.name&&/^(send|write|request|notify)$/.test(m.name.getText()))) {
    if(!checker.getTypeAtLocation(n).getProperty('engineTransport'))errors.push(`UNMARKED TRANSPORT ${file}:${n.name?.text}`);
   }
  });
  walk(ast,n=>{
   if(!ts.isCallExpression(n))return;
   const expr=n.expression,prop=ts.isPropertyAccessExpression(expr)?expr:ts.isElementAccessExpression(expr)?{expression:expr.expression,name:{text:ts.isStringLiteralLike(expr.argumentExpression)?expr.argumentExpression.text:'<dynamic>'}}:undefined;
   const name=prop?.name.text??(ts.isIdentifier(expr)?expr.text:'');
   const network=isFetch(n,aliases);
   // These are transport verbs, never a list of model RPC methods or payload shapes.
   const primitive=prop&&/^(send|write|end|request|command|notify|dispatch|fetch|pipeline|stream|<dynamic>)$/.test(name)
     && (transportType(prop.expression)||/\.stdin$/.test(prop.expression.getText()));
   const local=(ts.isIdentifier(expr)&&/^(send|request)$/.test(name));
   const rpc=prop && /^(request|command|notify)$/.test(name);
   // Imported byte-writing helpers are transport handoffs too. Resolve the
   // declaration, not its name, and inspect its Writable parameter and body.
   const declaration=checker.getResolvedSignature(n)?.declaration;
   const bound=ts.isIdentifier(expr) && (transportAlias(expr) || declaration && (ts.isMethodDeclaration(declaration)||ts.isMethodSignature(declaration)) && /^(send|write|end|request|notify|command|dispatch|fetch)$/.test(declaration.name.getText()) && transportType(declaration.parent));
   let helper=false;
   if(declaration?.body && declaration.parameters?.some(p=> {
    const t=checker.getTypeAtLocation(p);
    return (t.isUnionOrIntersection?.() ? t.types : [t]).some(part=>part.symbol?.name==='Writable');
   }))walk(declaration.body,c=>{if(ts.isCallExpression(c)&&ts.isPropertyAccessExpression(c.expression)&&c.expression.name.text==='write')helper=true;});
   // SDK methods on SDK-declared receivers are sinks regardless of verb.
   const sdk=prop && (sdkReceiver(prop.expression)||(checker.getTypeAtLocation(prop.expression).symbol?.declarations??[])
     .some(d=>/node_modules\/.*(?:openai|anthropic|generative-ai|@muse-code\/sdk)/.test(d.getSourceFile().fileName)))
     && !/^(close|flush|mintCommandId|on\w+)$/.test(name);
   if(!network&&!primitive&&!local&&!sdk&&!rpc&&!helper&&!bound)return;
   if(name==='end'&&!n.arguments.length)return; // Closing without bytes cannot request a model.
   const annotations=[...n.arguments.map(proof), ...(ts.isCallExpression(n.parent) && n.parent.arguments[1]===n ? [proof(n.parent)] : [])].filter(Boolean);
   const annotation=annotations.find(p=>p.kind==='model-request')??annotations[0];
   const line=ast.getLineAndCharacterOfPosition(n.getStart()).line+1;
   const sink={file,line,start:n.getStart(),end:n.end,entry:expr.getText(),kind:annotation?.kind??'model-request',guarded:!!annotation,...(annotation?.reason?{reason:annotation.reason}:{})};
   sinks.push(sink);
   if(!annotation)errors.push(`UNROUTED SINK ${file}:${line} ${expr.getText()}`);
  });
 }
 const driversReport={};
 for(const file of drivers.map(p=>relative(base,p)))driversReport[file]={sinks:0,modelRequest:0,NotModelRequest:0,reasons:[]};
 for(const s of sinks){const r=driversReport[s.file]??={sinks:0,modelRequest:0,NotModelRequest:0,reasons:[]};r.sinks++;if(s.kind==='model-request')r.modelRequest++;else{r.NotModelRequest++;r.reasons.push({line:s.line,reason:s.reason});}}
 const result={sinks,drivers:driversReport,errors};
 if(!overrides.size)baseline=result;
 return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const result=sinkInventory();console.log(JSON.stringify(result,null,2));if(result.errors.length)process.exitCode=1;}
