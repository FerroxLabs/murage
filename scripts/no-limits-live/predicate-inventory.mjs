import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
export function predicateInventory(root) {
  const definitions=[],callers=new Set();
  function scan(dir) {
    if(!existsSync(dir))return;
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      const path=join(dir,entry.name);
      if(entry.isDirectory()) {if(!['testing','__fixtures__','__snapshots__','node_modules','dist'].includes(entry.name))scan(path);continue;}
      if(!entry.isFile()||!entry.name.endsWith('.ts')||/\.(test|spec|d)\.ts$/.test(entry.name))continue;
      const text=readFileSync(path,'utf8');if(!text.includes('noLimitsAppliesTo'))continue;
      const file=relative(root,path).replaceAll('\\','/'),source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
      function visit(node) {
        if(ts.isFunctionDeclaration(node)&&node.name?.text==='noLimitsAppliesTo'&&node.body)definitions.push(file);
        if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='noLimitsAppliesTo'&&node.initializer&&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer)))definitions.push(file);
        if(ts.isCallExpression(node)&&((ts.isIdentifier(node.expression)&&node.expression.text==='noLimitsAppliesTo')||(ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='noLimitsAppliesTo')))callers.add(file);
        ts.forEachChild(node,visit);
      }
      visit(source);
    }
  }
  scan(join(root,'server'));scan(join(root,'shared'));
  return {definitions,callers:[...callers].sort()};
}
export function predicateDefinitions(root) {return predicateInventory(root).definitions;}
