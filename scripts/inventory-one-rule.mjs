// SPDX-License-Identifier: AGPL-3.0-or-later
// Conservative AST inventory: a permission presentation/wait needs an earlier
// gate in its lexical execution scope. Unknown sites fail rather than being
// exempted by file name. Transport requests and ordinary input questions are
// listed separately; they are not authority to render a permission card.
import ts from 'typescript';
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
const gateNames=new Set(['finalDecision','approvalDecision','finalizeNoLimits','autoVerdict','routineTurnApproval','commandFolderVerdict','noLimitsSend','applyRequestedMemory']);
export function inventory(root) {
 const sites=[],errors=[],functions=[];
 const walkFiles=(dir)=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walkFiles(resolve(dir,e.name)):/\.(ts|tsx|mjs|js)$/.test(e.name)&&!/(?:\.test\.|\.spec\.)/.test(e.name)?[resolve(dir,e.name)]:[]);
 const files=['server','shared'].flatMap(dir=>walkFiles(resolve(root,dir))).filter(file=>!file.includes('/testing/'));
 for(const file of files) {
  const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  const name=node=>node.name?.getText(source)??(ts.isVariableDeclaration(node.parent)?node.parent.name.getText(source):'<callback>');
  const local=[],declarations=[];
  function expanded(node,scope,seen=new Set()) {
   let result=node.getText(source);
   if(seen.size>256)return result;
   function references(part) {
    if(ts.isIdentifier(part)&&!seen.has(part.text)) {
     const scopes=new Set();for(let current=scope;current;current=current.parent)scopes.add(current);
     const declaration=declarations.findLast(d=>d.name===part.text&&(!d.scope||scopes.has(d.scope))&&d.node.getStart()<node.getStart());
     if(declaration?.node.initializer) {seen.add(part.text);result+=' '+expanded(declaration.node.initializer,scope,seen);}
    }
    ts.forEachChild(part,references);
   }
   references(node);return result;
  }
  function visit(node,scope) {
   if(ts.isFunctionLike(node)&&node.body) {scope={node,name:name(node),parent:scope,calls:[],file:relative(root,file)};local.push(scope);functions.push(scope);}
   if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name))declarations.push({name:node.name.text,node,scope});
   if(ts.isCallExpression(node)&&scope)scope.calls.push(node);
   if(ts.isNewExpression(node)&&node.expression.getText(source)==='Promise'&&node.typeArguments?.some(t=>/^(?:ApprovalState|PeerApprovalOutcome|HostConsentOutcome|BotOutcome)$/.test(t.getText(source))))sites.push({file:relative(root,file),line:source.getLineAndCharacterOfPosition(node.getStart()).line+1,kind:'wait',callee:'new Promise<approval>',node,scope});
   if(ts.isCallExpression(node)) {
    const callee=node.expression.getText(source);
    const append=/\b(?:appendMessage|pushMessage|appendCard)$/.test(callee);
    const rawArgs=node.arguments.map(arg=>arg.getText(source)).join(',');
    const statusLine=/\bkind\s*:\s*["'](?:activity|text)["']/.test(rawArgs);
    const args=node.arguments.map(arg=>append&&!statusLine?expanded(arg,scope):arg.getText(source)).join(',');
    const informational=/\blimitOfferCard\s*\(|\banswerAsSend\s*:\s*true|\bintakeGeneralCard\s*\(/.test(args); // missing engine capacity: selection/input, not permission
    const card=append && !informational && (/\bkind\s*:\s*["']options["']/.test(args) && /requestId|\btool\s*:|mcpEnableCard|browserSetup/.test(args) || /appendCard$/.test(callee));
    const wait=/\.(?:waiting|opened)$/.test(callee)&&(/\btrue\b/.test(args)||/routineCard/.test(callee));
    const queue=/\b(?:holdMemoryCandidate|holdVenuePost)\b/.test(callee)
      || /\.move$/.test(callee)&&/state\s*:\s*["']awaiting_owner["']/.test(args)
      || /\.patchBot$/.test(callee)&&/connectedAppAccess/.test(args)&&/requests\s*:\s*\[\.\.\./.test(args)
      || /\.run$/.test(callee)&&/INSERT INTO room_shares/.test(callee);
    if(card||wait||queue)sites.push({file:relative(root,file),line:source.getLineAndCharacterOfPosition(node.getStart()).line+1,kind:card?'card':wait?'wait':'queue',callee,node,scope});
   }
   ts.forEachChild(node,child=>visit(child,scope));
  }
  visit(source);
 }
 const byName=new Map(),incoming=new Map();
 let functionId=0;
 for(const fn of functions) {
  const key=fn.file+':'+fn.name;
  byName.set(key,[...(byName.get(key)??[]),fn]);
  fn.id=functionId++;
  for(const call of fn.calls) {
   call.calleeName=call.expression.getText().replace(/^this\./,'');
   const called=fn.file+':'+call.calleeName;
   incoming.set(called,[...(incoming.get(called)??[]),{fn,call}]);
  }
 }
 const mayGate=new Set(functions.filter(fn=>fn.calls.some(call=>gateNames.has(call.calleeName))));
 for(let changed=true;changed;) {
  changed=false;
  for(const fn of functions)if(!mayGate.has(fn)&&fn.calls.some(call=>(byName.get(fn.file+':'+call.calleeName)??[]).some(callee=>mayGate.has(callee)))){mayGate.add(fn);changed=true;}
 }
 const proven=new Set();
 // Only local methods/functions are traversed. An arbitrary same-named method
 // in a different module cannot satisfy an edge.
 function executesBefore(call,before,scope) {
  const contains=node=>before>=node.getStart()&&before<=node.end;
  for(let child=call,parent=call.parent;parent&&parent!==scope.node;child=parent,parent=parent.parent) {
   if(ts.isIfStatement(parent)&&child!==parent.expression&&!contains(child))return false;
   if(ts.isConditionalExpression(parent)&&child!==parent.condition&&!contains(child))return false;
   if(ts.isBinaryExpression(parent)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)&&child===parent.right&&!contains(child))return false;
   if((ts.isForStatement(parent)||ts.isForOfStatement(parent)||ts.isForInStatement(parent)||ts.isWhileStatement(parent))&&child===parent.statement&&!contains(child))return false;
   if(ts.isTryStatement(parent)&&parent.catchClause&&child===parent.tryBlock&&!contains(child))return false;
  }
  return true;
 }
 function gated(scope,before,seen=new Set()) {
  if(!scope||seen.has(scope))return false;
  const proofKey=scope.id+':'+before;
  if(proven.has(proofKey))return true;
  const yes=()=>{proven.add(proofKey);return true;};
  seen=new Set(seen).add(scope);
  for(const call of scope.calls) {
   if(call.getStart()>=before||!executesBefore(call,before,scope))continue;
   const callee=call.calleeName;
   if(gateNames.has(callee))return yes();
   const candidates=byName.get(scope.file+':'+callee)??[];
   if(candidates.length===1&&mayGate.has(candidates[0])&&gated(candidates[0],Infinity,seen))return yes();
  }
  if(gated(scope.parent,scope.node.getStart(),seen))return yes();
  // Private helpers cannot originate execution. Every call site must carry
  // the gate, including the lexical parent of callback factories.
  if(scope.name === '<callback>' || scope.node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))return false;
  const callers=incoming.get(scope.file+':'+scope.name)??[];
  return callers.length>0 && callers.every(({fn,call})=>gated(fn,call.getStart(),seen)) ? yes() : false;
 }
 const rows=sites.map(site=>{
  const terminal=functions.filter(fn=>fn.name===site.callee && fn.name==='holdMemoryCandidate');
  const gate=gated(site.scope,site.node.getStart()) || terminal.length===1 && gated(terminal[0],Infinity);
  const row={file:site.file,line:site.line,function:site.scope?.name??'<module>',kind:site.kind,callee:site.callee,gated:gate};
  if(!gate)errors.push(`${row.file}:${row.line} ${row.function}: ungated ${row.kind}`);
  return row;
 });
 return {files:files.length,sites:rows,errors};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const report=inventory(resolve(process.argv[2]??'.'));
 if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({sites:report.sites.length,errors:report.errors}));
 if(report.errors.length)process.exitCode=1;
}
