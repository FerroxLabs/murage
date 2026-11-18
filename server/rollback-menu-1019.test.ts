import { expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../electron/main.mjs',import.meta.url),'utf8');
const tree=ts.createSourceFile('main.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function downgradeArgs(parameters: object) {
 let branch:ts.Expression|undefined;
 const walk=(node:ts.Node)=>{if(ts.isConditionalExpression(node)&&node.condition.getText(tree)==='operation === "memory-downgrade"')branch=node.whenTrue;ts.forEachChild(node,walk);};walk(tree);
 expect(branch).toBeDefined();return runInNewContext(branch!.getText(tree),{dataDirectory:'/fixture',parameters});
}
it('D3 desktop rollback defaults to the previous release memory shape and offers it in Help',()=>{
 expect(downgradeArgs({})).toEqual(['memory-downgrade','--data-dir','/fixture','--to','13']);
 expect(source).toContain('label: "Prepare to reinstall Murage 1.0.18…"');
});
it('D3 retains the explicit 1.0.2 rollback target',()=>{
 expect(downgradeArgs({to:'10'})).toEqual(['memory-downgrade','--data-dir','/fixture','--to','10']);
 expect(source).toContain('label: "Prepare to reinstall Murage 1.0.2…"');
});
