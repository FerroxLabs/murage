// SPDX-License-Identifier: AGPL-3.0-or-later
// Test support: classify every production request literal, retaining its data.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = join(dirname(fileURLToPath(import.meta.url)), '../drivers');
function sources(dir: string): string[] {
  return readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? entry.name === 'testing' ? [] : sources(path)
      : entry.name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(entry.name) && !entry.name.startsWith('no-limits-request-cwd-inventory-1019') ? [path] : [];
  });
}
function scopeOf(node: ts.Node): string {
  const scopes: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) scopes.push(p.name.text);
    else if (ts.isMethodDeclaration(p)) scopes.push(p.name.getText());
    else if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) scopes.push(p.parent.name.getText());
  }
  return scopes.reverse().join('>') || '<module>';
}
export function requestCwdInventory() {
  const rows: Array<{id:string;file:string;scope:string;line:number;requestType:string;tool:string;approvalScope:string;source:string;cwdProperties:string[]}> = [];
  for (const file of sources(root).sort()) {
    const parsed = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    let ordinal = 0;
    function visit(node: ts.Node) {
      if (ts.isObjectLiteralExpression(node)) {
        const props = node.properties;
        const value = (key:string) => props.find(p => ts.isPropertyAssignment(p) && p.name.getText(parsed).replace(/['"]/g,'') === key) as ts.PropertyAssignment | undefined;
        if (value('type')?.initializer.getText(parsed).replace(/['"]/g,'') === 'request.opened') {
          const execution = value('executionCwd'), env = value('execEnv') || props.find(p => ts.isShorthandPropertyAssignment(p) && p.name.text === 'execEnv');
          const optional = props.filter(ts.isSpreadAssignment).find(p => /execEnv\s*\?/.test(p.expression.getText(parsed)));
          const toolCall = value('toolCall')?.initializer.getText(parsed) ?? '';
          // An identifier/conditional input cannot prove cwd on every path.
          const directInput = /input\s*:\s*\{[^}]*\bcwd\s*[:,}]/s.test(toolCall);
          const name = relative(root,file).replaceAll('\\','/');
          const cwdProperties = [execution, env, optional].filter((p):p is ts.ObjectLiteralElementLike => !!p).map(p=>p.getText(parsed));
          rows.push({id:`${name}#${++ordinal}`,file:name,scope:scopeOf(node),line:parsed.getLineAndCharacterOfPosition(node.getStart()).line+1,requestType:value('requestType')?.initializer.getText(parsed) ?? 'unknown',tool:value('tool')?.initializer.getText(parsed)??'',approvalScope:value('approvalScope')?.initializer.getText(parsed)??'',source:execution?'executionCwd':env?'execEnv':optional?'execEnv?':directInput?'input.cwd':'none',cwdProperties});
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(parsed);
  }
  return rows;
}
// Evaluate only the actual emitted cwd fields. All other tool/protocol fields
// are supplied by a fake request. execEnv=undefined exercises the fallback
// seam, without claiming a provider normally omits its handed environment.
export function emittedCwd(id:string, cwd:string): Record<string,unknown> {
  const row=requestCwdInventory().find(row=>row.id===id);
  if(!row)throw Error(`unknown emit site ${id}`);
  const js=ts.transpile(`const value={${row.cwdProperties.join(',')}};`, {target:ts.ScriptTarget.ES2022});
  return new Function('cwd','state','turn','execEnv',`${js};return value;`)(cwd,{cwd},{cwd},undefined);
}
