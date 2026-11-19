#!/usr/bin/env node
// Owner: sc-safety (checker); the reviewing seat owns seam approvals and mutant relevance.
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const root = process.cwd();
const base = process.env.SC_PRESERVATION_BASE ?? '56a6de3569a51c4b4d7735d70e2899548e7f27ae';
const snapshot = process.env.SC_PRESERVATION_BASE64 ? JSON.parse(inflateSync(Buffer.from(process.env.SC_PRESERVATION_BASE64, 'base64'))) : undefined;
const baseDir = process.env.SC_PRESERVATION_BASE_DIR && resolve(process.env.SC_PRESERVATION_BASE_DIR);
const outside = path => relative(root, resolve(path)).startsWith('..') && !/^\/dev(?:\/|$)/.test(resolve(path));
if (baseDir && !outside(baseDir)) throw Error('Baseline must be outside the worktree and device tree');
function old(file) { if (snapshot) return snapshot[file] ?? null; if (baseDir) return existsSync(resolve(baseDir,file)) ? readFileSync(resolve(baseDir,file),'utf8') : null; try { return execFileSync('git',['show',`${base}:${file}`], {encoding:'utf8',maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']}); } catch { return null; } }
const current = file => existsSync(resolve(root,file)) ? readFileSync(resolve(root,file),'utf8') : null;
const hash = text => createHash('sha256').update(text).digest('hex');
const parse = (file,text) => ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child,visit)); };
const registration = node => ts.isCallExpression(node) && /^(?:it|test|describe)(?:\.|\(|$)/.test(node.expression.getText());
const title = node => node.arguments[0] && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) ? node.arguments[0].text : null;
function inventory(source) {
 const cases = new Map(), registrations = [];
 function visit(node, parents=[]) {
  if (registration(node) && title(node)!==null) {
   const id = [...parents,title(node)].join(' > '), callback = node.arguments.find(a => ts.isArrowFunction(a)||ts.isFunctionExpression(a));
   registrations.push({id,node});
   if (!/^describe\b/.test(node.expression.getText())) {
    const assertions=[];
    if(callback) walk(callback,n=> { if (ts.isExpressionStatement(n) && /^(?:await\s+)?(?:expect(?:\b|\.)|assert\w*\b)/.test(n.getText())) assertions.push(n.getText()); });
    if (cases.has(id)) throw Error(`Ambiguous test ID ${id}`);
    cases.set(id,{assertions,node});
   }
   for(const child of node.arguments) visit(child, callback===child ? [...parents,title(node)] : parents);
   return;
  }
  ts.forEachChild(node,child=>visit(child,parents));
 }
 visit(source); return {cases,registrations};
}
const initial = ['server/internal-response-fence.test.ts','server/memory/learning-send-boundary.test.ts','server/nl-win-1018.test.ts','server/drivers/codex-warm.test.ts','server/ledger-refusal-server.test.ts','server/drivers/acp/r2-hermes.test.ts'];
const files=new Set(initial), queue=[...files];
while(queue.length) {
 const file=queue.shift();
 for(const text of [old(file),current(file)]) if(text) walk(parse(file,text),node=> {
  const name = ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ts.isCallExpression(node) && node.expression.kind===ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : null;
  if(name?.startsWith('.')) { const next=relative(root,resolve(root,dirname(file),name)); if(next.startsWith('server/testing/') && !files.has(next)) {files.add(next);queue.push(next);} }
 });
}
for(const file of JSON.parse(process.env.SC_PRESERVATION_FILES_JSON??'[]')) files.add(file);
let manifest={seams:[]};
if(existsSync(resolve(root,'server/testing/seams.json'))) manifest=JSON.parse(readFileSync(resolve(root,'server/testing/seams.json'),'utf8'));
const reviews=JSON.parse(process.env.SC_CONTINUITY_REVIEW??'{}');
// The reviewing seat authors this external TSV. Reading it never creates or
// upgrades an approval; exact commit hashes bind approved added modules.
const fixtureReviewFile=process.env.SC_FIXTURE_REVIEW_FILE;
let fixtureReviews=[];
if(fixtureReviewFile) {
 if(!outside(fixtureReviewFile))throw Error('Fixture review must be outside the worktree and device tree');
 const lines=readFileSync(resolve(fixtureReviewFile),'utf8').trimEnd().split(/\r?\n/),header=lines.shift()?.split('\t');
 if(JSON.stringify(header)!==JSON.stringify(['module','verdict','reviewer','commit','reason']))throw Error('Invalid independent fixture review header');
 fixtureReviews=lines.map(line=>Object.fromEntries(header.map((name,index)=>[name,line.split('\t')[index]??''])));
 if(fixtureReviews.some(row=>!['APPROVE','REJECT'].includes(row.verdict)||!row.reviewer||row.reviewer===(process.env.SC_BUILDER??'sc-safety')||!/^[a-f0-9]{40}$/.test(row.commit)))throw Error('Invalid independent fixture review row');
}
const fixtureReviewHashes=JSON.parse(process.env.SC_FIXTURE_REVIEW_HASHES_JSON??'{}');
const approvedModule=file=>fixtureReviews.some(row=>row.module===file&&row.verdict==='APPROVE'&&fixtureReviewHashes[`${row.commit}:${file}`]===hash(current(file)??''));
const seams=manifest.seams??[];
if(seams.some(seam=>!seam.file?.startsWith('server/')||!seam.function||!seam.baselineSha256))throw Error('Invalid enumerated baseline seam');
const report={fixtureReview:fixtureReviews,base,rule:'MAIN D1: raw ordered per-ID assertions and all existing content outside approved baseline seams',pass:true,restored:false,files:[]};
for(const file of [...files].sort()) {
 const before=old(file),after=current(file), problems=[];
 for(const row of fixtureReviews)if(row.module.replace(/ \(new fixture seams\)$/,'')===file&&row.verdict==='REJECT')problems.push(`independent fixture review REJECT: ${row.reviewer} at ${row.commit}`);
 if(after===null){problems.push('file missing');report.pass=false;report.files.push({file,problems});continue;}
 if(before===null){
  if(file.startsWith('server/testing/')&&!/\.test\.[cm]?[jt]sx?$/.test(file)) {
   const approval=(reviews.hunks??[]).find(row=>row.file===file&&row.function==='<module>'&&row.before===null&&row.after===hash(after));
   if((!approval?.reviewer||approval.reviewer===(process.env.SC_BUILDER??'sc-safety'))&&!approvedModule(file))problems.push('independent review missing for added fixture module');
  }
  if(problems.length)report.pass=false;
  report.files.push({file,added:true,problems});continue;
 }
 const a=parse(file,before),b=parse(file,after),ia=inventory(a),ib=inventory(b),left=[],right=[];
 for(const entry of ib.registrations) {
  const original=ia.registrations.find(old=>old.id===entry.id);
  const callee=entry.node.expression.getText();
  if (/\.(?:skip|todo|only|skipIf|runIf|concurrent)(?:\b|\()/.test(callee) && (!original || original.node.expression.getText()!==callee)) problems.push(`nonexecution modifier added: ${entry.id}`);
  if (entry.node.arguments.some(arg=>ts.isObjectLiteralExpression(arg)&&arg.properties.some(prop=>prop.name?.getText()==='retry'))) problems.push(`retry added: ${entry.id}`);
 }

 for(const [id,entry] of ia.cases) {
  const other=ib.cases.get(id);
  if(!other)problems.push(`test missing: ${id}`);
  else if(JSON.stringify(entry.assertions)!==JSON.stringify(other.assertions))problems.push(`ordered assertion bytes changed: ${id}`);
 }
 // Additive tests are allowed, but cannot wrap, replace or disable an existing registration.
 for(const entry of ib.registrations) if(!ia.registrations.some(old=>old.id===entry.id)) {
  for(let parent=entry.node.parent;parent;parent=parent.parent) {
   const registration=ib.registrations.find(candidate=>candidate.node===parent);
   if(registration&&ia.cases.has(registration.id))problems.push(`registration inserted inside frozen case: ${registration.id}`);
  }
  const statement=entry.node.parent;
  if(!ts.isExpressionStatement(statement)||!ts.isBlock(statement.parent)&&!ts.isSourceFile(statement.parent))problems.push(`unsafe added registration: ${entry.id}`);
  else right.push([statement.getFullStart(),statement.getEnd(),'']);
 }
 const fileSeams=seams.filter(seam=>seam.file===file);
 for(const seam of fileSeams) {
  const find=source=>{const nodes=[];walk(source,n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text===seam.function&&n.body)nodes.push(n.body);});return nodes;};
  const aa=find(a),bb=find(b);
  if(aa.length!==1||bb.length!==1){problems.push(`invalid baseline seam: ${seam.function}`);continue;}
  const x=aa[0],y=bb[0],xText=x.getText(a),yText=y.getText(b);
  if(hash(xText)!==seam.baselineSha256){problems.push(`baseline seam hash changed: ${seam.function}`);continue;}
  const hasAssertion=node=>{let found=false;walk(node,n=>{if(ts.isCallExpression(n)&&/^(?:expect(?:\b|\.)|assert\w*\b)/.test(n.expression.getText()))found=true;});return found;};
  if(hasAssertion(x)||hasAssertion(y)){problems.push(`assertion inside seam: ${seam.function}`);continue;}
  if(xText!==yText) {
   const approval=(reviews.hunks??[]).find(row=>row.file===file&&row.function===seam.function&&row.before===hash(xText)&&row.after===hash(yText));
   if(!approval?.reviewer||approval.reviewer===(process.env.SC_BUILDER??'sc-safety'))problems.push(`independent seam review missing: ${seam.function}`);
   const affected=approval?.cases??[];
   if(!affected.length)problems.push(`affected case mapping missing: ${seam.function}`);
   for(const id of affected) {
    if(!ib.cases.has(id))problems.push(`review names a missing affected case: ${id}`);
    const receipt=(reviews.mutants??[]).find(m=>m.case===id&&m.matches===1&&/^[a-f0-9]{64}$/.test(m.beforeHash??'')&&/^[a-f0-9]{64}$/.test(m.afterHash??'')&&m.beforeHash!==m.afterHash&&m.control==='PASS'&&m.result==='ASSERTION_RED'&&m.productFile?.startsWith('server/')&&!m.productFile.includes('/testing/')&&m.productFile===approval.productPath&&m.relevance&&m.reviewer===approval.reviewer);
    if(!receipt)problems.push(`relevant activated mutant missing: ${id}`);
   }
  }
  left.push([x.getStart(a),x.getEnd(),`{ /* seam:${seam.function} */ }`]);right.push([y.getStart(b),y.getEnd(),`{ /* seam:${seam.function} */ }`]);
 }
 const mask=(text,spans)=>{
  const disjoint=[];
  for(const span of spans.sort((a,b)=>a[0]-b[0]||b[1]-a[1])) {
   const prior=disjoint.at(-1);
   if(prior&&span[0]<prior[1]) {
    // A newly added suite contains its newly added cases. Remove that one
    // outer registration, while retaining every existing registration's ID.
    if(span[1]<=prior[1]&&span[2]===''&&prior[2]==='')continue;
    problems.push('overlapping baseline seam or registration');continue;
   }
   disjoint.push(span);
  }
  for(const [start,stop,replacement]of disjoint.reverse())text=text.slice(0,start)+replacement+text.slice(stop);
  return text;
 };
 if(mask(before,left)!==mask(after,right))problems.push('existing content changed outside independently approved seams (hooks, bindings, wrappers and case bodies frozen)');
 if(file==='server/drivers/codex-warm.test.ts') report.restored=[...ib.cases.keys()].some(id=>id.includes('a prewarm whose close is unconfirmed stays owned in the stuck registry'));
 if(problems.length)report.pass=false;
 report.files.push({file,problems});
}
if(!report.restored)report.pass=false;
// Retain the v1 cast budget in addition to the stronger continuity checks.
function testingFiles(directory,prefix='server/testing') {
 if(!existsSync(directory))return [];
 return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()
  ?testingFiles(resolve(directory,entry.name),`${prefix}/${entry.name}`)
  :entry.isFile()&&/\.[cm]?[jt]sx?$/.test(entry.name)?[`${prefix}/${entry.name}`]:[]);
}
const castCount=text=>(text?.match(/as\s+unknown\s+as/g)||[]).length;
let oldTesting;
if(baseDir)oldTesting=testingFiles(resolve(baseDir,'server/testing'));
else if(snapshot)oldTesting=Object.keys(snapshot).filter(file=>file.startsWith('server/testing/'));
else oldTesting=execFileSync('git',['ls-tree','-r','--name-only',base,'--','server/testing'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
report.casts={before:initial.reduce((n,file)=>n+castCount(old(file)),0),after:initial.reduce((n,file)=>n+castCount(current(file)),0)};
report.allTestingCasts={before:oldTesting.reduce((n,file)=>n+castCount(old(file)),0),after:testingFiles(resolve(root,'server/testing')).reduce((n,file)=>n+castCount(current(file)),0)};
if(report.casts.after>report.casts.before||report.allTestingCasts.after>report.allTestingCasts.before)report.pass=false;

const json=JSON.stringify(report,null,2)+'\n';
const output=process.argv.indexOf('--output');
if(output>=0){const path=process.argv[output+1];if(!path||!outside(path))throw Error('Evidence must be outside the worktree and device tree');writeFileSync(resolve(path),json);}else process.stdout.write(json);
process.exitCode=report.pass?0:1;
