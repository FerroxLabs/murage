// SPDX-License-Identifier: AGPL-3.0-or-later
// Run in an isolated container: each mutation restores its original source even when the test fails.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const evidence=process.env.MURAGE_MUTANT_EVIDENCE??'.gnl-browser-evidence/r3';mkdirSync(evidence,{recursive:true});
const mutations=[
 ['R1','server/browser-extension-service.ts','approvedOrigins, noLimits, appProtocol','approvedOrigins, appProtocol'],
 ['R2-fields','extensions/murage-browser/runtime.mjs','if (noLimits) {','if (false && noLimits) {'],
 ['R2-frames','extensions/murage-browser/runtime.mjs','if (shot && req.params.noLimits !== true) await frameMask(t, false);','if (shot) await frameMask(t, false);'],
 ['R3-credentials','server/browser-extension-service.ts',"info.result.unsure || info.result.floor !== 'verification' ? info.result.rule", "!info.result.unsure && info.result.floor !== 'verification' && !['field-autocomplete','field-name','dialog-credentials','submit-credentials-form'].includes(info.result.rule) ? info.result.rule"],
 ['R3-checker','server/browser-extension-service.ts',"entry.handoffRule='checker'",'entry.handoffRule=undefined'],
 ['R4','server/browser-extension-executor.ts','if(!this.options.noLimits?.()&&summary.length>MAX_REVIEW_CHARS)','if(summary.length>MAX_REVIEW_CHARS)'],
 ['R5','server/browser-extension-executor.ts','if(!this.options.noLimits?.()&&privHref&&shownUrl!==undefined','if(privHref&&shownUrl!==undefined'],
 ['R6','server/browser-extension-service.ts','while (transient.size >= MAX_STORED_GRANTS)','while (false && transient.size >= MAX_STORED_GRANTS)'],
 ['R7','server/permission-inheritance.ts','if (setting !== true && !(setting.autoApprove === true && setting.fullAccess === true && setting.noLimits === true)) return value;',''],
 ['F1','server/browser-extension-service.ts','await bind(entry);await persist();return;','await persist();return;'],
 ['F2','server/browser-extension-service.ts','noLimits:()=>serviceOwnerNoLimits(options.authorityFor?.(entry.context)),','noLimits:()=>false,'],
 ['F2-outside','server/browser-extension-service.ts',"!serviceOwnerNoLimits(options.authorityFor?.(entry.context))&&method==='Page.navigate'&&entry.exemptOpen","method==='Page.navigate'&&entry.exemptOpen"],
 ['F2-handoff','server/browser-extension-service.ts',"const resumeNoLimitsHandoff = async (entry: Entry) => {\n    if (","const resumeNoLimitsHandoff = async (entry: Entry) => {\n    if (true || "],
 ['F3','server/browser-extension-service.ts',"if (serviceOwnerNoLimits(options.authorityFor?.(entry.context))) {\n      entry.sites[origin]", "if (false && serviceOwnerNoLimits(options.authorityFor?.(entry.context))) {\n      entry.sites[origin]"],
 ['F3-runtime','extensions/murage-browser/runtime.mjs',"req.params.noLimits !== true && ((b.bindEpoch ?? 0) !== bindEpoch || !b.approvedOrigins.includes(t.origin))","((b.bindEpoch ?? 0) !== bindEpoch || !b.approvedOrigins.includes(t.origin))"],
 ['F4','server/browser-extension-service.ts','if (serviceOwnerNoLimits(options.authorityFor?.(entry.context))) return;','if (false && serviceOwnerNoLimits(options.authorityFor?.(entry.context))) return;'],
 ['F5','server/browser-extension-service.ts','redactPageOutput(item.text, serviceOwnerNoLimits(options.authorityFor?.(entry.context)))','redactPageOutput(item.text)'],
 ['F2-executor','server/browser-extension-executor.ts','if(this.options.noLimits?.())return null;','if(false && this.options.noLimits?.())return null;'],
 ['F2-native','server/browser-control.ts','const before = !noLimits() && await native.protected();','const before = await native.protected();'],
 ['F2-clipboard','extensions/murage-browser/runtime.mjs',"if (req.params.noLimits !== true && isClipboardInput(method, params)) fail('clipboard_denied');","if (isClipboardInput(method, params)) fail('clipboard_denied');"],
 ['owner-takeover','server/browser-control.ts','if (e.held) throw browserRefusal("browser_held");','if (e.held && !noLimits()) throw browserRefusal("browser_held");'],
 ['owner-handoff','server/browser-extension-service.ts',"if (!entry.handoffRule || entry.state !== 'paused'","if (entry.state !== 'paused'"],
 ['capacity','server/browser-extension-service.ts',"if (access === 'allow' && entry.sites[origin] !== 'allow' && Object.values(entry.sites).filter(value => value === 'allow').length >= MAX_STORED_GRANTS)","if (false && access === 'allow' && entry.sites[origin] !== 'allow' && Object.values(entry.sites).filter(value => value === 'allow').length >= MAX_STORED_GRANTS)"],

 ["D1-policy", "server/browser-extension-policy.ts", "!(context && this.noLimits(context)) && ", "", "D1 No limits opens"],
 ["D1-runtime", "extensions/murage-browser/runtime.mjs", "!noLimits && categoryFor(url.hostname)", "categoryFor(url.hostname)", "D1 No limits opens"],
 ["D2-events", "extensions/murage-browser/cdp-events.mjs", "(!noLimits && params.frame.parentId)", "params.frame.parentId", "D2 engine facade"],
 ["D2-attach", "server/browser-extension-engine.ts", "if(!this.options.noLimits?.())return{};", "return{};", "D2 engine facade"],
 ["D3-unsure", "server/browser-extension-service.ts", "info.result.unsure || info.result.floor !== 'verification' ? info.result.rule", "!info.result.unsure && info.result.floor !== 'verification' ? info.result.rule", "D3 No limits"],
 ["D4-policy", "server/browser-extension-policy.ts", "browserActionDigest(action, Infinity)", "browserActionDigest(action)", "D4 No limits fills"],
 ["D5-arm", "extensions/murage-browser/runtime.mjs", "if (method === 'Page.downloadWillBegin' && b.noLimits) continue;", "", "D5 No limits"],
 ["B1-epoch", "server/browser-extension-engine.ts", "!known||navigationEpoch<known.navigationEpoch", "!known||navigationEpoch!==known.navigationEpoch", "B1"],
 ["B2-worker", "extensions/murage-browser/service-worker.mjs", "runtime.navigation(details, true)", "runtime.navigation(details)", "B2 worker"],
 ["B2-reconcile", "server/browser-extension-policy.ts", "entry.url !== prior.url && !this.noLimits(context)", "entry.url !== prior.url", "B2 iframe"],
 ["B2-history", "extensions/murage-browser/runtime.mjs", "if (!sameDocument || !b.noLimits) { forgetChildSessions", "if (true) { forgetChildSessions", "B2 iframe"],
 ["B2-idle-detach", "extensions/murage-browser/runtime.mjs", "delete t.contextIds; forgetChildSessions(b, t);", "delete t.contextIds; delete t.childSessions;", "B2 idle"],
 ["B2-idle-replay", "extensions/murage-browser/runtime.mjs", "if (method === 'Target.setAutoAttach' && !child)", "if (false && method === 'Target.setAutoAttach' && !child)", "B2 idle"],
 ["B3-quotes", "server/browser-extension-integration.ts", "typeof text === 'string'\n", "typeof text === 'string' && Buffer.byteLength(text) > 512 * 1024\n", "B3"],
 ["B4-created", "extensions/murage-browser/runtime.mjs", "if (action?.noLimits || (!action && botActive() && bindings.get(actor)?.noLimits)) return;", "", "B4.*created-first"],
 ["B4-filename", "extensions/murage-browser/runtime.mjs", "if (action?.noLimits || (!action && botActive() && bindings.get(actor)?.noLimits)) return false;\n    const first = proven();\n    if (first) return cancelProven(first);", "const first = proven();\n    if (first) return cancelProven(first);\n    if (action?.noLimits || (!action && botActive() && bindings.get(actor)?.noLimits)) return false;", "B4.*filename-first"],
 ["M1-inventory", "server/browser-extension-engine.ts", "for(const doc of docs)this.rememberDocument(doc);", "for(const doc of docs)this.known.set(doc.tabId,doc);", "M1 child sessions.*inventory"],
 ["M1-tab", "server/browser-extension-engine.ts", "for(const [session,child] of this.children)if(child.tabId===id)this.forgetChild(session);", "", "M1 child sessions.*tab removal"],
];
// r4: run the causal attribution and restart regressions against targeted reversions.
const attributionTest='scripts/browser-extension-download-attribution.test.mjs';
mutations.push(
 ['H1-timer-only','extensions/murage-browser/runtime.mjs','const attribution = item => {','const attribution = item => { return undefined;','H1 owner download survives',attributionTest],
 ['H1-tab','extensions/murage-browser/runtime.mjs','tabActors.get(item.tabId) ?? actionUrls.get(item.referrer)','actionUrls.get(item.referrer)',"H1 the Ask binding still cancels",attributionTest],
 ['H1-dispatch','extensions/murage-browser/runtime.mjs','if (journaled(req) && ownsBusy) recordAction(b, t, sendParams);','',"H1 dispatch records",attributionTest],
 ['H1-announcement','extensions/murage-browser/runtime.mjs',"if (method === 'Page.downloadWillBegin') announceAction(b, t, params.url);",'',"H1 delayed download uses recorded.*url",attributionTest],
 ['H1-url-exemption','extensions/murage-browser/runtime.mjs','if (action && !action.noLimits && [...tabActors.values()]','if (action && [...tabActors.values()]',"H1 delayed download uses recorded.*url",attributionTest],
 ['H1-referrer','extensions/murage-browser/runtime.mjs','tabActors.get(item.tabId) ?? actionUrls.get(item.referrer)','tabActors.get(item.tabId)',"H1 owner download survives.*referrer",attributionTest],
 ['H1-announced-owner','extensions/murage-browser/runtime.mjs','actionUrl(url, action, b.noLimits);','actionUrl(url, action);',"H1 the No limits announcement attributes",attributionTest],
 ['H1-pinned','extensions/murage-browser/runtime.mjs','if (known) return known.value;','',"H1 a later action in another tab",attributionTest],
 ['H1-arm-owner','extensions/murage-browser/runtime.mjs','!action || (!action.noLimits && action.binding === binding)','!action || !action.noLimits',"H1 an Ask arm cannot",attributionTest],
 ['D1-persistence','extensions/murage-browser/runtime.mjs','approvedOrigins: b.approvedOrigins.filter(o => { try { return originOf(o) === o; } catch { return false; } }), ','',"D1 a protected-origin bind",attributionTest],
);
const selected=process.argv[2]?new RegExp(process.argv[2]):null;
for(const [id,file,from,to,focus,testFile] of mutations){
 if(selected&&!selected.test(id))continue;
 const original=readFileSync(file,'utf8');if(!original.includes(from))throw Error(`${id}: mutation anchor missing`);
 let run;
 try{
  let mutated=original.replace(from,to);
  // Revert each guard involved in the selected compound regression.
  if(id==='D5-arm')mutated=mutated.replace("if (!url || bindings.get(binding)?.noLimits) return;","if (!url) return;").replace("if (action?.noLimits || (!action && botActive() && bindings.get(actor)?.noLimits)) return;",'').replace("candidate && !bindings.get(candidate.value.binding)?.noLimits && armOwns(candidate.value.binding, action) ? candidate : undefined","candidate").replace("armed && !bindings.get(armed.value.binding)?.noLimits && armOwns(armed.value.binding, action)","armed").replace("if (action?.noLimits || (!action && botActive() && bindings.get(actor)?.noLimits)) return false;",'').replace("const armOwns = (binding, action) => !action || (!action.noLimits && action.binding === binding);", "const armOwns = () => true;");
  if(id==='R6')mutated=mutated.replace('const approvedOrigins = noLimits ? origins.slice(-128) : origins;', 'const approvedOrigins = origins;');
  if(id==='F4')mutated=mutated.replace("if (serviceOwnerNoLimits(options.authorityFor?.(entry.context)) && ['idle', 'limit'].includes(entry.endedFor?.reason ?? '')) entry.endedFor = undefined;",'');
  writeFileSync(file,mutated);
  const pattern=focus??({'R2-fields':'R2','R2-frames':'R2','R3-credentials':'R3.*holds after promotion','R3-checker':'R3.*checker hold','F2-outside':'outside-result','F2-handoff':'existing handoff','F3-runtime':'native arm','F2-executor':'executes payment','F2-native':'native No limits observes','F2-clipboard':'executes clipboard','owner-takeover':'owner live take-over','owner-handoff':'existing.*owner handoff','capacity':'Allow always capacity'})[id]??id;
  run=id==='B2-worker'?spawnSync(process.execPath,['--test','--test-name-pattern=B2 worker','scripts/browser-extension-idle.node-test.mjs'],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024}):spawnSync('pnpm',['exec','vitest','run',testFile??'scripts/browser-no-limits-1019.test.mjs','-t',pattern,'--reporter=default','--reporter=json',`--outputFile=${evidence}/${id}-mutant.json`],{encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
 }finally{writeFileSync(file,original);}
 writeFileSync(`${evidence}/${id}-mutant.log`,(run.stdout??'')+(run.stderr??''));
 if(id==='B2-worker'){
  if(run.status!==1||run.error||run.signal||!((run.stdout??'')+(run.stderr??'')).includes('AssertionError'))throw Error(`${id}: mutant not killed by an assertion`);
  console.log(`${id}: KILLED ${file}`);continue;
 }
 const report=JSON.parse(readFileSync(`${evidence}/${id}-mutant.json`,'utf8'));
 if(!(report.numFailedTests>0)||report.numTotalTests===report.numPendingTests)throw Error(`${id}: pattern selected no failing test`);
 if(run.error||run.signal||run.status!==1||!report.testResults.some(suite=>suite.assertionResults.some(test=>test.status==='failed'&&test.failureMessages.some(message=>/AssertionError|_Assertion/.test(message)))))throw Error(`${id}: mutant was not killed by an assertion (status ${run.status})`);
 console.log(`${id}: KILLED ${file}`);
}
