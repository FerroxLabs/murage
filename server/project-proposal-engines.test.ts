// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from 'vitest';
import { allocateToolName } from './drivers/pi-mcp-extension.ts';
import { ChiefProposalTurns, newProposalServerAlias, proposalSettings, proposalToolItemStops, PROJECT_PROPOSE_ROUTE, projectProposalToolRefusal, proposalAskAllowed, proposalAskRefusalLine, proposalEngine, proposalToolCall } from './project-proposal-engines.ts';

const instance = (driverKind: string, capabilities: {agentsMcp?: boolean} = {}, extra: {enabled?: boolean; proposeProject?: unknown} = {}) =>
  ({driverKind, enabled: extra.enabled ?? true, adapter: {capabilities}, ...(extra.proposeProject ? {proposeProject: extra.proposeProject} : {})});

it('Claude keeps its tools-off one-shot proposal', () => {
  expect(proposalEngine(instance('claudeAgent', {agentsMcp: true}, {proposeProject: async () => ''}))).toEqual({kind: 'one-shot'});
});
it('N2 Codex answers with the block on a restricted turn: no live-check gate, no agents mount', () => {
  expect(proposalEngine(instance('codex', {agentsMcp: true}))).toEqual({kind: 'turn', tool: null});
});
it.each(['fuigoAgent', 'grokAgent'])('%s keeps project_propose through use_tool with the qualified name, beside the block', kind => {
  const engine = proposalEngine(instance(kind, {agentsMcp: true}));
  expect(engine).toMatchObject({kind: 'turn', tool: {call: expect.stringContaining('use_tool with tool_name "agents__project_propose"'), serverAlias: true}});
  expect(engine?.kind === 'turn' ? engine.tool?.call : '').toContain('search_tool');
});
it('Pi keeps project_propose through the name its MCP extension registers, beside the block', () => {
  const call = proposalToolCall('piAgent');
  expect(call).toContain(allocateToolName('agents', 'project_propose', new Set()));
  expect(proposalEngine(instance('piAgent', {agentsMcp: true}))).toEqual({kind: 'turn', tool: {call, serverAlias: false}});
});
// N2: the proposal no longer depends on recognising a tool call, so every enabled engine can draft it.
// Their asks prove nothing (no input, a display title only) or they cannot call Murage tools: block only.
it.each(['geminiAgent', 'kimiAgent', 'droidAgent', 'cursorAgent', 'opencodeGo', 'qwenAgent', 'hermesAgent', 'customAcp', 'antigravityAgent'])('N2 %s drafts the proposal as a block, without the tool', kind => {
  expect(proposalEngine(instance(kind, {agentsMcp: true}))).toEqual({kind: 'turn', tool: null});
});
it.each(['grok', 'openai-compat', 'minimax', 'boxAgent', 'fuigoAgent'])('N2 %s without Murage tools drafts the proposal as a block', kind => {
  expect(proposalEngine(instance(kind, {}))).toEqual({kind: 'turn', tool: null});
});
it('a disabled or missing engine cannot propose', () => {
  expect(proposalEngine(instance('codex', {agentsMcp: true}, {enabled: false}))).toBeNull();
  expect(proposalEngine(instance('geminiAgent', {agentsMcp: true}, {enabled: false}))).toBeNull();
  expect(proposalEngine(undefined)).toBeNull();
});
it('the real drivers declare what the table says', async () => {
  const {BUILT_IN_DRIVERS} = await import('./drivers/builtIn.ts');
  const made = new Map<string, ReturnType<typeof proposalEngine>>();
  for (const driver of BUILT_IN_DRIVERS) {
    if (!['grok', 'openai-compat', 'minimax', 'fuigoAgent', 'grokAgent', 'geminiAgent'].includes(driver.driverKind)) continue;
    const created = await (driver as any).create({instanceId: `probe-${driver.driverKind}`, displayName: undefined, environment: {}, enabled: true, config: driver.defaultConfig()});
    try { made.set(driver.driverKind, proposalEngine(created)); } finally { await created.dispose(); }
  }
  for (const kind of ['grok', 'openai-compat', 'minimax', 'geminiAgent']) expect(made.get(kind)).toEqual({kind: 'turn', tool: null});
  for (const kind of ['fuigoAgent', 'grokAgent']) expect(made.get(kind)).toMatchObject({kind: 'turn', tool: {serverAlias: true}});
});

