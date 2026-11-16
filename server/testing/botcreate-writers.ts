import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const sinks: Array<[string, RegExp, string?]> = [
  ['G1', /taskAllowances\.grant\(/],
  ['G2', /routineRequests!?\.resolve\(|settleAutomationProposal\(|resolveAndSendRoutine\(/],
  ['G3', /resolveSkillRequest\(|applyStagedSkillWrite\(/],
  ['G4', /fullAccessApprovesSetup\(/],
  ['G5b', /\bmanageBot\(/],
  ['G6', /rememberAndAnswer\(|rememberGrantAndAnswer\(|planAlwaysAllowSet\(/],
  ['G7', /body\.alwaysAllow/],
  ['G8', /rememberHostComputerConsent\b|resolveHostComputerConsent\(|hostComputerConsent = |hostComputerConsent: "allowed"/],
  ['G9', /folderTrust\.remember\(|rememberPickedFolder\(/],
  ['G10', /enabled: true|enabled: operation\.action/, 'server/routine-requests.ts'],
  ['G11', /installPreparedSkill\(|updatePreparedSkill\(/],
  ['G12', /persistMcpServers\(|enableMcpServer\(|cfg\.mcpServers\s*=[^=]|saveMcpServers\(/],
  ['G12b', /composio\w*\.(connect|enable|add|save)\w*\(|connectors\w*\.(enable|add|save|set)\w*\(/],
  ['G13', /\.respondToRequest\(/],
  ['A1', /\banswerRequest\(|\brespondToCard\(/],
];
// Field names describe the authority data, never a list of permitted sink functions.
const permissionFields = new Set(['autoApprove', 'fullAccess', 'noLimits', 'alwaysAllow', 'chiefOfStaff', 'computer', 'browser', 'composio', 'hostComputerConsent', 'permissions', 'connectedAppAccess', 'accessRoleEpoch', 'approvePeerComms', 'messageAllow', 'fullAccessChannelMessages', 'fullAccessSetupRequests', 'fullAccessAcknowledgedAt', 'noLimitsAcknowledgedAt', 'imageApproval', 'imageAskAfter', 'autoReview', 'autoStartVps', 'draftOnly', 'sharedWith']);
const nameOf = (node: ts.Node | undefined): string | undefined => node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
function visit(node: ts.Node, action: (node: ts.Node) => void): void { action(node); ts.forEachChild(node, child => visit(child, action)); }
/** Discover the Store's writers from their bodies or a typed whole-record marker.
 * Whole-record writers and forwarding wrappers carry the typed marker. */
export function storePermissionSinks(source: string): Set<string> {
  const tree = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true);
  const methods = new Map<string, ts.MethodDeclaration>();
  visit(tree, node => { if (ts.isClassDeclaration(node) && node.name?.text === 'Store') for (const member of node.members) {
    if (ts.isMethodDeclaration(member) && member.body) methods.set(nameOf(member.name)!, member);
  } });
  const sinks = new Set<string>();
  for (const [name, method] of methods) visit(method, node => {
    if (ts.isTypeReferenceNode(node) && nameOf(node.typeName) === 'BotPermissionWrite') sinks.add(name);
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && permissionFields.has(nameOf(node.name) ?? '')) sinks.add(name);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = node.left;
      const field = ts.isPropertyAccessExpression(left) ? nameOf(left.name) : ts.isElementAccessExpression(left) ? nameOf(left.argumentExpression) : undefined;
      if (field && permissionFields.has(field)) sinks.add(name);
    }
  });
  return sinks;
}
export interface WriterSite { group: string; file: string; fn: string; route: string; zone: 'engine' | 'other'; code: string; callers: string[] }
/** Normative non-store groups retain sites.sh coverage. Store sinks and their calls/definitions are discovered by AST, including one level of callers. */
export function writerSites(root = process.cwd()): WriterSite[] {
  const files = new Map<string, string[]>();
  const walk = (dir: string) => { for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'testing' && e.name !== 'node_modules') walk(path); }
    else if (!e.name.endsWith('.test.ts') && /\.(ts|js|mjs|json|md|sh)$/.test(e.name)) files.set(path, readFileSync(join(root, path), 'utf8').split('\n'));
  } };
  walk('server');
  const index = files.get('server/index.ts')!, lo = index.findIndex(l => l.includes('path.startsWith("/api/internal/")')), hi = index.findIndex((l, i) => i > lo && l.includes('unknown internal endpoint'));
  const fnPattern = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
  const context = (file: string, at: number) => {
    let fn = '', route = '';
    const lines = files.get(file)!;
    for (let n = at; n >= 0; n--) {
      const found = fnPattern.exec(lines[n]); if (found) { fn = found[1]; break; }
      if (!route && /method === "\w+"/.test(lines[n])) route = lines[n].trim().replace(/\s+/g, ' ');
    }
    return { fn, route, zone: file === 'server/index.ts' && at >= lo && at <= hi ? 'engine' as const : 'other' as const };
  };
  const out: WriterSite[] = [];
  for (const [group, pattern, scope] of sinks) for (const [file, lines] of files) {
    if (scope && scope !== file) continue;
    for (let at = 0; at < lines.length; at++) {
      if (!pattern.test(lines[at])) continue;
      const ctx = context(file, at), callers: string[] = [];
      if (ctx.fn && !fnPattern.test(lines[at]) && ctx.zone !== 'engine' && !ctx.route) {
        const call = new RegExp(`(?<![.\\w])${ctx.fn}\\(`);
        for (const [f, ls] of files) for (let n = 0; n < ls.length; n++) if (call.test(ls[n]) && !fnPattern.test(ls[n])) {
          const c = context(f, n); callers.push([f, c.fn, c.route, c.zone, ls[n].trim()].join('|'));
        }
      }
      out.push({ group, file, ...ctx, code: lines[at].trim(), callers: callers.sort() });
    }
  }
  const trees = new Map([...files].filter(([file]) => /\.(ts|js|mjs)$/.test(file)).map(([file, lines]) => [file, ts.createSourceFile(file, lines.join('\n'), ts.ScriptTarget.Latest, true)]));
  const enclosingFunction = (node: ts.Node, fallback: string): string => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isMethodDeclaration(parent)) && parent.name) return nameOf(parent.name) ?? fallback;
      if (ts.isConstructorDeclaration(parent)) return 'constructor';
    }
    return fallback;
  };
  const calls: Array<{ name: string; at: number; site: Omit<WriterSite, 'group' | 'callers'> }> = [];
  for (const [file, tree] of trees) visit(tree, node => {
    if (!ts.isCallExpression(node)) return;
    const expr = node.expression;
    const name = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : ts.isElementAccessExpression(expr) ? nameOf(expr.argumentExpression) : undefined;
    if (!name) return;
    const at = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
    const ctx = context(file, at);
    calls.push({ name, at, site: { file, ...ctx, fn: enclosingFunction(node, ctx.fn), code: files.get(file)![at].trim() } });
  });
  const storeSinks = storePermissionSinks((files.get('server/store.ts') ?? []).join('\n'));
  const storeTree = trees.get('server/store.ts');
  if (storeTree) visit(storeTree, node => {
    if (!ts.isMethodDeclaration(node) || !storeSinks.has(nameOf(node.name) ?? '')) return;
    const name = nameOf(node.name)!;
    const at = storeTree.getLineAndCharacterOfPosition(node.getStart(storeTree)).line;
    out.push({ group: 'G5-definition', file: 'server/store.ts', fn: name, route: '', zone: 'other', code: files.get('server/store.ts')![at].trim(),
      callers: [...new Set(calls.filter(call => call.name === name).map(({ site: c }) => [c.file, c.fn, c.route, c.zone, c.code].join('|')))].sort() });
  });
  const seen = new Set<string>();
  for (const { name, at, site } of calls) {
    if (!storeSinks.has(name)) continue;
    const key = `${site.file}:${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const callers = site.fn && site.zone !== 'engine' && !site.route
      ? calls.filter(call => call.name === site.fn && !fnPattern.test(call.site.code))
        .map(({ site: c }) => [c.file, c.fn, c.route, c.zone, c.code].join('|')) : [];
    out.push({ group: 'G5', ...site, callers: [...new Set(callers)].sort() });
  }
  return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
