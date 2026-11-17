// Import-boundary producer/consumer owner: gnl-harness-r11. Native protocols owner: MAIN.
// MAIN RULING 1114-GNL-HARNESS-BOUNDARY: imports, never mount-call syntax.
import {readdirSync,readFileSync,lstatSync} from 'node:fs';
import {join,relative,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {shippedEngineSpecs} from './engine-inventory.mjs';
const root=fileURLToPath(new URL('./fakes/',import.meta.url));
// Exact, deliberately small capability list. No loader, raw transport, process
// API, worker, package or launcher is available to a fake, even by re-export.
export const allowedBuiltins=Object.freeze([
 'node:fs','node:path','node:crypto','node:readline','node:timers/promises',
 'node:http','node:sqlite','node:stream',
]);
export const allowedFiles=Object.freeze([
 'acp.mjs','api-service.mjs','common.mjs','feature-off.mjs','mount-config.mjs','release-plan.mjs',
 '../baseline-f-plan.mjs','../oracle-class.mjs','../gated-handle.mjs',
]);
const localAllow=new Set(allowedFiles.map(name=>resolve(root,name)));
function files(dir,errors){
 return readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  const file=join(dir,entry.name);
  if(entry.isSymbolicLink()){errors.push(`${relative(root,file)}: symlink outside import boundary`);return [];}
  return entry.isDirectory()?files(file,errors):[file];
 });
}
export function mountStructure({overrides=new Map()}={}){
 const errors=[],imports=[],seen=new Set(),all=files(root,errors);
 // An overlay may add a nested fake: the audit must enumerate it as well.
 for(const file of overrides.keys())if(resolve(file).startsWith(root)&&!all.includes(resolve(file)))all.push(resolve(file));
 const pending=[...all];
 while(pending.length){
  const file=resolve(pending.shift());if(seen.has(file))continue;seen.add(file);
  const name=relative(root,file),source=overrides.get(file)??readFileSync(file,'utf8');
  if(file.endsWith('.json')){try{JSON.parse(source);}catch{errors.push(`${name}: invalid data file`);}continue;}
  if(!/\.[cm]?[jt]sx?$/.test(file)){errors.push(`${name}: unaudited file type`);continue;}
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  if(ast.parseDiagnostics.length)errors.push(`${name}: invalid module syntax`);
  const dependency=(node,style)=>{
   const at=ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1;
   const target=ts.isStringLiteralLike(node)?node.text:null;
   imports.push({file:name,at,style,target});
   if(target===null){errors.push(`${name}:${at}: nonliteral ${style}`);return;}
   if(allowedBuiltins.includes(target))return;
   if(!target.startsWith('.')){errors.push(`${name}:${at}: forbidden ${style} ${target}`);return;}
   const child=resolve(dirname(file),target);
   if(!localAllow.has(child)){errors.push(`${name}:${at}: forbidden ${style} ${target}`);return;}
   try{if(!overrides.has(child)&&!lstatSync(child).isFile())throw Error();}
   catch{errors.push(`${name}:${at}: unresolved ${style} ${target}`);return;}
   pending.push(child);
  };
  const walk=node=>{
   if(ts.isImportDeclaration(node))dependency(node.moduleSpecifier,'static');
   if(ts.isExportDeclaration(node)&&node.moduleSpecifier)dependency(node.moduleSpecifier,'re-export');
   if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference))dependency(node.moduleReference.expression,'require');
   if(ts.isCallExpression(node)){
    const callee=node.expression;
    if(callee.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(callee)&&callee.text==='require'||ts.isPropertyAccessExpression(callee)&&callee.name.text==='require'){
     if(node.arguments[0])dependency(node.arguments[0],callee.kind===ts.SyntaxKind.ImportKeyword?'dynamic':'require');
     else errors.push(`${name}: import/require without a target`);
    }
   }
   ts.forEachChild(node,walk);
  };
  walk(ast);
 }
 return {files:all.map(file=>relative(root,file)).sort(),imports,errors,dependencies:[...seen].map(file=>relative(root,file)).sort(),catalogue:shippedEngineSpecs().map(spec=>spec.id)};
}
