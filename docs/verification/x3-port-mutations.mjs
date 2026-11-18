// Run only through the job container, from the repository root. Every mutation restores its source file.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { isAbsolute, join, relative } from 'node:path';
const aa='server/auto-approve.ts', words='server/x3-glob-words.ts', ss='server/shell-session-state.ts';
const witness='server/x3-r5-witness.test.ts', shapes='server/x3-r5-shapes.test.ts', policy='server/x3-port-policy.test.ts';
const cases = [
 ["Q3-ALIASED-CREDENTIAL-READ", "server/drivers/pi-permission-gate.ts", 'const modeFile = fromEnv ?', 'const credentialReader = readFileSync; credentialReader(".claude.json", "utf8"); const modeFile = fromEnv ?', "server/drivers/headless-text-only.credfix.test.ts", "only parser of an owner"],
 ["Q3-GUARD-CREDENTIAL-READ", "server/drivers/pi-permission-gate.ts", 'readFileSync(modeFile, "utf8")', 'readFileSync(".claude.json", "utf8")', "server/drivers/headless-text-only.credfix.test.ts", "only parser of an owner"],
 ["Q3-CONTEXT-CREDENTIAL-READ", "server/drivers/pi-permission-gate.ts", 'readBounded(wipeContextFile, 64 * 1024)', 'readBounded(".qwen/settings.json", 64 * 1024)', "server/drivers/headless-text-only.credfix.test.ts", "only parser of an owner"],
 ["Q1-RAW-INTERSECTION", aa, 'const words = command ? shellGlobWords(text, { shell: pinShell }).map(word => word.token) : [text];', 'const words = [text];', "server/x3-review-fixes.test.ts", "Q1 train ordinary outcome"],
 ["Q1-SYNTHETIC-CD-READ", aa, '(isGlobWord(folder) && !/[$`%]/.test(folder) ? globKeyRead(`cd ${folder}`) : null)', 'globKeyRead(`cd ${folder}`)', "server/x3-review-fixes.test.ts", "Q1 train ordinary outcome"],
 ["Q4-BARE-HOME-STAR", "shared/sensitive-globs.ts", 'extensionOnly && (!anchored || /^\\*+$/.test(last))', 'extensionOnly && !anchored', "server/x3-review-fixes.test.ts", "Q4 bare home star"],
 ["Q2-KNOWN-CWD", "server/auto-approve.test.ts", 'fullAccess: true, noLimits: false }, "Bash", command,', 'fullAccess: true, noLimits: true }, "Bash", command,', "server/auto-approve.test.ts", "X3 B known cwd"],
 ["Q2-PERSISTENT", "server/auto-approve.test.ts", '      { autoApprove: true, fullAccess: true, noLimits: false }, "Bash", command,', '      { autoApprove: true, fullAccess: true, noLimits: true }, "Bash", command,', "server/auto-approve.test.ts", "X3 B persistent shell"],
 ["Q2-RETIRED-HOLD", aa, 'return { approve: `auto-approved ${tool} (no limits)`, source: "no-limits" };', 'return { approve: `auto-approved ${tool} (no limits)`, source: "no-limits", rule: "held=key-row" };', "server/nolimits-means-it.test.ts", "runs without a key hold on a clean owner turn"],
 ["M1-NESTED-BASELINE", words, readFileSync(words, "utf8"), execFileSync("git", ["show", "4592224cb4:server/x3-glob-words.ts"], { encoding: "utf8" }), "server/x3-review-fixes.test.ts", "inside a local shell payload"],
 ["M1-PARAMETER-TRUNCATION", "server/x3-glob-words.ts", "if (choices.length > 256) throw new IncompleteGlobCheck();", "if (choices.length > 256) return choices.slice(0, 256);", "server/x3-review-fixes.test.ts", "parameter alternatives before"],
 ["M1-BRACE-ERROR", "server/x3-glob-words.ts", "catch { throw new IncompleteGlobCheck(); }", "catch { candidates = [word]; }", "server/x3-review-fixes.test.ts", "brace alternatives before"],
 ["CAP-QUIET", "server/x3-glob-words.ts", "if (!maySpellGlob(word.parts)) return [];", "maySpellGlob(word.parts);", "server/x3-review-fixes.test.ts", "keeps non-pattern"],
 ["CAP-INNER", "server/x3-glob-words.ts", "inner.push(part.text);", "void part;", "server/x3-review-fixes.test.ts", "still inspects substitutions"],
 ["CAP-BRACKETS", "server/x3-glob-words.ts", "if (states & BODY) next |= char === \"]\" ? FOUND : BODY;", "if (states & BODY) next |= BODY;", "server/x3-r5-witness.test.ts", "G2|bracket"],
 ["CAP-SPECIAL", "server/x3-glob-words.ts", "const value = textStates(literalGlobPattern(\"$\" + part.name, true), states);", "const value = textStates(\"$\" + part.name, states);", "server/x3-review-fixes.test.ts", "special parameter names"],
 ["M2-DIAGNOSTIC-HISTORY", "server/drivers/murage-exec.ts", "return (diagnosticText(execDiagPath(envFile), true) ?? \"\").split(\"\\n\").filter(line => line === \"keep-mismatch\").length;", "return readFileSync(execDiagPath(envFile), \"utf8\").split(\"\\n\").filter(line => line === \"keep-mismatch\").length;", "server/drivers/x3-review-diagnostics.test.ts", "bound log reads"],
 ["M2-SNAPSHOT-HISTORY", "server/drivers/murage-exec.ts", "const SNAPSHOT_ENTRIES = 64;", "const SNAPSHOT_ENTRIES = 4096;", "server/drivers/x3-review-diagnostics.test.ts", "bound snapshot enumeration"],
 ["M2-SNAPSHOT-BYTES", "server/drivers/murage-exec.ts", "if (!tail && size > DIAGNOSTIC_BYTES) return null;", "", "server/drivers/x3-review-diagnostics.test.ts", "selected snapshot.s bytes"],
 ["L1-STRING-INVENTORY", "docs/verification/x3-english-strings.md", "file patterns could not be checked in time", "patterns unavailable", "server/x3-review-fixes.test.ts", "English inventory"],
 ["H1-CANONICAL-NL", "server/auto-approve.ts", "prior = unlimited ? noLimitsOnlyVerdict(tool, summary, context) : autoVerdictOf(bot, tool, summary, context);", "prior = autoVerdictOf(bot, tool, summary, context);", "server/x3-rc-policy.test.ts", ""],
 ["H1-REGISTRY", "server/decision/implementation.ts", "else if(owner(e)){", "else if(false && owner(e)){", "server/x3-rc-registry.test.ts", ""],
 ["H1-RELEASE", "server/decision/implementation.ts", "wipes=wipeEvidence(action);", "wipes=[];", "server/x3-rc-registry.test.ts", ""],
 ["H2-ENGINE-BUILDER", "server/index.ts", "installEngineApprovalBuilder(decisionEngineApprovalAction);", ";", "server/x3-rc-api.test.ts", "^X3 RC registry:"],
 ["H3-PRODUCTION-HANDOFF", "server/index.ts", "baseEngineVerdict(registration, displayEvent)", "baseEngineVerdict(registration)", "server/x3-rc-api.test.ts", "^X3 RC registry:"],
 ['R2-ROOT', words, 'if (!isGlobWord(token)) return;', 'if (!isGlobWord(token) || /^\\/\\*{1,2}\\/?$/.test(token)) return;', 'server/x3-review-fixes.test.ts', 'X3 root fixture'],
 ['R2-DEPTH', words, 'if (depth > 8) throw new IncompleteGlobCheck();', 'if (depth > 8) return [];', 'server/x3-review-fixes.test.ts', 'X3 incomplete'],
 ['R2-LEXER', words, 'try { tokens = lex(text); } catch { throw new IncompleteGlobCheck(); }', 'try { tokens = lex(text); } catch { return []; }', 'server/x3-review-fixes.test.ts', 'lexer error'],
 ['RC-NL-CUSTOM-MAP','server/drivers/murage-exec.ts','const source = noLimits ? WRAPPER_SOURCE.replace','const source = false ? WRAPPER_SOURCE.replace','server/x3-rc-policy.test.ts','custom environment map at No limits=true'],
 ['RC-FULL-WRAPPER','server/drivers/murage-exec','murage_exec_no_limits=0','murage_exec_no_limits=1','server/drivers/claude.test.ts','binds the X3 wrapper level at spawn: No limits=false'],
 ['RC-NL-SPAWN','server/drivers/claude.ts','murageExecPrefix(process.platform, shellNoLimits)','murageExecPrefix(process.platform, false)','server/drivers/claude.test.ts','binds the X3 wrapper level at spawn: No limits=true'],
 ['RC-LEVEL-REUSE','server/drivers/claude.ts','diffWarmKey(live.warm, warm)','null','server/drivers/claude.test.ts','binds the X3 wrapper level'],
 ['RC-NL-CWD','server/auto-approve.ts','!unlimited && !context?.shellCwdPrepared','!context?.shellCwdPrepared','server/x3-rc-policy.test.ts','cwd preparation at No limits=true'],
 ['RC-NL-COVERAGE',aa,'export function autoVerdict(bot: AutoApprover, tool: string, summary: string, context?: AutoContext): AutoVerdict {','export function autoVerdict(bot: AutoApprover, tool: string, summary: string, context?: AutoContext): AutoVerdict {\n  if (hasNoLimits(bot) && tool === "Write") return { approve: null, source: "sensitive-guard" };','server/x3-rc-policy.test.ts','new coverage'],
 ['RC-NL-MANAGED','server/drivers/claude.ts','if (file.source === "managed" && !noLimits) return','if (file.source === "managed") return','server/x3-rc-policy.test.ts','managed proof settings at No limits=true'],
 ['RC-NL-FINDINGS',aa,'export function autoVerdict(bot: AutoApprover, tool: string, summary: string, context?: AutoContext): AutoVerdict {','export function autoVerdict(bot: AutoApprover, tool: string, summary: string, context?: AutoContext): AutoVerdict {\n  if (hasNoLimits(bot) && context?.globExpansionRule) return { approve: null, source: "sensitive-guard" };',policy,'mode/origin|earlier unreadable|linked ordinary|literal expansion'],
 ['RC-NL-WRAPPER','server/drivers/claude.ts','if (input.noLimits) return { proven: false, reason: "no-limits" };','if (false && input.noLimits) return { proven: false, reason: "no-limits" };','server/x3-rc-policy.test.ts','shape checking at No limits=true'],
 ['M1',aa,'let rule: string | null = null;\n  // Only destinations','let rule: string | null = null;\n  for (const cwd of effects.local.targets.keys()) for (const joined of placedGlobs(text, cwd, process.platform, options.home)) rule ??= matchFirst(SENSITIVE, joined) ?? globKeyRead(joined);\n  // Only destinations',shapes,'F4'],
 ['M2',aa,'const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);','const ABSENT_CODES = new Set<string>();',witness,'ABSENT listing'],
 ['M3',ss,'record.replacements.set(key, candidate);','record.replacements.set(key, candidate); record.state = candidate;',policy,'denied execution'],
 ['M4',words,'if (!isGlobWord(token)', 'token = token.replace(/^--?[\\w-]+[:=]/, "");\n    if (!isGlobWord(token)',witness,'option word|G3'],
 ['M5',words,'const dotMatch = options.dotglob', 'for (const token of text.split(/\\s+/)) add(token, true, true);\n  const dotMatch = options.dotglob',witness,'brackets in programs|POSIX: quoted'],
 ['M6',aa,'if (!anchored && effects.local.unknown) {','if (false && !anchored && effects.local.unknown) {',shapes,'T-S2 \\(MA1'],
 ['M6c',aa,' || !shellAndList(text) ? -1', ' ? -1',policy,'semicolon list'],
 ['M6d',aa,'const reader = options.reader ?? true;','const reader = false;',witness,'directory reader|Murage repo directory witness'],
 ['M7',aa,'matchFirst(PATH_RULES, placed) ?? dataCredentialHit([form])','matchFirst(PATH_RULES, placed) ?? (/murage-exec/.test(placed) ? "read-glob projection" : null) ?? dataCredentialHit([form])',witness,"Murage's own sources"],
 ['M8',aa,'if (!dotMatch && entry.name.startsWith','if (false && !dotMatch && entry.name.startsWith',witness,'dot rule:'],
 ['M9',aa,'const reader = options.reader ?? true;','const reader = true;',witness,"Murage's own sources|names-only directory"],
 ['M10',aa,'for (const operand of linkCopyOperands(text))','for (const operand of [] as string[])',policy,'P6'],
 ['M11',aa,'export const GLOB_STEP_LIMIT = 65_536;','export const GLOB_STEP_LIMIT = 655_360;',witness,'M11'],
 ['M12',words,'const words = powershellGlobWords(text);','const words = powershellGlobWords(text).filter(word => !text.includes(`"${word}"`));',witness,'PowerShell: Get-Content'],
 ['M13b',words,'later.some(one => one.stdout || !isFilter(one))','later.slice(0, 1).some(one => one.stdout || !isFilter(one))',policy,'sort \\| xargs'],
 ['L4-FD',words,'stage.stdout = stage.stderr;','stage.stdout = false;',policy,'2>names'],
 ['L4-BUILTIN',aa,'const directoryBuiltins = options.driver === undefined || startSet.source === "claude";','const directoryBuiltins = true;',policy,'owner-shadowed'],
 ['L4-OVERLAP',ss,'if (replacement.install && this.replacementSeq.get(replacement) === record.installedSeq) {','if (true) {','server/shell-session-state.test.ts','overlapping request'],
 ['L4-CAP','shared/sensitive-globs.ts','if (state.targets.size >= SHELL_MAX_PLACES) { shellOverflow(state); return; }','if (state.targets.size >= SHELL_MAX_PLACES) return;',shapes,'T-S3 \\(MA3'],
 ['M6b',aa,'let replacement: ShellCwdState | undefined;', 'if (text.includes("&& cd")) chain = { targets: ["/w"], lastAbsolute: true, seen: true, command: "cd /w" };\n  let replacement: ShellCwdState | undefined;',policy,'later dynamic cd'],
 ['M14-record-guess',ss,'return record?.active ? copyShellCwdState(record.state) : unknown();','return record?.active ? copyShellCwdState(record.state) : { targets: new Map([["/w", "project guess"]]) };','server/shell-session-state.test.ts','no bound record'],
 ['M15-M17-persistent-cap','shared/sensitive-globs.ts','state.unknown = SHELL_OVERFLOW_REASON;','delete state.unknown;',shapes,'T-S3 \\(MA3'],
 ['L4-combined-fd',words,'if (token.op === "&>" || token.op === "&>>") stage.stderr = stage.stdout;','',policy,'&>names'],
 ["L4-LITERAL-GLOB", "server/x3-glob-words.ts", "values = [literalGlobPattern(part.text, part.quote !== \"none\")];", "values = [part.text.replace(part.quote === \"none\" ? /[*?]/g : /[*?[\\]]/g, \"_\")];", "server/x3-port-policy.test.ts", "quoted wildcard directory"],
 ["L4-LITERAL-ENTRY", "server/auto-approve.ts", "pathGlobsIntersect([literalGlobPattern(entry.name)], [segment], charge)", "pathGlobsIntersect([entry.name], [segment], charge)", "server/x3-port-policy.test.ts", "entry.s brackets"],
 ["L4-ESCAPED-BRACKET", "server/shell/lex.ts", "lit(next, /[[\\]]/.test(next) ? \"single\" : \"none\");", "lit(next, \"none\");", "server/x3-port-policy.test.ts", "quoted wildcard directory"],
 ["L4-LITERAL-CWD", "server/auto-approve.ts", "path = literalGlobPattern(options.cwd.replace(/\\/$/, \"\")) + \"/\" + path;", "path = options.cwd.replace(/\\/$/, \"\") + \"/\" + path;", "server/x3-port-policy.test.ts", "quoted wildcard directory"],
 ["L4-LITERAL-PATH-LENGTH", "server/auto-approve.ts", "if (globPatternText(path).length > 4096) return whole(\"syntax\");", "if (path.length > 4096) return whole(\"syntax\");", "server/x3-port-policy.test.ts", "valid long cwd"],
];
const evidence = process.env.X3_MUTATION_EVIDENCE;
assert(evidence && isAbsolute(evidence) && relative(process.cwd(), evidence).startsWith('..'), 'X3_MUTATION_EVIDENCE must be outside the checkout');
mkdirSync(evidence, { recursive: true });
const results=[];
for(const [id,file,before,after,test,pattern] of cases){
 if (process.env.X3_MUTATIONS && !process.env.X3_MUTATIONS.split(',').includes(id)) continue;
 const original=readFileSync(file,'utf8');
 if(!original.includes(before))throw new Error(`missing mutation site ${id}`);
 try{
  writeFileSync(file,original.replace(before,after));
  const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'-t',pattern,'--maxWorkers=1','--reporter=verbose'],{encoding:'utf8',timeout:120000,maxBuffer:8e6});
  const output=(run.stdout??'')+(run.stderr??'');
  writeFileSync(join(evidence, `mutation-${id}.log`),output);
  const killed=run.status===1 && /AssertionError/.test(output);
  results.push({id,killed,status:run.status,sourceSha256:createHash('sha256').update(original).digest('hex')});
  console.log(JSON.stringify(results.at(-1)));
 }finally{writeFileSync(file,original);assert.equal(readFileSync(file, "utf8"), original);}
}
writeFileSync(join(evidence, 'mutations.json'),JSON.stringify(results,null,2));
if(results.some(r=>!r.killed))process.exitCode=1;
