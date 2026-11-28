// secret-scan: fixture (fake paths, policy test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-nolimits (MAIN-RULING SEAN 2026-11-25): on No limits only the wipe list asks, also on the turn Murage
// starts itself. The owner's 2026-11-25 log: a Chief's unattended team-incident turn asked before `ls`
// (`approvals: asked reason=no-grant origin=other unattended=1 level=ask`).
// Real server, real path: a routine of another bot fails (its engine turn ends in an API error), onRunFailed ->
// reportTeamIncident -> dispatchTeamIncident -> startTurn(teamIncidentTurnOptions) -> startTurnAdmitting's dispatch
// initiator; the Chief's incident turn then asks the permission prompt tool about one command. The fake engine never
// runs a command. NOT changed, pinned by the last row: a send no owner surface proved stays an Ask turn.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';

// the 50 everyday commands of server/decision/nolimits-1022q.test.ts
const COMMANDS = [
  'ls -lt ~/.fixture-app/queue | head', 'ls', 'ls -la', 'pwd', 'git status', 'git log --oneline -20', 'git diff HEAD~1', 'cat package.json',
  'cat ~/.ssh/config', 'cat ~/.aws/credentials', 'grep -r API_KEY .env', 'cat .env', 'env | grep TOKEN', 'printenv',
  'bash -c "$CMD"', 'eval "$(ssh-agent -s)"', 'sh -c "ls $HOME"', 'cd ~/Projects && npm install', 'npm run build', 'npm test',
  'curl -s https://api.example.com/repos/x/y | jq .', 'python3 -c "import json;print(1)"', 'node -e "console.log(1)"', 'find ~ -name "*.log" -mtime -1',
  'du -sh ~/Library/Caches/*', 'tail -n 200 ~/Library/Logs/FixtureApp/server.log', 'grep -i error ~/Library/Logs/FixtureApp/server.log | tail', 'security find-generic-password -s fixture -w',
  'cp ~/.zshrc ~/.zshrc.bak', 'echo "export X=1" >> ~/.zshrc', 'chmod +x ./run.sh', 'mkdir -p out && mv a.txt out/', 'rm -rf node_modules', 'rm -rf ./dist',
  'brew install jq', 'pip install requests', 'docker ps', 'ps aux | grep node', 'kill 12345', 'open -a Safari https://example.com',
  'osascript -e \'tell application "Finder" to get name of every window\'', 'sqlite3 ~/.fixture-app/data.db ".tables"', 'xargs -I{} echo {} < list.txt', 'for f in *.md; do wc -l "$f"; done',
  'cat <<EOF > notes.md\nhello\nEOF', 'git push origin main', 'gh pr list', 'ssh fixture-host uptime', 'scp file fixture-host:/tmp/', 'crontab -l',
];
const WIPE = 'rm -rf ~';
const INCIDENT_MARK = 'Incident report from Murage';

