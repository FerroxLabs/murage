// Syntax is inspected as data. PowerShell files are never loaded or executed.
// Scope and binding MAIN ruling: ./SCANNER-SCOPE.md
import ts from 'typescript';
import {readFileSync,readdirSync,lstatSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,relative,extname,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {runLinuxFixture} from './native-launcher.mjs';
const here=dirname(fileURLToPath(import.meta.url));
export const nativeOwnerPaths=Object.freeze([resolve(here,'owned-process.ps1'),resolve(here,'native-launcher.mjs')]);
const extensions=new Set(['.ps1','.psm1','.mjs','.js','.cjs','.cs','.cmd','.bat']);
const forbiddenCall=/^(?:kill|spawn(?:sync)?|execfile(?:sync)?|exec(?:sync)?|fork|terminate|terminateprocess)$/i;
const cache=new Map();
function scanPowerShell(entries) {
 const missing=entries.filter(e=>!cache.has(e.file+'\0'+e.source));
 if(missing.length) {
  const root=mkdtempSync(join(tmpdir(),'winscen-parser-'));
  try {
   const manifest=missing.map((e,i)=>{const path=join(root,`${i}.ps1`);writeFileSync(path,e.source);return {file:e.file,path};});
   const input=join(root,'manifest.json');writeFileSync(input,JSON.stringify(manifest));
   const result=runLinuxFixture(process.env.WINSCEN_PWSH||'pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',join(here,'parse-native.ps1'),'-Manifest',input],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
   if(result.error||result.signal||result.status!==0)throw new Error(`PowerShell parser unavailable: ${result.error?.message||result.stderr||result.signal||result.status}`);
   const hits=JSON.parse(result.stdout.replace(/^\uFEFF/,''));
   if(!Array.isArray(hits)||hits.some(h=>!manifest.some(e=>e.file===h.file)||!Number.isInteger(h.line)||typeof h.rule!=='string'))throw new Error('invalid PowerShell parser result');
   for(const e of missing)cache.set(e.file+'\0'+e.source,hits.filter(h=>h.file===e.file));
  } catch(error) {
   // Never fall back to regex or cache a tooling failure as a successful parse.
   return entries.flatMap(e=>[{file:e.file,line:1,rule:`parse failure: ${error.message}`}]);
  } finally {rmSync(root,{recursive:true,force:true});}
 }
 return entries.flatMap(e=>cache.get(e.file+'\0'+e.source));
}
function constantString(node) {
 if(!node)return null;
 if(ts.isStringLiteralLike(node))return node.text;
 if(ts.isParenthesizedExpression(node))return constantString(node.expression);
 if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken) {
  const left=constantString(node.left),right=constantString(node.right);return left===null||right===null?null:left+right;
 }
 return null;
}
function memberName(node) {
 if(ts.isPropertyAccessExpression(node))return node.name.text;
 if(ts.isElementAccessExpression(node))return constantString(node.argumentExpression);
 if(ts.isIdentifier(node))return node.text;
 return null;
}
function scanJavaScript(source,file,report) {
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 // MAIN p11e: capabilities are rejected at their source, before any call or
 // alias syntax can hide them. The older native-member checks below remain
 // defense in depth for externally supplied child handles.
 const restrictedModule=/^(?:node:)?(?:child_process|worker_threads|cluster|process|vm)$/;
 const dataMembers=new Set(['env','argv','platform','exitCode']);
 const events=new Set(['exit','SIGINT','SIGTERM']);
 const directCall=node=>ts.isCallExpression(node.parent)&&node.parent.expression===node&&!node.parent.questionDotToken;
 const plainMember=(node,object)=>ts.isPropertyAccessExpression(node)&&node.expression===object&&!node.questionDotToken;
 function allowedProcess(node) {
  const member=node.parent;
  if(!plainMember(member,node))return false;
  const name=member.name.text;
  if(dataMembers.has(name))return true;
  if(name==='cwd'||name==='exit')return directCall(member);
  if(name==='hrtime')return directCall(member)||(plainMember(member.parent,member)&&member.parent.name.text==='bigint'&&directCall(member.parent));
  if(name==='stdout'||name==='stderr')return plainMember(member.parent,member)&&member.parent.name.text==='write'&&directCall(member.parent);
  if(name==='on'&&directCall(member)) {
   const call=member.parent,event=call.arguments[0];
   // on() returns process: do not let a registration become an object alias.
   return event&&ts.isStringLiteral(event)&&events.has(event.text)&&ts.isExpressionStatement(call.parent);
  }
  return false;
 }
 function isName(node) {
  const parent=node.parent;
  return (ts.isPropertyAccessExpression(parent)&&parent.name===node)||
   ((ts.isPropertyAssignment(parent)||ts.isMethodDeclaration(parent)||ts.isPropertyDeclaration(parent))&&parent.name===node)||
   ((ts.isBindingElement(parent)||ts.isImportSpecifier(parent)||ts.isExportSpecifier(parent))&&parent.propertyName===node);
 }
 function capabilities(node) {
  const fail=rule=>report(node.getStart(ast),rule);
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier) {
   if(!ts.isStringLiteral(node.moduleSpecifier)||restrictedModule.test(node.moduleSpecifier.text))fail('JavaScript module outside process allowlist');
  }
  if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)fail('dynamic JavaScript import');
  if(ts.isIdentifier(node)&&!isName(node)) {
   if(node.text==='process'&&!allowedProcess(node))fail('JavaScript process use outside allowlist');
   if(['eval','Function','vm'].includes(node.text))fail('dynamic JavaScript execution');
   if(node.text==='require') {
    const call=node.parent,arg=ts.isCallExpression(call)?call.arguments[0]:undefined;
    if(!directCall(node)||call.arguments.length!==1||!arg||!ts.isStringLiteral(arg)||restrictedModule.test(arg.text))fail('JavaScript require outside allowlist');
   }
  }
  if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)) {
   const name=memberName(node);
   if(['eval','Function','vm','require','constructor'].includes(name))fail('indirect JavaScript execution');
   if(ts.isIdentifier(node.expression)&&node.expression.text==='Reflect'&&['apply','construct'].includes(name))fail('reflective JavaScript execution');
   if(ts.isIdentifier(node.expression)&&['globalThis','global'].includes(node.expression.text)&&
      (ts.isElementAccessExpression(node)||name==='process'))fail('indirect global process access');
  }
  // A global-object alias would bypass the direct global member check.
  if(ts.isIdentifier(node)&&['globalThis','global'].includes(node.text)&&!isName(node)&&
     !(ts.isPropertyAccessExpression(node.parent)&&node.parent.expression===node))fail('global object alias');
  ts.forEachChild(node,capabilities);
 }
 capabilities(ast);
 const options={allowJs:true,noLib:true,noResolve:true,target:ts.ScriptTarget.Latest};
 const host={...ts.createCompilerHost(options),getSourceFile:name=>name===file?ast:undefined,readFile:name=>name===file?source:undefined,fileExists:name=>name===file};
 const checker=ts.createProgram([file],options,host).getTypeChecker();
 const binding=node=>node&&ts.isIdentifier(node)?checker.getSymbolAtLocation(node):undefined;
 for(const diagnostic of ast.parseDiagnostics)report(diagnostic.start||0,'parse failure: JavaScript');
 const bindings=new Set();
 const computedBindings=new Set();
 function computedFunction(node) {
  if(ts.isParenthesizedExpression(node))return computedFunction(node.expression);
  return ts.isElementAccessExpression(node)||computedBindings.has(binding(node));
 }
 function collect(node) {
  if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)) {
   const named=node.importClause?.namedBindings;
   if(named&&ts.isNamedImports(named))for(const element of named.elements)if(forbiddenCall.test((element.propertyName||element.name).text))bindings.add(binding(element.name));
  }
  if(ts.isVariableDeclaration(node)&&node.initializer) {
   if(ts.isIdentifier(node.name)&&computedFunction(node.initializer))computedBindings.add(binding(node.name));
   if(ts.isIdentifier(node.name)&&(forbiddenCall.test(memberName(node.initializer)||'')||bindings.has(binding(node.initializer))||(ts.isElementAccessExpression(node.initializer)&&memberName(node.initializer)===null)))bindings.add(binding(node.name));
   if(ts.isObjectBindingPattern(node.name))for(const element of node.name.elements) {
    const property=element.propertyName;
    const name=property&&ts.isComputedPropertyName(property)?constantString(property.expression):property?.text||element.name.text||'';
    if(name===null||forbiddenCall.test(name))bindings.add(binding(element.name));
   }
  }
  ts.forEachChild(node,collect);
 }
 // Fixed point resolves chains of local aliases irrespective of declaration order.
 let size=-1;while(size!==bindings.size+computedBindings.size){size=bindings.size+computedBindings.size;collect(ast);}
 function visit(node) {
  if(ts.isCallExpression(node)) {
   const name=memberName(node.expression);
   if(forbiddenCall.test(name||'')||bindings.has(binding(node.expression)))report(node.getStart(ast),'unowned native call');
   if(ts.isElementAccessExpression(node.expression)&&name===null)report(node.getStart(ast),'dynamic computed JavaScript call');
  }
  if((ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))&&forbiddenCall.test(memberName(node)||''))report(node.getStart(ast),'unowned native member access');
  if((ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))&&['call','apply','bind'].includes(memberName(node))&&computedFunction(node.expression))report(node.getStart(ast),'indirect computed JavaScript execution');
  // Preserve the prior ban on require/dynamic-import of the process API too.
  if(ts.isStringLiteral(node)&&/^(?:node:)?child_process$/i.test(node.text))report(node.getStart(ast),'native process API outside owner');
  ts.forEachChild(node,visit);
 }
 visit(ast);
}
function scanBatch(source,report) {
 // Join CMD's escaped physical newline, retaining offsets for diagnostics.
 const code=source.replace(/\^\r?\n/g,'');
 let token='',start=0,quote=false,comment=false,lineStart=true;
 const flush=()=>{if(!token)return;const name=token.replace(/^@/,'').split(/[\\/]/).at(-1);if(/^(?:taskkill|tskill|wmic)(?:\.exe)?$/i.test(name)||/\.(?:exe|com)$/i.test(name))report(start,'unowned batch native command');token='';};
 for(let i=0;i<=code.length;i++) {
  const ch=code[i];
  if(comment){if(ch==='\n'){comment=false;lineStart=true;}continue;}
  if(lineStart&&(!ch||/\s/.test(ch)))continue;
  if(lineStart&&/^(?:@?rem(?:\s|$)|::)/i.test(code.slice(i))){comment=true;continue;}
  lineStart=false;
  if(ch==='"'){if(!token)start=i;quote=!quote;continue;}
  if(ch==='^'&&i+1<code.length){if(!token)start=i;token+=code[++i];continue;}
  if(ch===undefined||(!quote&&/[\s&|()<>]/.test(ch))){flush();if(ch==='\n')lineStart=true;continue;}
  if(!token)start=i;token+=ch;
 }
 if(quote)report(0,'parse failure: unterminated batch quote');
 if(/\^(?:\r?\n)?$/.test(source))report(source.length-1,'parse failure: dangling batch continuation');
}
export function scanSource(source,file) {
 if(/\.(?:ps1|psm1|cs)$/i.test(file))return scanPowerShell([{source,file}]);
 const hits=[];const report=(at,rule)=>hits.push({file,line:source.slice(0,at).split('\n').length,rule});
 if(/\.(?:mjs|js|cjs)$/i.test(file))scanJavaScript(source,file,report);
 else if(/\.(?:cmd|bat)$/i.test(file))scanBatch(source,report);
 return hits;
}
export function scanWindowsTree(root=new URL('.',import.meta.url)) {
 root=resolve(root instanceof URL?fileURLToPath(root):root);
 const hits=[],powershell=[];
 function walk(dir) {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
   const path=join(dir,entry.name),file=relative(root,path);
   if(entry.isSymbolicLink()){hits.push({file,line:1,rule:'source symlink refused'});continue;}
   if(entry.isDirectory()){walk(path);continue;}
   if(!extensions.has(extname(path).toLowerCase())||nativeOwnerPaths.includes(path))continue;
   if(!lstatSync(path).isFile())continue;
   const source=readFileSync(path,'utf8');
   if(/\.(?:ps1|psm1|cs)$/i.test(path))powershell.push({file,source});else hits.push(...scanSource(source,file));
  }
 }
 walk(root);hits.push(...scanPowerShell(powershell));return hits;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const hits=scanWindowsTree();for(const hit of hits)console.error(`${hit.file}:${hit.line}: ${hit.rule}`);
 console.log(`Native ownership scanner: ${hits.length} violations; parse failures: ${hits.filter(h=>h.rule.startsWith('parse failure:')).length}`);process.exitCode=hits.length?1:0;
}
