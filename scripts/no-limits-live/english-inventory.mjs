// Read-only English inventory for both proof tools; no entry is product UI.
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
export function englishInventory(root=resolve(fileURLToPath(new URL('../..',import.meta.url)))) {
 const entries=[];
 function scan(dir){for(const item of readdirSync(join(root,dir),{withFileTypes:true})){
  const file=dir+'/'+item.name;
  if(item.isDirectory()){if(!['evidence','fixtures','__pycache__','egress'].includes(item.name))scan(file);continue;}
  if(!item.name.endsWith('.mjs'))continue;
  const source=readFileSync(join(root,file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  function visit(node){
   if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)){
    const literal=ts.isTemplateExpression(node)?source.slice(node.getStart(ast)+1,node.end-1):node.text;
    if(!/[a-zA-Z]{2,}[ -][a-zA-Z]{2,}/.test(literal))return;
    const fixtureOnly=/\b(?:off|disabled|disconnected)\b[\s\S]*Settings/.test(literal);
    entries.push({file,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,literal,
     audience:fixtureOnly?'fixture-settings-line':/test\.mjs$|\/fakes\//.test(file)?'test-fixture':'operator-diagnostic-or-fixture',fixtureOnly,productUI:false});
   }else ts.forEachChild(node,visit);
  }visit(ast);
 }}
 for(const dir of ['scripts/no-limits-live','scripts/nolim-replay'])scan(dir);
 // The only product UI prose introduced by this fix round. Do not confuse it
 // with similarly worded settings lines authored by replay/predicate fixtures.
 const productFile='server/routines.ts',product=readFileSync(join(root,productFile),'utf8');
 for(const [i,line] of product.split('\n').entries())if(line.includes('run.output = "Channel messages are off.')) {
   const literal=JSON.parse(line.slice(line.indexOf('=')+1).trim().replace(/;$/,''));
   entries.push({file:productFile,line:i+1,literal,audience:'product-ui',fixtureOnly:false,productUI:true});
 }

 return entries.sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const out=resolve(process.argv[2]??'scripts/no-limits-live/evidence/english-inventory.json');
 if(out==='/dev'||out.startsWith('/dev/'))throw Error('Evidence path under /dev');
 writeFileSync(out,JSON.stringify(englishInventory(),null,2)+'\n');
}