it('a proposal turn may call only project_propose; no other turn may call it', () => {
  expect(projectProposalToolRefusal(true, 'POST', PROJECT_PROPOSE_ROUTE)).toBeNull();
  for (const path of ['/api/internal/ask', '/api/internal/project/assign', '/api/internal/memory/save', '/api/internal/register-artifact', '/api/internal/tool-result'])
    expect(projectProposalToolRefusal(true, 'POST', path)).toEqual({status: 409, body: {error: 'not_allowed', reason: 'This turn can only send the project proposal.'}});
  expect(projectProposalToolRefusal(true, 'GET', '/api/internal/bots')).toMatchObject({status: 409});
  expect(projectProposalToolRefusal(false, 'POST', PROJECT_PROPOSE_ROUTE)).toMatchObject({status: 403});
  expect(projectProposalToolRefusal(false, 'POST', '/api/internal/ask')).toBeNull();
});

const valid = {proposal: {members: ['a'], leadBotId: 'a', mode: 'goal' as const, brief: {summary: 's', doneMeans: 'd', rules: 'r'}, budget: {minutes: 120, tokens: 3000000}, planOutline: ['x']}};
it('a valid submission resolves the waiting proposal once, bound to its generation', async () => {
  const turns = new ChiefProposalTurns();
  const waiting = turns.begin('t', 'chief', 'gen', 'inst', () => valid);
  expect(turns.owns('t')).toBe(true);
  expect(turns.submit('t', 'other-gen', {})).toMatchObject({status: 403});
  expect(turns.submit('t', 'gen', {})).toEqual({status: 200, body: {ok: true, text: expect.stringContaining('owner')}});
  expect(await waiting).toEqual(valid);
  expect(turns.submit('t', 'gen', {})).toMatchObject({status: 409});
  turns.end('t', 'gen');
  expect(turns.owns('t')).toBe(false);
  // its late provider events stay ignored after the wait is over
  expect(turns.ignores('t')).toBe(true);
  expect(turns.ignores('other')).toBe(false);
});
it('an invalid submission is refused with a plain reason and the turn may try again', async () => {
  const turns = new ChiefProposalTurns();
  let calls = 0;
  const waiting = turns.begin('t', 'chief', 'gen', 'inst', () => { if (calls++ === 0) throw new Error('Check the proposal: mode.'); return valid; });
  expect(turns.submit('t', 'gen', {mode: 'party'})).toEqual({status: 400, body: {error: 'Check the proposal: mode.'}});
  expect(turns.submit('t', 'gen', {})).toMatchObject({status: 200});
  expect(await waiting).toEqual(valid);
});
it('a turn that ends without a proposal resolves empty', async () => {
  const turns = new ChiefProposalTurns();
  const waiting = turns.begin('t', 'chief', 'gen', 'inst', () => valid);
  turns.end('t', 'gen');
  expect(await waiting).toBeNull();
  expect(turns.submit('t', 'gen', {})).toMatchObject({status: 403});
});
it('N2 a turn that completes hands back its reply text; a tool proposal sent first wins', async () => {
  const turns = new ChiefProposalTurns();
  const waiting = turns.begin('t', 'chief', 'gen', 'inst', () => valid);
  turns.end('t', 'other-gen', 'forged');
  turns.end('t', 'gen', 'Here is the draft.');
  expect(await waiting).toEqual({text: 'Here is the draft.'});
  const sent = turns.begin('u', 'chief', 'gen', 'inst', () => valid);
  expect(turns.submit('u', 'gen', {})).toMatchObject({status: 200});
  turns.end('u', 'gen', 'a later reply');
  expect(await sent).toEqual(valid);
});
it('N2 a turn that did not finish hands back what it wrote, marked partial', async () => {
  const turns = new ChiefProposalTurns();
  const waiting = turns.begin('t', 'chief', 'gen', 'inst', () => valid);
  turns.end('t', 'gen', 'half', true);
  expect(await waiting).toEqual({text: 'half', partial: true});
});
it('R7-6 ending a proposal turn revokes its generation at once, and its thread stays fenced to project_propose', async () => {
  const turns = new ChiefProposalTurns();
  const revoked: string[] = [];
  const waiting = turns.begin('t', 'chief', 'gen', 'inst', () => valid, () => revoked.push('gen'));
  turns.end('t', 'gen');
  turns.end('t', 'gen');
  expect(revoked).toEqual(['gen']);
  expect(await waiting).toBeNull();
  // after the wait: still refused everywhere but the propose route, which then answers the turn ended
  expect(projectProposalToolRefusal(turns.ignores('t'), 'POST', '/api/internal/delegate-bot')).toMatchObject({status: 409});
  expect(projectProposalToolRefusal(turns.ignores('t'), 'POST', PROJECT_PROPOSE_ROUTE)).toBeNull();
  expect(turns.submit('t', 'gen', valid.proposal)).toMatchObject({status: 403});
});

