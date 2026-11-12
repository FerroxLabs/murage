// Enumerate syntax over BOTH entire trees, including tests (explicitly marked).
// The checked inventory is generated, never a hand-maintained file allowlist.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] ?? '.');
const output = process.argv[3];
const files = [];
function scan(dir) {
  for (const item of readdirSync(resolve(root,dir), { withFileTypes: true })) {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) scan(path);
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(path)) files.push(path);
  }
}
scan('server'); scan('shared'); files.sort();
const sources = new Map(files.map(file => [file, ts.createSourceFile(file, readFileSync(resolve(root,file),'utf8'), ts.ScriptTarget.Latest, true)]));
const types = new Map();
for (const source of sources.values()) {
  function collect(node) {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) types.set(node.name.text,node);
    ts.forEachChild(node,collect);
  }
  collect(source);
}
function permissionType(node, seen = new Set()) {
  if (!node) return false;
  if (ts.isPropertySignature(node)) {
    const name=node.name.getText().replace(/["']/g,'');
    if (name==='approve') return true;
    if (['ask','approved','allow'].includes(name) && /boolean|true|false/.test(node.type?.getText()??'')) return true;
    if (['verdict','behavior','decision','route','outcome'].includes(name) && /["'](?:run|allow|approve)["']/.test(node.type?.getText()??'')) return true;
    return false;
  }
  if (ts.isLiteralTypeNode(node)) return ts.isStringLiteral(node.literal) && ['run','allow','approve'].includes(node.literal.text);
  if (ts.isTypeReferenceNode(node)) {
    const name=node.typeName.getText();
    if (seen.has(name)) return false;
    seen=new Set(seen).add(name);
    if (permissionType(types.get(name),seen)) return true;
  }
  let result=false;
  ts.forEachChild(node,child=>{ if(permissionType(child,seen)) result=true; });
  return result;
}
const rows=[], functions=[], typedReturns=[], errors=[];
const hash = text => createHash("sha256").update(text).digest("hex");
const candidateProducers = new Set(['standingGrant','appSetGrant','verdictWithGrants']);
const nameOf = node => node.name?.getText() ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : '<anonymous>');
for (const file of files) {
  const source = sources.get(file);
  const test = /(?:\.test\.|\/testing\/)/.test(file);
  function visit(node, fn) {
    if (ts.isFunctionLike(node) && node.body) {
      fn={ file, name:nameOf(node), node, calls:new Set(), exported: !!node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword), test };
      functions.push(fn);
    }
    if (ts.isCallExpression(node) && fn) fn.calls.add(node.expression.getText(source));
    if ((ts.isReturnStatement(node) || ts.isYieldExpression(node)) && fn && permissionType(fn.node.type)) {
      typedReturns.push({file,function:fn.name,test,line:source.getLineAndCharacterOfPosition(node.getStart()).line+1,
        type:fn.node.type.getText(source), expression:node.expression?.getText(source) ?? '', function_sha256:hash(fn.node.getText(source))});
    }
    if (ts.isObjectLiteralExpression(node)) {
      const props=new Map(node.properties.filter(p=>ts.isPropertyAssignment(p)||ts.isShorthandPropertyAssignment(p)).map(p=>[p.name.getText(source).replaceAll('"','').replaceAll("'",''),ts.isPropertyAssignment(p)?p.initializer:p.name]));
      for (const key of ['approve','approved','ask','allow','verdict','behavior','decision','route','outcome']) {
        const value=props.get(key); if (!value) continue;
        const text=value.getText(source);
        if (['ask','approved','allow'].includes(key) && text !== (key === 'ask' ? 'false' : 'true')) continue;
        if (!['approve','ask','approved','allow'].includes(key) && !['"run"',"'run'",'"allow"',"'allow'",'"approve"',"'approve'"].includes(text) && !/run|allow|approve/.test(text)) continue;
        const line=source.getLineAndCharacterOfPosition(value.getStart()).line+1;
        const sourceName=props.get('source')?.getText(source);
        const returned = ts.isReturnStatement(node.parent) || ts.isYieldExpression(node.parent) || ts.isArrowFunction(node.parent);
        rows.push({file,line,function:fn?.name??'<module>',key,value:text,test,source:sourceName,returned,function_sha256:fn ? hash(fn.node.getText(source)) : undefined});
        if (!test && ['ask','approved','allow'].includes(key) && !(file === 'server/drivers/pi.ts' && fn?.node.getText(source).includes('decision.behavior === "allow"'))) errors.push(`${file}:${line}: direct permission marker outside finalDecision`);
        // Approval objects may be produced only by the private policy candidates
        // or the gate. New constructors in any other source fail this audit.
        if (!test && key==='approve' && text!=='null' && !ts.isArrayLiteralExpression(value) &&
            !(file==='server/auto-approve.ts' && (candidateProducers.has(fn?.name) || fn?.name==='finalizeNoLimits' && text==='decision.approve')) && !(file==='shared/no-limits-decision.ts'&&fn?.name==='finalDecision'))
          errors.push(`${file}:${line}: producer approving directly`);
        // Any direct No limits producer approval anywhere in the trees fails.
        if (!test && sourceName?.replace(/["']/g,'')==='no-limits' && key==='approve' && text!=='null') {
          if (!candidateProducers.has(fn?.name) && (fn?.name!=='finalizeNoLimits' || file!=='server/auto-approve.ts' || text!=='decision.approve')) errors.push(`${file}:${line}: producer approving directly`);
        }
        // Reader 'run' construction belongs exclusively to finalDecision.
        if (!test && key==='verdict' && /["']run["']/.test(text) && /(?:no-limits|code-lexer|app-action-grant)/.test(file) && fn?.name!=='finalDecision') errors.push(`${file}:${line}: run outside finalDecision`);
      }
    }
    ts.forEachChild(node, child=>visit(child,fn));
  }
  visit(source);
}
const find=(file,name)=>functions.find(f=>f.file===file&&f.name===name&&!f.test);
const required=[
 ['server/auto-approve.ts','standingGrant','appSetGrant'],
 ['server/index.ts','imageAutoApproval','finalDecision'],
 ['server/index.ts','imageAutoApproval','decideImageApproval'],
 ['server/auto-approve.ts','verdictWithGrants','standingGrant'],
 ['server/auto-approve.ts','verdictPastAlwaysAsk','verdictWithGrants'],
 ['server/auto-approve.ts','autoVerdictOf','verdictPastAlwaysAsk'],
 ['server/auto-approve.ts','autoVerdict','autoVerdictOf'],
 ['server/auto-approve.ts','autoVerdict','finalizeNoLimits'],
 ['server/auto-approve.ts','finalizeNoLimits','finalDecision'],
 ['server/command-folder.ts','commandFolderVerdict','finalizeNoLimits'],
 ['server/no-limits-code.ts','judge','finalDecision'],
 ['server/routine-permissions.ts','routineTurnApproval','autoVerdict'],
];
// Discover callers rather than relying on a count of known sites. Imports are
// simple identifier calls for these public permission entry points.
const gates=new Set(['finalDecision','finalizeNoLimits','autoVerdict','judge','commandFolderVerdict']);
const callers=functions.filter(f=>!f.test && [...f.calls].some(c=>gates.has(c) && (c !== 'judge' || f.file === 'server/no-limits-code.ts'))).map(f=>({file:f.file,function:f.name,calls:[...f.calls].filter(c=>gates.has(c)).sort()}));
for (const [file,name,call] of required) {
  const fn=find(file,name);
  if (!fn?.calls.has(call)) errors.push(`${file} ${name}: missing gate edge ${call}`);
}
const entry=find('server/auto-approve.ts','autoVerdict');
if (entry) {
  const body=entry.node.body.getText();
  if (/verdict\.approve\s*!==?\s*null/.test(body)) errors.push('autoVerdict skips existing allows');
  if (!body.includes('reads.push(cutRead("producer-exception"))')) errors.push('exception observation lost');
}
const finalizer=find('server/auto-approve.ts','finalizeNoLimits');
if (finalizer && /if\s*\(verdict\.approve/.test(finalizer.node.body.getText().split("const decision = finalDecision")[0])) errors.push('finalizer skips approval candidates');
const producer=find('server/auto-approve.ts','autoVerdictOf');
if (!producer || producer.exported) errors.push('policy candidate producer must stay private');
const producerCallers=functions.filter(f=>!f.test&&f.calls.has('autoVerdictOf'));
if (producerCallers.length!==1 || producerCallers[0].name!=='autoVerdict') errors.push('policy candidate escapes the gated entry');
// Private policy constructors are candidates; every caller must remain inside
// the policy module, and its sole exported permission entry is autoVerdict.
for (const name of ['standingGrant','appSetGrant','verdictWithGrants','verdictPastAlwaysAsk']) {
  const fn=find('server/auto-approve.ts',name);
  if (!fn || fn.exported) errors.push(`${name}: candidate producer exported`);
  for (const caller of functions.filter(f=>!f.test&&f.calls.has(name)))
    if(caller.file!=='server/auto-approve.ts') errors.push(`${name}: ungated caller ${caller.file}`);
}
// Driver shortcuts are not No limits producers: the stored turn routes them to
// the broker. Assert their exclusion and the propagation that makes it effective.
const routingChecks=[
 ['server/routine-permissions.ts','mode === "unlimited" ? { stopLine: true, noLimits: true }'],
 ['server/drivers/claude.ts','turn.noLimits !== true && ask.kind === "permission" && claudeInProjectAllow'],
 ['server/drivers/acp/core.ts','turn.noLimits !== true && ownedMemoryAlias'],
 ['server/drivers/acp/core.ts','(turn.stopLine || turn.routeAsks) && config.fullAuto ? { ...config, fullAuto: false } : config'],
 ['server/drivers/codex.ts','const enforceApproval = turn.stopLine === true || (turn.routeAsks === true && config.fullAuto);'],
 ['server/drivers/codex.ts','const autoAccept = config.fullAuto && !enforceApproval;'],
 ['server/drivers/codex.ts','noLimits: turn.noLimits'],
 ['server/drivers/codex-hook.ts','if (ctx.noLimits === true) return { route: "ask"'],
 ['server/index.ts','if (args.asker.noLimits === true) return false;'],
];
for(const [file,guard] of routingChecks) if(!readFileSync(resolve(root,file),'utf8').includes(guard)) errors.push(`${file}: No limits shortcut bypass`);
// Every enumerated production constructor is reviewed, including transports,
// audit records and unrelated values whose names resemble permission markers.
// The ledger pins exact constructors and multiplicity; a newly added direct
// approval cannot hide behind a selected call-edge list or a whole-file exemption.
const typedLedger = JSON.parse(readFileSync(resolve(root,'scripts/toolid-typed-returns.json'),'utf8'));
const ledgerFile = resolve(root, 'scripts/toolid-approval-sites.json');
let ledger = [];
try { ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')); } catch { errors.push('missing per-site approval review'); }
const signature = row => JSON.stringify([row.file,row.function,row.key,row.value,row.source ?? null]);
const counts = new Map();
for (const row of rows.filter(row => !row.test)) {
  const key=signature(row); counts.set(key,(counts.get(key)??0)+1);
  const review=ledger.find(entry=>entry.signature===key);
  row.review=review?.reason;
  if (!review) errors.push(`${row.file}:${row.line}: unreviewed permission constructor`);
}
for (const review of ledger) if (counts.get(review.signature)!==review.count) errors.push('reviewed constructor multiplicity changed: '+review.signature);
// Typed returns that do not construct an object are enumerated as well. Each
// function must either reach the gate/candidate closure or have a reviewed
// constructor describing its protocol/denial-only role.
for (const row of typedReturns.filter(row=>!row.test)) {
  const fn=find(row.file,row.function);
  const direct=rows.some(site=>!site.test&&site.file===row.file&&site.function===row.function&&site.review);
  const gated=fn && [...fn.calls].some(call=>gates.has(call)||candidateProducers.has(call));
  const review=typedLedger.find(entry=>entry.file===row.file&&entry.function===row.function&&entry.type===row.type&&entry.function_sha256===row.function_sha256);
  row.review=gated ? 'gate or private policy candidate call' : direct ? 'reviewed typed producer; see constructor sites' : review?.reason;
  if (!row.review) errors.push(`${row.file}:${row.line}: unreviewed typed permission return`);
}
for (const entry of typedLedger) {
  const count=typedReturns.filter(row=>!row.test&&entry.file===row.file&&entry.function===row.function&&entry.type===row.type&&entry.function_sha256===row.function_sha256).length;
  if(count!==entry.count) errors.push(`${entry.file} ${entry.function}: reviewed typed-return body changed`);
}
const report={files:files.length,inventory_count:rows.length,production_sites:rows.filter(r=>!r.test).length,caller_count:callers.length,gate_edges:required,routing_checks:routingChecks,callers,sites:rows,typed_returns:typedReturns,errors};
if(output) writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({files:report.files,inventory_count:rows.length,production_sites:report.production_sites,caller_count:callers.length,errors}));
assert.deepEqual(errors,[],'approval inventory must go through finalDecision');
