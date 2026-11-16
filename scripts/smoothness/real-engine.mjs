// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isMainModule, judge, waitFor } from './smooth-config.mjs';
import { packagedLayout, readAppMetadata } from './packaged.mjs';

export const ENGINES = ['claude', 'codex', 'gemini', 'fuigo', 'opencode'];

/** The app's send-keyed terminal receipt is authoritative. Audience SSE and
 * journals deliberately withhold native turn ids and stop reasons. */
export async function engineTurn({ bot, text, send, state, wait = waitFor }) {
  const sendId = randomUUID();
  const sent = await send(bot, text, sendId);
  if (sent.status !== 202) throw Error('engine fixture send refused');
  let terminal;
  const ended = await wait(async () => {
    const response = await state(bot, sendId), receipt = response.json;
    if (response.status !== 200 || receipt?.contract !== 1 || receipt.botId !== bot.id ||
        receipt.threadId !== bot.threadId || receipt.sendId !== sendId) throw Error('engine fixture receipt does not match send');
    terminal = receipt.terminalOutcome;
    return typeof terminal === 'string';
  }, { cap: 180000 });
  if (!ended.ok || !terminal) throw Error('engine fixture turn did not settle');
  return { outcome: terminal === 'completed' || terminal === 'stopped' ? 'turn.completed' : 'turn.failed', stopReason: terminal === 'stopped' ? 'cancelled' : null };
}
// Existing CLI logins are only read. Never run login or synthesize an auth file.
export function prerequisites(engine, env, { exists = existsSync, executable = file => {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
} } = {}) {
  if (!ENGINES.includes(engine)) throw Error('unknown real engine');
  const home = env.HOME || '';
  const missing = [];
  if (!(env.PATH || '').split(delimiter).some(dir => executable(join(dir, engine)))) missing.push(`${engine} binary on PATH`);
  const auth = {
    claude: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN) || exists(join(home, '.claude/.credentials.json')),
    codex: exists(join(home, '.codex/auth.json')),
    gemini: Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
    fuigo: Boolean(env.FUIGO_API_KEY) || exists(join(home, '.fuigo/auth.json')),
    opencode: exists(join(home, '.local/share/opencode/auth.json')),
  };
  const names = { claude: 'CLAUDE_CODE_OAUTH_TOKEN or existing .claude/.credentials.json', codex: 'existing .codex/auth.json',
    gemini: 'GEMINI_API_KEY or GOOGLE_API_KEY', fuigo: 'FUIGO_API_KEY or existing .fuigo/auth.json', opencode: 'existing .local/share/opencode/auth.json' };
  if (!auth[engine]) missing.push(names[engine]);
  return missing;
}

/** Drive only the isolated packaged server's owner routes. A queued message is not a steer. */
export async function probeEngine({ makeBot, setLevel, turn, openCards, respond, send, busy, stop, messages, wait = waitFor }) {
  const bot = await makeBot();
  if ((await setLevel(bot, 'ask')).status !== 200) throw Error('Ask level was not applied');
  let ended = null;
  const active = turn(bot, 'Run exactly `sleep 45` in the shell, then reply DONE.').then(result => (ended = result));
  // Observe rejection immediately; the scenario's cleanup owns stopping the bot on any exception.
  void active.catch(() => {});
  let card;
  const seen = await wait(async () => {
    if (ended) throw Error('turn ended before an approval card');
    card = (await openCards(bot)).find(row => row.card?.tool && /^p\.[A-Za-z0-9-]+$/.test(row.card.requestHandle ?? '') && !row.card.answered && !row.card.dismissed)?.card;
    return Boolean(card);
  }, { cap: 180000 });
  if (!seen.ok || !card) throw Error('no approval card observed');
  const answer = await respond(bot, { threadId: bot.threadId, requestHandle: card.requestHandle, action: 'allow' });
  if (answer.status !== 200) throw Error('approval answer refused');
  if (!await busy(bot)) throw Error('turn ended before steer');
  const text = 'After the command, include STEER_ACK in your reply.';
  const steered = await send(bot, text);
  if (steered.status !== 202 || steered.json?.steered !== true) throw Error('engine did not acknowledge a live steer');
  const recorded = await wait(async () => (await messages(bot)).some(row => row.role === 'user' && row.text === text && row.steered === true));
  if (!recorded.ok || !await busy(bot)) throw Error('steer not recorded on a running turn');
  const settled = await stop(bot);
  if (!settled.settled) throw Error('Stop did not settle');
  const stopped = await active;
  if (stopped.stopReason !== 'cancelled') throw Error(`Stop outcome was ${stopped.outcome}`);
  // This completed turn proves an actual provider reply and recovery after Stop.
  const next = await turn(bot, 'Reply with exactly RECOVERED. Do not use any tools.');
  const reply = (await messages(bot)).some(row => row.role === 'bot' && typeof row.text === 'string' && row.text.includes('RECOVERED'));
  if (next.outcome !== 'turn.completed' || !reply) throw Error('real turn after Stop did not complete with its reply');
  return { cards: 1, steers: 1, stopped: 1, stopMs: settled.ms, completed: 1 };
}