const proposalInput = {members: ['a'], leadBotId: 'a', mode: 'goal', brief: {summary: 's', doneMeans: 'd', rules: 'r'}, budget: {minutes: 1, tokens: 1}, planOutline: []};
const acp = {acp: true, server: 'agents'} as const;
const ask = (kind: string | undefined, title: string, input: unknown, identity?: {namespace: string; name: string; kind?: string}) =>
  ({requestType: 'permission', tool: kind ?? 'tool', toolCall: {name: title, input}, ...(kind === undefined ? {} : {toolKind: kind}), ...(identity ? {toolIdentity: identity} : {})});
const fuigo = {namespace: 'fuigo_build', name: 'use_tool', kind: 'use_tool'};

it('R7-2 R8-2 an ACP ask is allowed only by its stamped identity or by a proposal input under kind other', () => {
  const useTool = {variant: 'UseTool', tool_name: 'agents__project_propose', tool_input: proposalInput};
  // (a) a stamped identity naming the propose tool on Murage's mount
  expect(proposalAskAllowed(ask('other', 'use_tool', useTool, fuigo), acp)).toBe(true);
  expect(proposalAskAllowed(ask('other', 'Use a tool', useTool, fuigo), acp)).toBe(true);
  expect(proposalAskAllowed(ask('other', 'x', proposalInput, {namespace: 'mcp', name: 'agents__project_propose'}), acp)).toBe(true);
  expect(proposalAskAllowed(ask('other', 'x', {}, {namespace: 'mcp', name: 'agents__list_bots'}), acp)).toBe(false);
  // R9-3: the stamped call reaches only Murage's propose route, whose validator refuses a bad input with a reason
  expect(proposalAskAllowed(ask('other', 'use_tool', {...useTool, tool_input: {command: 'cat ~/.ssh/id_ed25519'}}, fuigo), acp)).toBe(true);
  expect(proposalAskAllowed(ask('other', 'use_tool', {...useTool, tool_input: 'cat ~/.ssh/id_ed25519'}, fuigo), acp)).toBe(false);
  // (b) no identity: kind other (or none) and exactly use_tool on this turn's mount carrying a proposal (Grok Build)
  expect(proposalAskAllowed(ask('other', 'use_tool', {tool_name: 'agents__project_propose', input: proposalInput}), acp)).toBe(true);
  expect(proposalAskAllowed(ask(undefined, 'use_tool', {variant: 'UseTool', tool_name: 'agents__project_propose', tool_input: proposalInput}), acp)).toBe(true);
  // R9-2: a bare proposal-shaped input names no tool and no mount: denied
  expect(proposalAskAllowed(ask('other', 'project_propose (agents MCP Server)', proposalInput), acp)).toBe(false);
  expect(proposalAskAllowed(ask(undefined, 'anything', proposalInput), acp)).toBe(false);
  // an exact title with a non-proposal input: denied
  for (const title of ['use_tool', 'agents__project_propose', 'mcp__agents__project_propose']) {
    expect(proposalAskAllowed(ask('other', title, {}), acp)).toBe(false);
    expect(proposalAskAllowed(ask('other', title, {path: '/etc/hosts'}), acp)).toBe(false);
    expect(proposalAskAllowed(ask('other', title, {tool_name: 'agents__project_propose', input: {}}), acp)).toBe(false);
  }
  expect(proposalAskAllowed(ask('other', 'x', {...proposalInput, command: 'rm'}), acp)).toBe(false);
  // every kind but other, differently cased too: denied, whatever the input
  for (const kind of ['read', 'search', 'think', 'Execute', 'OTHER', 'edit', 'fetch', 'move', 'delete', 'execute', 'switch_mode', ''])
    expect(proposalAskAllowed(ask(kind, 'use_tool', proposalInput), acp)).toBe(false);
  expect(proposalAskAllowed(ask('read', 'use_tool', useTool, fuigo), acp)).toBe(false);
  expect(proposalAskAllowed(ask('other', 'use_tool', useTool, {namespace: 'fuigo_build', name: 'read_file', kind: 'read'}), acp)).toBe(false);
});
it('R8-3 on Fuigo and Grok Build the propose tool counts only on the per-turn Murage mount', () => {
  const alias = newProposalServerAlias();
  expect(alias).toMatch(/^murage-agents-[a-f0-9]{20}$/);
  expect(newProposalServerAlias()).not.toBe(alias);
  const mount = {acp: true, server: alias};
  const useTool = (server: string) => ({variant: 'UseTool', tool_name: `${server}__project_propose`, tool_input: proposalInput});
  expect(proposalAskAllowed(ask('other', 'use_tool', useTool(alias), fuigo), mount)).toBe(true);
  expect(proposalAskAllowed(ask('other', 'use_tool', useTool('agents'), fuigo), mount)).toBe(false);
  expect(proposalAskAllowed(ask('other', 'x', proposalInput, {namespace: 'mcp', name: 'agents__project_propose'}), mount)).toBe(false);
  expect(proposalAskAllowed(ask('other', 'x', proposalInput, {namespace: 'mcp', name: `${alias}__project_propose`}), mount)).toBe(true);
  for (const kind of ['fuigoAgent', 'grokAgent']) {
    const engine = proposalEngine(instance(kind, {agentsMcp: true}));
    expect(engine).toMatchObject({kind: 'turn', tool: {serverAlias: true}});
    expect(proposalToolCall(kind, alias)).toContain(`use_tool with tool_name "${alias}__project_propose"`);
  }
});
it('N2 an owner Codex config with its own "agents" server no longer matters: the Codex turn mounts no Murage server', () => {
  expect(proposalEngine(instance('codex', {agentsMcp: true}))).toEqual({kind: 'turn', tool: null});
});
it('R8-2 Codex and pi asks: only the propose call with a proposal input, by their drivers\' structured names', () => {
  const other = {acp: false, server: 'agents'};
  expect(proposalAskAllowed({requestType: 'permission', toolCall: {name: 'mcp__agents__project_propose', input: proposalInput}}, other)).toBe(true);
  expect(proposalAskAllowed({requestType: 'permission', toolCall: {name: 'mcp__agents__project_propose', input: {}}}, other)).toBe(true);
  expect(proposalAskAllowed({requestType: 'permission', toolCall: {name: 'mcp__agents__project_propose'}}, other)).toBe(false);
  expect(proposalAskAllowed({requestType: 'permission', toolCall: {name: 'shell', input: {command: 'cat /etc/hosts'}}}, other)).toBe(false);
  expect(proposalAskAllowed({requestType: 'permission', toolCall: {name: 'use_tool', input: {tool_name: 'agents__project_propose', input: proposalInput}}}, other)).toBe(false);
  expect(proposalAskAllowed({requestType: 'permission', questionTool: true, toolCall: {name: 'mcp__agents__project_propose', input: proposalInput}}, other)).toBe(false);
  expect(proposalAskAllowed({requestType: 'question', toolCall: {name: 'mcp__agents__project_propose', input: proposalInput}}, other)).toBe(false);
  expect(proposalAskAllowed({requestType: 'permission', toolCall: {name: 'mcp__agents__project_propose', input: proposalInput}}, {acp: false, server: 'murage-agents-0123456789abcdef0123'})).toBe(false);
});
it('R8-4 a refused ask leaves one redacted line: engine, tool kind, identity, never content', () => {
  const secret = 'cat ~/.ssh/id_ed25519 PURPOSE-TEXT /etc/hosts';
  const line = proposalAskRefusalLine({requestType: 'permission', toolKind: 'execute', toolCall: {name: secret, input: {command: secret}}}, 'fuigoAgent');
  expect(line).toBe('Chief proposal: an engine ask was denied (engine fuigoAgent, tool kind execute, identity none).');
  expect(proposalAskRefusalLine({requestType: 'permission', toolIdentity: {namespace: 'mcp', name: 'agents__x'}, toolCall: {name: 'x', input: {}}}, 'grokAgent')).toBe('Chief proposal: an engine ask was denied (engine grokAgent, tool kind none, identity mcp/agents__x).');
  // engine-supplied words are bounded to identifier characters
  expect(proposalAskRefusalLine({requestType: 'permission', toolKind: 'x y\nz', toolIdentity: {namespace: 'a b', name: 'c\nd'}}, 'codex')).toBe('Chief proposal: an engine ask was denied (engine codex, tool kind xyz, identity ab/cd).');
});