let fixture: VerificationServer, headers: Record<string, string>, model: string, input: string;
async function api(method: string, path: string, body?: unknown, auth: Record<string, string> = headers) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
async function ok(method: string, path: string, body?: unknown, status = 200, auth?: Record<string, string>) {
  const answer = await api(method, path, body, auth);
  if (answer.status !== status) throw new Error(`setup: ${method} ${path} answered ${answer.status}`);
  return answer.body;
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs'),path=await import('node:path'),{pathToFileURL}=await import('node:url');
    process.env.FAKE_CLAUDE_PERM_TOOL='Bash';
    process.env.FAKE_CLAUDE_PERM_INPUT_FILE=path.join(process.env.MURAGE_DATA_DIR,'q22-input','command.json');
    // The fake engine: a routine prompt carrying the fail mark ends in an API error (the run fails); the incident
    // report Murage sends the Chief asks the permission prompt tool about the command in FAKE_CLAUDE_PERM_INPUT_FILE.
    const originalCli=path.join(process.cwd(),'server/testing/fake-claude-cli.ts');
    const cli=path.join(process.env.MURAGE_DATA_DIR,'q22-incident-cli.ts');
    let source=fs.readFileSync(originalCli,'utf8');
    const ask='fixtureRequested(promptText(prompt), "__fixture_permission_tool__")', fail='mode === "api-error" || resumedError';
    if(!source.includes(ask)||!source.includes(fail))throw Error('fixture anchor moved');
    source=source.replace(ask,'promptText(prompt).includes(${JSON.stringify(INCIDENT_MARK)})||'+ask);
    source=source.replace(fail,fail+' || (promptText(prompt).includes("__fixture_q22_fail__") && !promptText(prompt).includes(${JSON.stringify(INCIDENT_MARK)}))');
    source=source.replace(/from "([.][^"\\n]+)"/g,(_match,specifier)=>'from '+JSON.stringify(new URL(specifier,pathToFileURL(originalCli)).href));
    fs.writeFileSync(cli,source);fs.chmodSync(cli,0o755);
    const configFile=path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    config.instances.verification.config.cli=cli;
    fs.writeFileSync(configFile,JSON.stringify(config));
  ` });
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await ok('GET', '/api/desktop-secret', undefined, 200, {})).secret };
  await ok('POST', '/api/memory/action', { action: 'configure', mode: 'off' });
  model = (await ok('GET', '/api/instances')).instances.find((row: any) => row.instanceId === 'verification').models.options[0].id;
  mkdirSync(join(fixture.info.dataDir, 'q22-input'), { recursive: true });
  input = join(fixture.info.dataDir, 'q22-input', 'command.json');
}, 120000);
afterAll(async () => { await fixture?.close(); });

async function makeBot(name: string, section: string, chief: boolean) {
  const bot = (await ok('POST', '/api/bots', { name, modelSelection: { instanceId: 'verification', model } }, 201)).bot;
  await ok('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off', section, ...(chief ? { chiefOfStaff: true } : {}) });
  return bot;
}
/** A team whose Chief is at No limits, and a teammate whose routines break. */
async function team(name: string) {
  const chief = await makeBot(`${name} chief`, `${name} team`, true);
  const raised = await raiseLevel(api, chief.id, { noLimits: true, acknowledgeNoLimits: true });
  if (raised.status !== 200) throw new Error(`setup: raising the Chief answered ${raised.status}`);
  return { chief, worker: await makeBot(`${name} worker`, `${name} team`, false) };
}
const decisionsOf = async (botId: string): Promise<any[]> => (await ok('GET', '/api/decisions?limit=500')).decisions.filter((row: any) => row.botId === botId);
/** One routine of the worker fails; Murage reports it to the Chief, whose incident turn asks about `command`.
 * Returns the decision row that question got (a card or an automatic approval). */
async function incidentAsks(chiefId: string, workerId: string, command: string, n: number): Promise<{ decision: string; source: string; threadId: string }> {
  writeFileSync(input, JSON.stringify({ command }));
  const before = (await decisionsOf(chiefId)).length;
  const routine = (await ok('POST', '/api/routines', { botId: workerId, name: `Q22 fixture ${n}`, prompt: '__fixture_q22_fail__', runOn: 'ember', enabled: false,
    schedule: { type: 'interval', everyMinutes: 60, anchorAt: Date.now() + 3600000 } }, 201)).routine;
  await ok('POST', `/api/routines/${routine.id}/run`, {}, 201);
  let row: any;
  await expect.poll(async () => { row = (await decisionsOf(chiefId)).slice(before).find((r: any) => r.decision === 'card-shown' || r.decision === 'auto-approved'); return Boolean(row); },
    { timeout: 30000, interval: 100 }).toBe(true);
  // a card holds the Chief's turn; end it so the next incident is not queued behind it
  if (row.decision === 'card-shown') await ok('POST', `/api/bots/${chiefId}/interrupt`, { threadId: row.threadId });
  await expect.poll(async () => (await ok('GET', '/api/bots')).bots.find((bot: any) => bot.id === chiefId)?.busy === true, { timeout: 15000 }).toBe(false);
  return { decision: row.decision, source: row.source, threadId: row.threadId };
}

it('the Chief\'s team-incident turn on No limits runs everyday commands without a card', async () => {
  const { chief, worker } = await team('Q22 calm');
  const asked: string[] = [];
  for (const [n, command] of COMMANDS.entries()) {
    const row = await incidentAsks(chief.id, worker.id, command, n);
    asked.push(`${row.decision}:${row.source}`);
  }
  expect(asked).toEqual(COMMANDS.map(() => 'auto-approved:no-limits'));
}, 400000);

it('a wipe on the same incident turn still asks', async () => {
  const { chief, worker } = await team('Q22 wipe');
  expect((await incidentAsks(chief.id, worker.id, WIPE, 0)).decision).toBe('card-shown');
}, 120000);

it('a send no owner surface proved stays an Ask turn on the same No limits Chief', async () => {
  const { chief } = await team('Q22 unproven');
  writeFileSync(input, JSON.stringify({ command: 'ls' }));
  const sent = await fetch(`${fixture.info.url}/api/bots/${chief.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: chief.threadId, text: `__fixture_permission_tool__ q22 unproven` }) });
  if (sent.status !== 202) throw new Error(`setup: unproven send answered ${sent.status}`);
  let row: any;
  await expect.poll(async () => { row = (await decisionsOf(chief.id)).find((r: any) => r.threadId === chief.threadId); return Boolean(row); }, { timeout: 30000, interval: 100 }).toBe(true);
  await ok('POST', `/api/bots/${chief.id}/interrupt`, { threadId: chief.threadId });
  expect(row.decision).toBe('card-shown');
}, 120000);
