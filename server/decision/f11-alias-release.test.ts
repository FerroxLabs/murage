// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 (1.0.23) W14 (Fable M2): the intake rewrite is card side only. The Allow answer handed back to the engine never
// carries the rewritten execute body (the engine ran, or runs, its own alias call), and a No limits alias send is released
// exactly as the equal raw execute send. Real decision registry, real intake (aliasAsk), the fake transport records replies.
import { expect, it } from 'vitest';
import { fixture, d, baseRun, baseCard, card } from './fixture.ts';
import { aliasAsk, ALIAS_ENGINES } from '../../shared/connected-app-aliases.ts';
import { boundedToolInput } from '../approval-text.ts';
import type { McpMountRecord } from '../../shared/mount-identity.ts';

const OWN: McpMountRecord = { engineName: 'murage_connectors', mountId: 'own:connector', provenance: 'own' };
const SEND = { account: 'acct_a', arguments: { recipient_email: 'new@x.com', subject: 's', body: 'b' } };
const BODY = { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', account: 'acct_a', arguments: SEND.arguments }], sync_response_to_workbench: false };

/** What each engine files for its connector call (server/drivers/*.ts request.opened). Pi is not here: it is out of ALIAS_ENGINES until proven.
 * Antigravity runs only while it is in ALIAS_ENGINES (out until proven on its real CLI; its negative row is in the intake test). */
const ENGINES: Record<string, (tool: string, input: unknown) => object> = {
  claude: (tool, input) => ({ tool: `mcp__murage_connectors__${tool}`, summary: tool, toolInput: boundedToolInput(input), toolCall: { name: `mcp__murage_connectors__${tool}`, input }, toolEngine: 'claude', mcpMounts: [OWN] }),
  codex: (tool, input) => ({ tool, summary: tool, toolInput: boundedToolInput(input), toolCall: { name: `mcp__murage_connectors__${tool}`, input }, toolEngine: 'codex', mcpMounts: [OWN] }),
  chat: (tool, input) => ({ tool: `murage_connectors__${tool}`, summary: tool, toolInput: boundedToolInput(input), toolCall: { name: `murage_connectors__${tool}`, input }, toolIdentity: { namespace: 'mcp', name: `murage_connectors__${tool}` }, toolEngine: 'chat', mcpMounts: [OWN] }),
  antigravity: (tool, input) => ({ tool: `mcp__murage_connectors__${tool}`, summary: tool, toolCall: { name: `mcp__murage_connectors__${tool}`, input }, toolEngine: 'antigravity', mcpMounts: [OWN] }),
};
const intake = (extra: object) => aliasAsk({ type: 'request.opened', requestType: 'permission', ...extra } as never) as Record<string, unknown>;

for (const [engine, make] of Object.entries(ENGINES).filter(([name]) => ALIAS_ENGINES.has(name as never))) {
  it(`${engine}: No limits releases the alias send exactly as the raw execute send, and the Allow reply carries no body`, async () => {
    const run = async (extra: object) => {
      const f = fixture();
      const ref = f.open('r1', {}, extra);
      expect(d.decide(ref, baseRun).kind).toBe('run');
      await d.deliverRequest(ref);
      const calls = f.respond.mock.calls.map((call) => call[1]);
      f.dispose();
      return calls;
    };
    const rewritten = intake(make('gmail_send_email', SEND));
    expect(rewritten.toolCall).toMatchObject({ input: BODY });
    const aliased = await run(rewritten);
    const raw = await run(make('APPS_MULTI_EXECUTE_TOOL', BODY));
    expect(aliased).toHaveLength(1);
    expect(aliased[0]).toMatchObject({ behavior: 'allow' });
    expect(aliased[0]).not.toHaveProperty('updatedInput');
    expect(JSON.stringify(aliased[0])).not.toContain('tool_slug');
    expect(aliased).toEqual(raw);
  });
  it(`${engine}: at Ask the owner's Allow on the alias card answers allow with no updatedInput`, async () => {
    const f = fixture('ask');
    const ref = card(d.decide(f.open('r2', {}, intake(make('gmail_send_email', SEND))), baseCard));
    await d.presentApproval(ref, { title: 'Action', subtitle: 'Fixture' });
    await d.answerApproval(ref, { behavior: 'allow' });
    const answers = f.respond.mock.calls.map((call) => call[1]);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ behavior: 'allow' });
    expect(answers[0]).not.toHaveProperty('updatedInput');
    expect(JSON.stringify(answers[0])).not.toContain('tool_slug');
    f.dispose();
  });
}
