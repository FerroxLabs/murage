// Run only inside the isolated test container. Every mutation is restored.
import { readFileSync, writeFileSync } from 'node:fs';
import { evidenceDir, writeEvidence } from './evidence-fs.mjs';
import { spawnSync } from 'node:child_process';
const out = process.argv[2];
if (!out || out.startsWith('/dev')) throw Error('Specify an evidence directory outside /dev');
evidenceDir(out);
const rows = [
  ['P1-1-host', 'server/drivers/browser-proxy.ts', 'await request("state");', '/* mutant: bypass host */', 'server/web-read-r1.test.ts', 'revalidates the host'],
  ['P1-1-control', 'server/drivers/browser-proxy.ts', '!controlState.available || controlState.held', 'controlState.held', 'server/web-read-r1.test.ts', 'control verification'],
  ['P1-2-origin', 'server/browser-extension-engine-read.ts', 'await allow(origin);', '/* mutant: wrong authority */', 'server/web-read-r1.test.ts', 'reauthorizes A'],
  ['P1-2-invalidate', 'server/browser-extension-executor.ts', 'this.readDocuments.invalidateOrigin(origin);', 'void origin;', 'server/browser-extension-service.test.ts', 'saved-origin invalidation through settings'],
  ['P1-3-droid', 'server/drivers/acp/droid.ts', '...(turn.integrations?.agents ? ["--remove-tools", "FetchUrl"] : [])', '...[]', 'server/web-read-r1.test.ts', 'Droid removes'],
  ['P1-3-qwen', 'server/drivers/acp/qwen.ts', '"--exclude-tools=web_fetch", ', '', 'server/web-routing-r1.test.ts', 'Qwen excludes'],
  ['P1-3-copilot', 'server/drivers/acp/copilot.ts', '["--excluded-tools=web_fetch"]', '[]', 'server/web-routing-r1.test.ts', 'Copilot excludes'],
  ['P1-3-opencode', 'server/drivers/acp/opencode-go.ts', 'webfetch: "deny",', 'webfetch: "ask",', 'server/web-routing-r1.test.ts', 'OpenCode excludes'],
  ['P1-3-grok', 'server/drivers/acp/grok.ts', '["--deny", "WebFetch"]', '[]', 'server/web-routing-more-r1.test.ts', 'Grok excludes'],
  ['P1-3-hermes', 'server/drivers/acp/hermes.ts', '...disabled, "web", "browser"', '...disabled', 'server/web-routing-more-r1.test.ts', 'Hermes managed'],
  ['P2-timer', 'server/web-documents.ts', 'try { store.expire(); }', 'try { /* mutant: never sweep */ }', 'server/web-read-r1.test.ts', 'expires idle'],
  ['P2-cap', 'server/web-document-budget.ts', 'row.total + bytes > this.global || row.bot + bytes > this.perBot', 'false', 'server/web-read-retention-r1.test.ts', 'caps span stores'],
  ['P2-source', 'server/browser-extension-engine-read.ts', 'content, false, fetched.body)', 'content, false, content)', 'server/web-read-r1.test.ts', 'complete llms'],
  ['M1-headless', 'server/drivers/headless-browser-proxy.ts', 'const reply = await routeBrowserRead("headless", input, nativeReadPort(client, { check: authorized, current: () => !stopped }, documents, "browser"));', 'const reply = await client.request("tools/call", call);', 'server/browser-read-route-inventory.test.ts', 'T1-routes headless'],
  ['M1-unified', 'server/browser-control.ts', 'const result = call.name === "agent_browser_read"', 'const result = false', 'server/browser-read-route-inventory.test.ts', 'T1-routes unified'],
  ['M1-cdp', 'server/browser-control.ts', 'const result = call.name === "agent_browser_read"', 'const result = !e.spec?.env.AGENT_BROWSER_CDP && call.name === "agent_browser_read"', 'server/browser-read-route-inventory.test.ts', 'T1-routes unified cdp=true'],
  ['M1-extension', 'server/browser-extension-executor.ts', 'let output=operation==="read"?', 'let output=false?', 'server/browser-read-route-inventory.test.ts', 'T1-routes extension'],
  ['M1-builtin', 'server/drivers/browser-proxy.ts', 'return textResult(JSON.stringify(await routeBrowserRead("builtin", range, {', 'return textResult((await request("read") as { text: string }).text);\n    return textResult(JSON.stringify(await routeBrowserRead("builtin", range, {', 'server/browser-read-route-inventory.test.ts', 'T1-routes builtin'],
  ['M1-sink', 'server/browser-native-relay.ts', 'if (method === "tools/call" && params?.name === "agent_browser_read") throw Error("Network read must use the mediated reader.");', '', 'server/browser-read-route-inventory.test.ts', 'T1-sink'],
  ['M1-static', 'server/browser-control.ts', 'import { WebDocuments }', 'if (false) readWithBrowserAuthority({}, {});\nimport { WebDocuments }', 'server/browser-read-route-inventory.test.ts', 'T1-static'],
  ['M1-scope', 'server/browser-control.ts', 'options.readScope ??', '"constant-scope" ??', 'server/browser-read-route-inventory.test.ts', 'T1-scope'],
  ['M2-filter', 'src/components/ChatView.tsx', 'if (limit) return <EngineLimitRow', 'if (limit && showToolCalls) return <EngineLimitRow', 'src/components/EngineLimitRow.dom.test.ts', 'T2-render'],
  ['M2-once', 'server/index.ts', '!store.newestMatching(turn.threadId, m => m.tool?.name === webReadLine, Number.MAX_SAFE_INTEGER)', 'true', 'server/browser-read-route-inventory.test.ts', 'T2-once'],
  ['M2-settings', 'src/components/BotSettingsPane.tsx', 'section === "model" && engineLimit &&', 'false && engineLimit &&', 'src/components/EngineLimitRow.dom.test.ts', 'T2-settings'],
  ['M2-recognizer', 'shared/web-read-routing.ts', 'if (!name?.startsWith(ENGINE_LIMIT_PREFIX))', 'if (true)', 'src/components/EngineLimitRow.dom.test.ts', 'T2-render'],
  ['M2-dash', 'shared/web-read-routing.ts', 'can still use its own web reader,', 'can still use its own web reader—', 'server/browser-read-route-inventory.test.ts', 'T2-copy'],
  ['M2-room', 'src/components/GroupView.tsx', 'm.kind === "activity" && engineLimitNotice(m.tool?.name)', 'false && engineLimitNotice(m.tool?.name)', 'src/components/EngineLimitRow.dom.test.ts', 'T2-render'],
  ['M2-call', 'src/components/EngineLimitRow.tsx', "message.kind === 'activity' ? engineLimitNotice", "false ? engineLimitNotice", 'src/components/EngineLimitRow.dom.test.ts', 'T2-call'],
  ['M3-gate', 'scripts/web-read-replay/run.mjs', "check(defaultRoute?.browser !== false && defaultRoute && !defaultRoute.useMyChrome && defaultRoute.browserTransport !== 'extension',", 'check(true,', 'scripts/web-read-replay/replay.test.mjs', 'T3-gate'],
  ['M4', 'scripts/web-read-replay/run.mjs', "const save = () => writeEvidence(join(out, 'verdict.json'), JSON.stringify(report, null, 2));", "const save = () => writeFileSync(join(out, 'verdict.json'), JSON.stringify(report, null, 2), { mode: 0o600 });", 'scripts/web-read-replay/replay.test.mjs', 'T4-permissions'],

];
const results = [];
const selected = process.argv[3];
if (selected === 'baseline') {
  const baseline = JSON.parse(readFileSync('.webread-evidence/r2/baseline-sources.json', 'utf8'));
  const originals = new Map(Object.keys(baseline).map(path => [path, readFileSync(path, 'utf8')]));
  try {
    for (const [path, source] of Object.entries(baseline)) writeFileSync(path, source.replace('const MessagesList = memo', 'export const MessagesList = memo').replace('const Transcript = memo', 'export const Transcript = memo'));
    const tests = spawnSync('node_modules/.bin/vitest', ['run', 'server/browser-read-route-inventory.test.ts', 'src/components/EngineLimitRow.dom.test.ts'], { encoding: 'utf8', timeout: 300000 });
    writeEvidence(`${out}/baseline-tests.log`, (tests.stdout ?? '') + (tests.stderr ?? ''));
    const replay = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/web-read-replay/run.mjs', '--fake', '--out', `${out}/baseline-replay`], { env: { ...process.env, WEBREAD_REVISION: '740842495', WEBREAD_ENGINES: '' }, encoding: 'utf8', timeout: 480000 });
    writeEvidence(`${out}/baseline-replay.log`, (replay.stdout ?? '') + (replay.stderr ?? ''));
    writeEvidence(`${out}/baseline-status.json`, JSON.stringify({ tests: tests.status, replay: replay.status }, null, 2));
  } finally { for (const [path, source] of originals) writeFileSync(path, source); }
  process.exit(0);
}
const wants = id => !selected || selected === id || (selected === 'r2' && id.startsWith('M'));
for (const [id, path, before, after, test, match] of rows.filter(row => wants(row[0]))) {
  const original = readFileSync(path, 'utf8');
  const controllerPath = "server/browser-control.ts", controllerOriginal = readFileSync(controllerPath, "utf8");
  if (!original.includes(before)) throw Error(`${id}: mutation anchor missing`);
  try {
    let mutated = original.replace(before, after);
    if (id === "P1-1-control") mutated = mutated.replace("!current.available || current.held", "current.held");
    writeFileSync(path, mutated);
    if (id === "M1-sink") writeFileSync(controllerPath, controllerOriginal.replace('const result = call.name === "agent_browser_read"', 'const result = false'));
    const run = spawnSync('node_modules/.bin/vitest', ['run', test, '-t', match], { encoding: 'utf8', timeout: 240000 });
    const log = (run.stdout ?? '') + (run.stderr ?? ''); writeEvidence(`${out}/${id}.log`, log);
    const killed = run.status !== 0 && /AssertionError|promise resolved|expected .*to|expects to receive a string/i.test(log) && log.includes(match);
    results.push({ id, status: run.status, killed });
    writeEvidence(`${out}/results.json`, JSON.stringify(results, null, 2));
    console.log(`${id}: ${killed ? "DETECTED" : "SURVIVED"}`);
    if (!killed) process.exitCode = 1;
  } finally { writeFileSync(path, original); if (id === "M1-sink") writeFileSync(controllerPath, controllerOriginal); }
}
writeEvidence(`${out}/results.json`, JSON.stringify(results, null, 2));
// A product-level truncation mutant: the model substitute consumes every range
// but the saved source has lost the last 1,342 characters. The field replay must fail.
if (!selected || selected === 'P1-4-replay') {
const path = 'server/web-documents.ts', original = readFileSync(path, 'utf8');
try {
  writeFileSync(path, original.replace('    const size = text.length * 2;', '    text = text.slice(0, 12000);\n    const size = text.length * 2;'));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/web-read-replay/run.mjs', '--fake', '--out', `${out}/P1-4-replay`], { env: { ...process.env, WEBREAD_REVISION: 'mutation-fixture', WEBREAD_ENGINES: 'verification' }, encoding: 'utf8', timeout: 240000 });
  writeEvidence(`${out}/P1-4-replay.log`, (run.stdout ?? '') + (run.stderr ?? ''));
  const report = JSON.parse(readFileSync(`${out}/P1-4-replay/verdict.json`, 'utf8'));
  const killed = report.rows.some(row => row.errors.includes('page incomplete or changed'));
  results.push({ id: 'P1-4-replay', status: run.status, killed }); if (!killed) process.exitCode = 1;
} finally { writeFileSync(path, original); writeEvidence(`${out}/results.json`, JSON.stringify(results, null, 2)); }

}