it('R9-3 a structurally named propose call is allowed whatever its input, so the server can say what to fix', () => {
  const alias = newProposalServerAlias(), mount = {acp: true, server: alias};
  const loose = {...proposalInput, name: 'Q3 report', brief: {summary: 's', doneMeans: 'd', rules: 'r', title: 'x'}};
  expect(proposalAskAllowed(ask('other', 'use_tool', {variant: 'UseTool', tool_name: `${alias}__project_propose`, tool_input: loose}, fuigo), mount)).toBe(true);
  expect(proposalAskAllowed(ask('other', 'x', loose, {namespace: 'mcp', name: `${alias}__project_propose`}), mount)).toBe(true);
  expect(proposalAskAllowed({requestType: 'permission', toolCall: {name: 'mcp__agents__project_propose', input: loose}}, {acp: false, server: 'agents'})).toBe(true);
  // still an object, still on this turn's mount, still the stamped use_tool shape
  expect(proposalAskAllowed(ask('other', 'use_tool', {variant: 'UseTool', tool_name: `${alias}__project_propose`, tool_input: 'cat /etc/hosts'}, fuigo), mount)).toBe(false);
  expect(proposalAskAllowed(ask('other', 'use_tool', {variant: 'UseTool', tool_name: 'agents__project_propose', tool_input: loose}, fuigo), mount)).toBe(false);
  expect(proposalAskAllowed({requestType: 'permission', toolCall: {name: 'mcp__agents__project_propose', input: 'x'}}, {acp: false, server: 'agents'})).toBe(false);
  // no identity: the strict shape stays
  expect(proposalAskAllowed(ask('other', 'use_tool', {tool_name: `${alias}__project_propose`, input: loose}), mount)).toBe(false);
});
it('R9-4 on Fuigo and Grok Build a tool that ran without an ask stops the proposal turn, judged by its stamp and kind', () => {
  const alias = newProposalServerAlias();
  const stamp = (namespace: string, name: string) => ({toolIdentity: {namespace, name}});
  for (const kind of ['fuigoAgent', 'grokAgent']) {
    // the catalog, use_tool and the propose call on this turn's mount run; Murage's own notices carry no kind
    for (const item of [{toolKind: 'read', ...stamp('fuigo_build', 'search_tool')}, {toolKind: 'other', ...stamp('fuigo_build', 'use_tool')}, {toolKind: 'other', ...stamp('mcp', `${alias}__project_propose`)}, {toolKind: 'other'}, {toolKind: 'think'}, {}])
      expect(proposalToolItemStops(kind, item, alias)).toBe(false);
    // a native tool, an owner server's tool, another Murage mount, a native kind without a stamp: stop
    for (const item of [{toolKind: 'read', ...stamp('fuigo_build', 'read_file')}, {toolKind: 'other', ...stamp('mcp', 'owner__search_tool')}, {toolKind: 'other', ...stamp('mcp', 'agents__project_propose')}, {toolKind: 'fetch', ...stamp('fuigo_build', 'web_fetch')}, {toolKind: 'other', ...stamp('other', 'use_tool')},
      {toolKind: 'read'}, {toolKind: 'search'}, {toolKind: 'execute'}, {toolKind: 'fetch'}, {toolKind: 'edit'}, {toolKind: 'switch_mode'}])
      expect(proposalToolItemStops(kind, item, alias)).toBe(true);
  }
  // pi's gate asks before every other tool and Murage refuses it: nothing runs to stop
  expect(proposalToolItemStops('piAgent', {toolKind: 'read'}, 'agents')).toBe(false);
});
it('R9-5 the hidden turn waits longer than the tools-off one-shot: an engine start, the agents server and an ask round trip', () => {
  expect(proposalSettings.turnTimeoutMs).toBe(90000);
});
it('N2 a tool the engine ran on its own leaves one line: engine and kind, never its input or title', async () => {
  const {proposalOwnToolLine} = await import('./project-proposal-engines.ts');
  expect(proposalOwnToolLine('opencodeGo', 'search')).toBe('Chief proposal: the engine ran a tool without asking (engine opencodeGo, tool kind search).');
  expect(proposalOwnToolLine('hermesAgent')).toBe('Chief proposal: the engine ran a tool without asking (engine hermesAgent, tool kind none).');
  expect(proposalOwnToolLine('x', 'read /etc/hosts; cat secret')).not.toMatch(/[ /;]hosts|secret\b.*;/);
});