export function realEngineResult(result, budgets, { engine, sha }) {
  const rows = [...budgets.rows.filter(row => ['S0.boot', 'S0.exits'].includes(row.id)), ...budgets.realEngineRows];
  const judged = judge({ rows }, result);
  return { engine, sha, status: result?.scenarios?.realEngine?.status === 'NOT-RUN' ? 'NOT-RUN' : result?.engines === 'real' && result?.mode === 'packaged' && result?.tree === sha &&
    result?.scenarios?.realEngine?.engine === engine && judged.pass ? 'PASS' : 'FAIL',
    at: new Date().toISOString(), rows: judged.rows.map(({ error, invalid, ...row }) => row), invalid: judged.invalid ? 'packaged evidence incomplete' : null };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const engine = process.argv[2], checkOnly = process.argv.includes('--preflight');
  const out = resolve(process.env.SMOOTH_OUT || join(tmpdir(), 'smooth-real-evidence'));
  mkdirSync(out, { recursive: true });
  const sha = process.env.GITHUB_SHA || process.env.TREE_SHA;
  const emit = verdict => {
    writeFileSync(join(out, `real-engine-${engine}.json`), JSON.stringify(verdict, null, 2) + '\n');
    console.log(`REAL-ENGINE: ${verdict.status === 'NOT-RUN' ? 'NOT RUN' : verdict.status} (${engine}${verdict.missing ? `: ${verdict.missing.join('; ')}` : ''})`);
    process.exitCode = verdict.status === 'PASS' ? 0 : 1;
  };
  const missing = prerequisites(engine, process.env);
  if (process.argv.includes('--package-unavailable')) missing.push('packaged RC build unavailable');
  if (!/^[a-f0-9]{40}$/.test(sha || '')) missing.push('full RC SHA');
  if (missing.length) emit({ engine, sha, status: 'NOT-RUN', missing });
  else if (checkOnly) console.log(`REAL-ENGINE: prerequisites present (${engine}; not a verdict)`);
  else {
    try {
      if (!process.env.SMOOTH_APP_DIR) { emit({ engine, sha, status: 'NOT-RUN', missing: ['SMOOTH_APP_DIR packaged app'] }); process.exit(1); }
      const app = packagedLayout(process.env.SMOOTH_APP_DIR);
      if (readAppMetadata(app.resources).murageSourceSha !== sha) throw Error('packaged murageSourceSha does not match RC');
      const fixture = mkdtempSync(join(tmpdir(), 'smooth-nightly-'));
      const data = join(fixture, 'data'); mkdirSync(data);
      const env = { ...process.env, MURAGE_DATA_DIR: data, SMOOTH_CTL: join(fixture, 'ctl'), SMOOTH_FIXTURE_ROOT: fixture,
        SMOOTH_ENGINES: 'real', SMOOTH_SCENARIOS: 'boot,realEngine', SMOOTH_REAL_ENGINE: engine,
        SMOOTH_REAL_FAST: engine, SMOOTH_REAL_SCRIPTED: engine, SMOOTH_REAL_CLAUDE: engine,
        SMOOTH_OUT: out, SMOOTH_LABEL: engine, TREE_SHA: sha };
      const child = spawnSync(process.execPath, ['scripts/smoothness/smooth.mjs'], { env, stdio: 'inherit', timeout: 25 * 60000 });
      const result = JSON.parse(readFileSync(join(out, `results-${engine}.json`), 'utf8'));
      const budgets = JSON.parse(readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'));
      const verdict = realEngineResult(result, budgets, { engine, sha });
      if (child.status !== 0 && verdict.status !== 'NOT-RUN') verdict.status = 'FAIL';
      emit(verdict);
      // Evidence and the isolated fixture remain in the ephemeral job container until it exits.
    } catch (error) {
      // Never include provider error text or credentials in the public verdict.
      emit({ engine, sha, status: 'FAIL', missing: ['packaged run or evidence unavailable; inspect private runner logs'] });
    }
  }
}
