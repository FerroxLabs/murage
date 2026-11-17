import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import * as ask from "./always-ask.ts";
import { judge } from "./no-limits-code.ts";
const rows = JSON.parse(readFileSync(new URL('./testing/fixtures/no-limits-r13.json', import.meta.url), 'utf8'));
const bot = { autoApprove: true, fullAccess: true, noLimits: true };
afterEach(() => vi.restoreAllMocks());
for (const row of rows) {
  const payload = () => {
    if (!row.repeat) return row.payload;
    const text = (row.repeat.prefix ?? '') + row.repeat.text.repeat(row.repeat.count) + (row.repeat.suffix ?? '');
    return row.repeat.field ? { [row.repeat.field]: text } : text;
  };
  if (!row.context && !row.fault) it(`${row.id} reader ${row.expected}`, () => {
    const result = judge(row.identity, payload());
    expect(result.verdict + (result.cls ? ':' + result.cls : '')).toBe(row.expected);
  });
  it(`${row.id} marked-owner production card`, () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    if (row.fault) vi.spyOn(ask, 'alwaysAskCommand').mockImplementationOnce(() => {
      if (row.fault === 'exception') throw new Error('one-shot reader failure');
      return { ...ask.unreadableHit(), reason: row.fault };
    });
    const value = payload();
    const command = row.identity === 'terminal' ? value : undefined;
    const input = row.identity === 'python' ? { code: value } : value;
    const context = { fullAccessOrigin: 'owner', ownerStarted: true, commandText: command,
      commandCwd: '/tmp', workFolder: '/tmp', promptFacts: { cwd: '/tmp', home: '/tmp/home' }, unseen: { platform: 'posix' },
      ...(command === undefined ? { call: { toolCall: { name: row.identity, input } } } : {}), ...row.context } as AutoContext;
    const result = autoVerdict(bot, command === undefined ? row.identity : 'Bash', command ?? 'neutral summary', context);
    // Stored owner origin and ownerStarted authenticate this No limits fixture;
    // cwd/project /tmp and home /tmp/home are explicit above.
    // MAIN RULING NARROW-WIPE 2026-11-14: preserve the explicit rmtree('/') catastrophe; nonrecursive os.remove controls remain outside the catastrophe list.
    // MAIN RULING 1114-WIPE-FOUND-R1 §4: the exact import-aliased shutil.rmtree disguise runs; the legacy reader expectation stays.
    expect(result.approve === null ? 'card' : 'run').toBe(['R13-cr-comment','R13-numeric-value','R13-alias-shift'].includes(row.id)?'run':/^card:(?:root|home|system|disk|fork)$/.test(row.expected)?'card':'run');
  });
}

it('literal Python root deletion still raises a production wipe card', () => {
  const code = "import shutil\nshutil.rmtree('/')";
  const context: AutoContext = {
    fullAccessOrigin: 'owner', ownerStarted: true, commandCwd: '/tmp', workFolder: '/tmp',
    promptFacts: { cwd: '/tmp', home: '/tmp/home' }, unseen: { platform: 'posix' },
    call: { toolCall: { name: 'python', input: { code } } },
  };
  expect(autoVerdict(bot, 'python', 'neutral summary', context)).toMatchObject({ approve: null, source: 'always-ask', rule: 'delete-root' });
});
