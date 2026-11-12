// SPDX-License-Identifier: AGPL-3.0-or-later
// This inventories approval vocabulary AND dynamic transport call sites. A new
// sender requires an explicit inventory/runtime-test update. It is not proof
// that an existing sender received an exact operation; runtime REDs prove that.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root=dirname(fileURLToPath(import.meta.url));
function sources(dir:string):string[]{
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const file=join(dir,entry.name);
    if(entry.isDirectory())return entry.name==='testing'?[]:sources(file);
    return entry.name.endsWith('.ts')&&!/\.(?:test|config|d)\.ts$/.test(entry.name)?[file]:[];
  });
}
const permissionWords=new Set(['allow','accept','approved','allow_once','allow_always','confirmed','approval/decide']);
// Include dynamic frame variables, not only object literals containing allow.
// Non-permission protocol sends remain in the snapshot as classified context.
const transportNames=new Set(['deliverNative','deliverApproval','send','write','sendPermission','resolveAnswer','resolveAsk','respondNow','executeService','executeServiceSync','ownedCommand','callTool','guardRelease','guardEngineRelease','reopenAfterDelivery']);
function scopeOf(node:ts.Node):string{
  const scopes:string[]=[];
  for(let parent:ts.Node|undefined=node.parent;parent;parent=parent.parent){
    if(ts.isFunctionDeclaration(parent)&&parent.name)scopes.push(parent.name.text);
    else if(ts.isMethodDeclaration(parent))scopes.push(parent.name.getText());
    else if((ts.isFunctionExpression(parent)||ts.isArrowFunction(parent))&&ts.isVariableDeclaration(parent.parent))scopes.push(parent.parent.name.getText());
    else if((ts.isFunctionExpression(parent)||ts.isArrowFunction(parent))&&ts.isPropertyAssignment(parent.parent))scopes.push(parent.parent.name.getText());
  }
  return scopes.reverse().join('>')||'<module>';
}
function inventory(){
  const result:Record<string,string[]>={};
  const serviceFiles=['decision/implementation.ts','narrow-denials.ts','memory/service-approval.ts','memory/authority.ts','index.ts'].map(file=>join(root,'..',file));
  for(const file of [...sources(root),...serviceFiles].sort()){
    const parsed=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    const rows:string[]=[];
    const visit=(node:ts.Node)=>{
      if(relative(root,file)==='../index.ts'&&!/deliverAnswer|answerRegisteredApproval/.test(scopeOf(node))&&!ts.isSourceFile(node)){ts.forEachChild(node,visit);return;}
      if(ts.isStringLiteral(node)&&permissionWords.has(node.text)&&!ts.isLiteralTypeNode(node.parent)){
        rows.push(`${scopeOf(node)} :: ${node.parent.getText(parsed).replace(/\s+/g,' ')}`);
      }else if(ts.isCallExpression(node)){
        const name=ts.isIdentifier(node.expression)?node.expression.text:ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:'';
        const genericTransport=['native-ask.ts','answer-delivery.ts','request-delivery.ts','request-transport.ts'].includes(relative(root,file));
        const deferredWrite=genericTransport&&name==='then'&&node.arguments.some(arg=>ts.isIdentifier(arg)&&['write','send'].includes(arg.text));
        if(transportNames.has(name)||deferredWrite||genericTransport&&['write','send','original','check','onRearmReady','onReopenReady','onReopen'].includes(name)||serviceFiles.includes(file)&&['execute','respond','accept'].includes(name))rows.push(`${scopeOf(node)} :: ${node.expression.getText(parsed)}(${node.arguments.map(a=>ts.isArrowFunction(a)||ts.isFunctionExpression(a)?'<callback>':a.getText(parsed).replace(/\s+/g,' ')).join(', ')})`);
      }
      ts.forEachChild(node,visit);
    };
    visit(parsed);
    if(rows.length)result[relative(root,file).replaceAll('\\','/')]=rows;
  }
  return result;
}
it('R10h complete provider allow/frame/transport structure is inventoried',()=>{
  expect(inventory()).toMatchSnapshot();
});
it('R10h inventories the discovered ACP/chat senders and generic delivery wrappers',()=>{
  const entries=inventory();
  for(const file of ['codex.ts','claude.ts','pi.ts','antigravity.ts','muse-code.ts','acp/core.ts','openai-chat.ts','native-ask.ts','answer-delivery.ts','request-delivery.ts','request-transport.ts','../index.ts','../decision/implementation.ts','../narrow-denials.ts','../memory/service-approval.ts','../memory/authority.ts'])expect(entries[file],file).toBeDefined();
});

it('C2 handoff explicitly inventories the refreshed-card English string',()=>{
  const handoff=readFileSync(join(root,'../../docs/verification/no-limits-release/INVENTORY.md'),'utf8');
  expect(handoff).toContain('| Permission changed before release |');
});