// Keep the sink-intact and sink-removed failures distinct: refusal versus truncation.
for (const id of ['M3-route', 'M3-route-and-sink']) if (wants(id)) {
  const controllerPath = 'server/browser-control.ts', relayPath = 'server/browser-native-relay.ts';
  const controller = readFileSync(controllerPath, 'utf8'), relay = readFileSync(relayPath, 'utf8');
  try {
    writeFileSync(controllerPath, controller.replace('const result = call.name === "agent_browser_read"', 'const result = false'));
    if (id === 'M3-route-and-sink') writeFileSync(relayPath, relay.replace('if (method === "tools/call" && params?.name === "agent_browser_read") throw Error("Network read must use the mediated reader.");', ''));
    const run = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/web-read-replay/run.mjs', '--fake', '--out', `${out}/${id}`], { env: { ...process.env, WEBREAD_REVISION: 'mutation-fixture', WEBREAD_ENGINES: '' }, encoding: 'utf8', timeout: 480000 });
    writeEvidence(`${out}/${id}.log`, (run.stdout ?? '') + (run.stderr ?? ''));
    const report = JSON.parse(readFileSync(`${out}/${id}/verdict.json`, 'utf8'));
    const expected = id === 'M3-route' ? 'browser read refused' : 'no continuation evidence';
    const killed = report.rows.length === 5 && report.rows.every(row => row.gweb === 'FAIL' && row.errors.includes(expected));
    results.push({ id, status: run.status, killed, expected }); if (!killed) process.exitCode = 1;
  } finally { writeFileSync(controllerPath, controller); writeFileSync(relayPath, relay); writeEvidence(`${out}/results.json`, JSON.stringify(results, null, 2)); }
}
