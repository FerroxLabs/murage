// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 q1022-nolimits (MAIN-RULING SEAN 2026-11-25, field #44 #36 #37 #33 #30 #11): on No limits only the wipe
// list asks, also on a turn Murage starts itself (the owner's 2026-11-25 log: a team-incident `ls` carded with
// `reason=no-grant origin=other unattended=1 level=ask`). Fifty everyday commands go through the decision layer
// (decide, then deliver) with the real BASE reader (autoVerdict) and raise no card; the wipe list and a saved Never still ask.
import { describe, expect, it } from 'vitest';
import { fixture, d } from './fixture.ts';
import { decisionInitiator, decisionDispatchKind } from './initiator.ts';
import { teamIncidentTurnOptions } from '../team-incidents.ts';
import { autoVerdict, type AutoContext } from '../auto-approve.ts';
import type { NoLimitsOrigin } from '../no-limits-origin.ts';

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
const WIPES = ['rm -rf ~', 'rm -rf /', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/disk2'];
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true } as const;
const FULL = { autoApprove: true, fullAccess: true, noLimits: false, permissionExplicit: true } as const;
const HOST_NEVER = { kind: 'deny', class: 'host-computer', ruleId: 'host-declined', span: 'fixture' } as const;

/** The BASE context the approval listener builds (server/index.ts request.opened): who started the turn, and the
 * No limits origin the decision provenance gives (decisionNoLimitsOrigin: a guest's words, else unattended). */
function context(command: string, extra: Partial<AutoContext>): AutoContext {
  return { commandText: command, commandCwd: '/work/project', workFolder: '/work/project', promptFacts: { home: '/home/fixture', cwd: '/work/project' }, ...extra } as AutoContext;
}
/** Run every command through decide and deliver it as the engine path does; return the commands that raised a card or a
 * refusal, or whose delivered answer was not an allow. */
async function cards(f: ReturnType<typeof fixture>, commands: readonly string[], bot: object, extra: Partial<AutoContext>): Promise<string[]> {
  const asked: string[] = [];
  for (const [n, command] of commands.entries()) {
    const handle = f.open(`r${n}`, { command }, { summary: command });
    const outcome = d.decide(handle, () => autoVerdict(bot as never, 'Bash', command, context(command, extra)));
    if (outcome.kind !== 'run') { asked.push(`${outcome.kind}: ${command}`); continue; }
    const before = f.respond.mock.calls.length;
    await d.deliverRequest(handle);
    const answer = f.respond.mock.calls[before]?.[1];
    if (answer?.behavior !== 'allow') asked.push(`delivered ${answer?.behavior}: ${command}`);
  }
  return asked;
}

describe('No limits: a turn Murage starts itself (team incident) asks only for the wipe list', async () => {
  // The owner's log 2026-11-25 (1.0.22 candidate): Chief's unattended team-incident turn, `ls -lt ... | head`,
  // `approvals: asked reason=no-grant origin=other unattended=1 level=ask`.
  const initiator = decisionInitiator({ ownerTyped: false, ...decisionDispatchKind(teamIncidentTurnOptions('t-incidents'), false, 0) });
  const origin: NoLimitsOrigin = initiator.k === 'other-human' || initiator.k === 'guest' ? 'other-human' : 'unattended';
  const unattended = { fullAccessOrigin: 'other', unattended: true, noLimitsOrigin: origin } as Partial<AutoContext>;

  it('fifty everyday commands raise no card', async () => {
    const f = fixture('unlimited', initiator);
    expect(await cards(f, COMMANDS, NO_LIMITS, unattended)).toEqual([]);
  });
  it('the turn runs at the bot\'s own No limits level, not a guest\'s Ask', () => {
    fixture('unlimited', initiator);
    expect(d.readTurnPolicy({ threadId: 't', generation: 'g' } as never)).toMatchObject({ level: 'unlimited', permission: { noLimits: true } });
  });
  it('the wipe list still asks', async () => {
    const f = fixture('unlimited', initiator);
    expect(await cards(f, WIPES, NO_LIMITS, unattended)).toHaveLength(WIPES.length);
  });
  it('a guest\'s words stay at Ask', async () => {
    const f = fixture('unlimited', { k: 'other-human' });
    expect(await cards(f, ['ls'], NO_LIMITS, { fullAccessOrigin: 'other', noLimitsOrigin: 'other-human' })).toEqual(['card: ls']);
  });
});

describe('a deny rule still blocks', () => {
  const owner = { fullAccessOrigin: 'owner', ownerStarted: true } as Partial<AutoContext>;
  it('a saved Never blocks at Full access, at No limits and on a turn Murage starts itself', async () => {
    const full = fixture('full');
    full.deny([HOST_NEVER]);
    expect(await cards(full, ['ls'], FULL, owner)).toEqual(['card: ls']);
    const unlimited = fixture('unlimited');
    unlimited.deny([HOST_NEVER]);
    expect(await cards(unlimited, ['ls'], NO_LIMITS, { ...owner, noLimitsOrigin: 'owner' })).toEqual(['refuse: ls']);
    const incident = fixture('unlimited', decisionInitiator({ ownerTyped: false, ...decisionDispatchKind(teamIncidentTurnOptions('t-incidents'), false, 0) }));
    incident.deny([HOST_NEVER]);
    expect(await cards(incident, ['ls'], NO_LIMITS, { fullAccessOrigin: 'other', unattended: true, noLimitsOrigin: 'unattended' })).toEqual(['refuse: ls']);
  });
});
