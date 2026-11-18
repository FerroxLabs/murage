// SPDX-License-Identifier: AGPL-3.0-or-later
import { stripVTControlCharacters } from 'node:util';
import * as transcript from '../transcript-page.ts';
import { expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { join } from 'node:path';
import ts from 'typescript';
const base32 = (text: string) => {
    let bits = 0, value = 0, out = '';
    for (const byte of Buffer.from(text)) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += 'abcdefghijklmnopqrstuvwxyz234567'[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    return out + (bits ? 'abcdefghijklmnopqrstuvwxyz234567'[(value << (5 - bits)) & 31] : '');
};
import * as redact from '../redact.ts';
const poison = '**password**: boundary-private-value\nBOUNDARY_PRIVATE_TAIL';
const key = 'sk-' + 'q'.repeat(32);
function output(value: unknown) {
    const bytes = JSON.stringify(value);
    expect(bytes).toBeTruthy();
    expect(bytes).not.toMatch(/boundary-private-value|BOUNDARY_PRIVATE_TAIL/);
    expect(bytes).not.toContain(key);
}
// Execute the production output statement with an inert sink. No formatter or redactor is replaced.
function source(file: string) {
    return ts.createSourceFile(file, readFileSync(new URL('../../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
}
function nodes(file: ts.SourceFile, test: (node: ts.Node) => boolean) {
    const out: ts.Node[] = [];
    const visit = (node: ts.Node) => {
        if (test(node))
            out.push(node);
        ts.forEachChild(node, visit);
    };
    visit(file);
    return out;
}
function execute(code: string, bindings: Record<string, unknown>) {
    return new Function(...Object.keys(bindings), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText)(...Object.values(bindings));
}
export const extraSinkWitnesses: Record<string, () => unknown> = {
    'server/transcript-page.ts': async () => {
        const { wireThread } = await import('../transcript-page.ts');
        const result = wireThread({ threadNumbered: () => true, newestSeq: () => 7, messageSeq: () => 7 }, 'fixture', { message: { id: 'fixture', kind: 'text', role: 'bot', text: poison, seq: 7 } });
        expect(result.message.id).toBe('fixture');
        output(result);
    },
    'server/redact.ts': () => {
        output(redact.redactSecretsForSink(poison));
        output(redact.redactSecretsForCard({ password: 'boundary-private-value' }));
    },
    'server/tts/speech-source.ts': async () => {
        const { compileSpeechSource } = await import('../tts/speech-source.ts');
        expect(compileSpeechSource('Fixture introduction.')).toContain('Fixture introduction');
        const text = compileSpeechSource(poison);
        expect(text).toBe('The rest is on screen.');
        output(text);
    },
    'server/approval-text.ts': async () => {
        const { boundedToolInput } = await import('../approval-text.ts');
        const text = boundedToolInput({ fixture: 'kept', password: 'boundary-private-value' });
        expect(JSON.parse(text!)).toMatchObject({ fixture: 'kept' });
        output(text);
    },
    'server/approval-grant-request.ts': async () => {
        const { grantRequestFor } = await import('../approval-grant-request.ts');
        const result = grantRequestFor({ ask: { tool: 'mcp__composio__COMPOSIO_SEARCH_TOOLS', summary: 'Fixture', toolCall: { name: 'mcp__composio__COMPOSIO_SEARCH_TOOLS', input: { query: 'fixture', password: 'boundary-private-value' } } }, stopHit: null, inputCut: false } as any);
        expect(result?.rows).toHaveLength(1);
        output(result);
    },
    'server/routine-detail-line.ts': async () => {
        const { routineDetailEntries } = await import('../routine-detail-line.ts');
        const result = routineDetailEntries([{ name: poison, prompt: poison, botId: 'bot', enabled: true, schedule: { type: 'interval', everyMinutes: 30, anchorAt: 1 }, nextRunAt: null, createdAt: 1 }], 'bot', 'UTC');
        expect(result).toHaveLength(1);
        output(result);
    },
    'server/routine-permissions.ts': async () => {
        const { routineValueTargetLine } = await import('../routine-permissions.ts');
        const text = routineValueTargetLine([{ tool: poison, target: poison }] as any);
        expect(text).toContain('Ran without asking');
        output(text);
    },
    'server/refused-start.ts': async () => {
        const { recordRefusedStart } = await import('../refused-start.ts');
        const saved: unknown[] = [];
        recordRefusedStart({ appendMessage: (_thread, message) => {
                saved.push(message);
                return { ...message, id: 'fixture', at: 1 } as any;
            } }, 'thread', poison);
        expect(saved).toHaveLength(1);
        output(saved);
    },
    'server/working-context.ts': async () => {
        const { renderWorkingContext } = await import('../working-context.ts');
        const file = source('server/working-context.ts'), fn = nodes(file, node => ts.isFunctionDeclaration(node) && node.name?.text === 'clip');
        expect(fn).toHaveLength(1);
        const clipped = execute(fn[0].getText(file) + ';return clip(value);', { ...redact, value: poison, LINE_CHARS: 400 });
        const text = renderWorkingContext([clipped], [], []);
        expect(text).toContain("What I've been working on");
        output(text);
    },
    'server/browser-output-redaction.ts': async () => {
        const { redactPageOutput } = await import('../browser-output-redaction.ts');
        output(redactPageOutput(poison));
    },
    'server/drivers/agents-result.ts': async () => {
        const { boundedAgentResult } = await import('../drivers/agents-result.ts');
        const saved: string[] = [];
        const result = await boundedAgentResult(poison + 'x'.repeat(25000), async (text) => {
            saved.push(text);
            return { id: 'r-00000000-0000-4000-8000-000000000000' };
        });
        expect(saved).toHaveLength(1);
        output(saved);
        output(result);
    },
    'server/drivers/muse-code.ts': async () => {
        const { museToolOutput } = await import('../drivers/muse-code.ts');
        const result = museToolOutput({ status: 'failed', visibleOutput: poison, failureReason: poison } as any);
        expect(result.ok).toBe(false);
        expect(result.result).toBeTruthy();
        output(result);
    },
    'server/drivers/mcp-readiness.ts': async () => {
        const { acpMcpGateLine } = await import('../drivers/mcp-readiness.ts');
        const result = acpMcpGateLine({ mounted: [poison], required: [poison], optional: [], missing: [poison], standIn: [], reconnected: [], backedOff: [], states: new Map([[poison, 'unavailable']]), details: new Map() } as any);
        expect(result).toContain('mcp');
        output(result);
    },
    'server/engine-reply-check.ts': async () => {
        const { replyCheckFailure } = await import('../engine-reply-check.ts');
        const result = replyCheckFailure({ engineLine: 'Fixture ' + poison }, 'Fixture');
        expect(result.line).toContain('Fixture');
        output(result);
    },
    'server/image-delivery.ts': async () => {
        const { readImageEventStream } = await import('../image-delivery.ts');
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
                controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'error', error: { code: 'fixture', message: poison } }) + '\n\n'));
                controller.close();
            } });
        const result = await readImageEventStream(stream, { maxEventBytes: 1024, expected: 1 }).then(() => {
            throw Error('error frame accepted');
        }, error => error);
        expect(result).toBeInstanceOf(Error);
        output(result.message);
    },
    'server/image-generation.ts': async () => {
        const { imageFailureLogLine } = await import('../image-generation.ts');
        const line = imageFailureLogLine('fixture', poison, new Error(poison));
        expect(line).toContain('fixture');
        output(line);
    },
    'server/drivers/native.ts': async () => {
        const { NATIVE_DIR, ensureDirs } = await import('../config.ts');
        const { appendNative } = await import('../drivers/native.ts');
        ensureDirs();
        appendNative('boundary-native', { dir: 'in', source: 'fixture', msg: { type: 'runtime.error', message: poison } });
        const bytes = readFileSync(join(NATIVE_DIR, 'boundary-native.ndjson'), 'utf8');
        expect(bytes.trim()).toBeTruthy();
        output(bytes);
    },
    'server/drivers/openai-chat-tools.ts': async () => {
        const { chatToolCatalog } = await import('../drivers/openai-chat-tools.ts');
        const catalog = chatToolCatalog([{ server: 'fixture', tools: [{ name: 'fixture', description: poison, inputSchema: { type: 'object', properties: {} } }] }] as any, ['boundary-private-value', 'BOUNDARY_PRIVATE_TAIL']);
        expect(catalog.definitions).toHaveLength(1);
        output(catalog.definitions);
    },
    'server/procs.ts': () => {
        const file = source('server/procs.ts');
        const block = nodes(file, node => ts.isBlock(node) && node.statements.length === 3 && node.statements[0].getText(file).startsWith('seatbeltRefusalLogged.add(cli)'))[0];
        expect(block).toBeDefined();
        const logs: unknown[] = [];
        execute(block.getText(file), { ...redact, prefix: poison, cli: 'fixture', seatbeltRefusalLogged: new Set(), console: { warn: (value: unknown) => logs.push(value) } });
        expect(logs).toHaveLength(1);
        output(logs);
    },
    'server/image-operations.ts': async () => {
        const file = source('server/image-operations.ts');
        const call = nodes(file, node => ts.isCallExpression(node) && node.expression.getText(file) === 'this.store.appendMessage' && node.getText(file).includes('prompt:redactSecretsInText(prompt)'))[0];
        expect(call).toBeDefined();
        const logs: unknown[] = [];
        const { murageLine } = await import('../murage-line.ts');
        execute('const service={store:{appendMessage:(_thread,value)=>logs.push(value)}};' + call.getText(file).replace('this.store', 'service.store'), { ...redact, murageLine, logs, actor: { threadId: 'fixture' }, from: undefined, base: { basis: 'fixture' }, details: {}, imageApprovalSubtitle: () => 'Fixture', prompt: poison });
        expect(logs).toHaveLength(1);
        output(logs);
    },
    'server/drivers/acp/core.ts': () => {
        const file = source('server/drivers/acp/core.ts');
        const call = nodes(file, node => ts.isCallExpression(node) && node.expression.getText(file) === 'proc.owner.hooks.notice' && node.getText(file).includes('redactSecretsInText'))[0];
        expect(call).toBeDefined();
        const logs: unknown[] = [];
        execute(call.getText(file), { ...redact, stripVTControlCharacters, proc: { owner: { hooks: { notice: (value: unknown) => logs.push(value) } } }, line: 'Fixture ' + poison });
        expect(logs).toHaveLength(1);
        output(logs);
    },
    'server/auto-approve.ts': async () => {
        const { exactAllowKeyFor } = await import('../auto-approve.ts');
        expect(exactAllowKeyFor('Bash', 'echo fixture', { engine: 'fixture', cwd: '/fixture', command: 'echo ' + key })).toBeUndefined();
    },
    'server/done-when.ts': async () => {
        const { readDoneWhen, doneWhenBriefLine } = await import('../done-when.ts');
        const result = readDoneWhen('Use ' + key);
        expect(result).toEqual({ ok: true });
        output(doneWhenBriefLine(result.ok ? result.value : undefined));
    },
    'server/feedback-relay.ts': async () => {
        const { relayFeedback } = await import('../feedback-relay.ts');
        const bodies: unknown[] = [];
        const request = { surface: 'desktop', screen: 'today', title: 'Today', state: { page: 'general', gates: [] }, controls: [], words: "I couldn't find something on this screen.", createdAt: '2026-11-02T12:00:00.000Z' };
        const deps = { installId: () => 'fixture', fetch: async (_url: unknown, init: any) => {
                bodies.push(init.body);
                return new Response('{"ok":true,"id":"fixture"}');
            }, appVersion: '1.0.19', platform: 'linux' };
        const invalid = await relayFeedback({ ...request, words: poison } as any, deps as any);
        expect(invalid.sent).toBe(false);
        expect(bodies).toEqual([]);
        const valid = await relayFeedback(request as any, deps as any);
        expect(valid.sent).toBe(true);
        expect(bodies).toHaveLength(1);
        output(bodies);
    },
    'server/skills.ts': async () => {
        const { stageSkillWrite } = await import('../skills.ts');
        const result = stageSkillWrite('boundary-skill-bot', { action: 'create', gist: 'Fixture ' + key, source: 'conversation ' + key, files: [{ path: 'SKILL.md', content: '---\nname: boundary-skill\ndescription: Fixture\n---\nUse ' + key + ' safely.' }] });
        expect(result).not.toHaveProperty('error');
        output(result);
    },
    'server/drivers/lifecycle-diagnostic.ts': async () => {
        const { createLifecycleRecorder } = await import('../drivers/lifecycle-diagnostic.ts');
        const rows: unknown[] = [];
        const recorder = createLifecycleRecorder({ threadId: 'fixture', driver: 'grokAgent', instanceId: 'fixture', turnId: key, sink: (_thread, entry) => rows.push(entry) });
        recorder.record('spawn_requested');
        recorder.record('closed', { code: 0, signal: null });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ msg: { event: 'events_omitted' } });
        output(rows);
    },
    'server/drivers/codex-unsupported-calls.ts': async () => {
        const { rolloutMark, reportUnsupportedCalls } = await import('../drivers/codex-unsupported-calls.ts');
        const dir = mkdtempSync(join(tmpdir(), 'boundary-rollout-')), file = join(dir, 'rollout.jsonl'), logs: unknown[] = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation(value => {
            logs.push(value);
        });
        try {
            writeFileSync(file, '');
            const mark = rolloutMark(file, [dir]);
            appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'fixture', output: 'unsupported call: ' + key } }) + '\n');
            reportUnsupportedCalls('Fixture', mark, value => logs.push(value));
            expect(logs).toHaveLength(2);
            output(logs);
        }
        finally {
            warn.mockRestore();
            removeTempDirSync(dir);
        }
    },
    'server/flux-memory-capture.ts': async () => {
        const { FluxMemoryCapture } = await import('../flux-memory-capture.ts');
        const { setFluxExternalMemory } = await import('../flux-memory-envelope.ts');
        const { setFluxMemorySettings } = await import('../flux-memory-headers.ts');
        setFluxMemorySettings({});
        setFluxExternalMemory(undefined);
        const bodies: string[] = [];
        const capture = new FluxMemoryCapture({ key: () => 'fixture', threadCaptures: () => true, userText: () => poison, asksFirst: () => false, ledger: { noteUsed: () => ({ space: 'bot:' + 'a'.repeat(64), tag: 'd'.repeat(64) }), keyOff: () => false, setKeyOff() {
                }, accepted() {
                }, threadForgotten() {
                }, spaceGone() {
                }, limit() {
                } }, sleep: async () => {
            }, log() {
            }, fetch: (async (_url, init) => {
                bodies.push(String(init!.body));
                return new Response(null, { status: 202 });
            }) as typeof fetch });
        try {
            capture.begin({ threadId: 'boundary-capture', warmIdentity: { botId: 'bot', audience: 'owner', decidedOwner: true } });
            capture.observe({ type: 'item.completed', itemType: 'assistant_text', origin: 'engine', text: poison, threadId: 'boundary-capture' } as any);
            capture.observe({ type: 'turn.completed', ok: true, threadId: 'boundary-capture' } as any);
            await Promise.all([...capture.inflight]);
            expect(bodies).toHaveLength(1);
            output(bodies);
        }
        finally {
            setFluxMemorySettings({});
            setFluxExternalMemory(undefined);
        }
    },
    'server/move-in-found.ts': async () => {
        const { readGrokRosterNames } = await import('../move-in-found.ts');
        const cache = join('/fixture', '.config', 'Grok Bot', 'sand-client-persistence'), name = base32('sand.client.slice.account.fixture.roster.last-roster') + '.blob';
        const raw = JSON.stringify({ schemaVersion: 1, value: { rows: [{ name: 'Fixture' }, { name: 'api_key=' + key }] } });
        const names = readGrokRosterNames({ home: () => '/fixture', realDir: () => true, list: dir => dir === cache ? [name] : [], size: () => Buffer.byteLength(raw), read: () => raw });
        expect(names).toEqual(['Fixture']);
        output(names);
    },
    'server/project-memory-tools.ts': () => {
        const file = source('server/project-memory-tools.ts');
        const call = nodes(file, node => ts.isCallExpression(node) && node.expression.getText(file).endsWith('.run') && node.getText(file).includes('redactSecretsInText(body.text.trim())'))[0];
        expect(call).toBeDefined();
        const saved: unknown[][] = [];
        execute(call.getText(file), { ...redact, db: { prepare: () => ({ run: (...values: unknown[]) => saved.push(values) }) }, context: { groupId: 'fixture', botId: 'fixture', now: 1 }, version: 1, body: { text: poison }, sources: [] });
        expect(saved).toHaveLength(1);
        output(saved);
    },
    'server/routine-requests.ts': async () => {
        const {scheduleText}=await import('../routine-requests.ts');
        const file = source('server/routine-requests.ts');
        const funcs = nodes(file, node => ts.isFunctionDeclaration(node) && ['cardCopy', 'text'].includes(node.name?.text ?? ''));
        const card = funcs.find(node => (node as ts.FunctionDeclaration).name!.text === 'cardCopy')!;
        const result = execute(card.getText(file) + ';return cardCopy({action:"create",forBot:{id:"fixture",name:value}},{},"UTC",1);', { ...redact, value:poison, scheduleText, effectiveDefinition: () => ({name:poison,instructions:poison,schedule:{type:'interval',everyMinutes:30},runOn:'ember'}), ACTION_COPY: { create: { title: 'Create', detail: 'Create fixture' } }, nextForOperation: () => null });
        expect(result.title).toContain('Create');
        output(result);
        const text = funcs.find(node => (node as ts.FunctionDeclaration).name!.text === 'text')!;
        const hidden = execute(text.getText(file) + ';return text(value,"fixture",1000);', { ...redact, value: poison, RoutineRequestError: Error });
        output({ operation: { instructions: hidden } });
    },
    'server/loop-nudge.ts': async () => {
        const { consumingFixture } = await import('../testing/consuming-fixture.ts');
        const { createLoopNudge } = await import('../loop-nudge.ts');
        const fixture = consumingFixture({ audience: null }, { empty: true, threadId: 'boundary-loop' }), sent: unknown[] = [];
        const nudge = createLoopNudge({ watching: () => true, waitingOnHuman: () => false, stopping: () => false, generation: () => 'g', adapter: () => ({ capabilities: { queueing: true }, steer: async (_thread: string, text: string, beforeWrite?: () => void) => {
                    beforeWrite?.();
                    sent.push(text);
                    return true;
                } } as any), fence: () => ({ reader: { audience: null }, retained: fixture.turn, db: fixture.f.db }), record: thread => sent.push(thread), log: line => sent.push(line) });
        try {
            for (let i = 0; i < 5; i++) {
                nudge.observe({ type: 'item.started', provider: 'claude', createdAt: '2026-11-01T00:00:00Z', eventId: 'start-' + i, threadId: 'boundary-loop', turnId: 'turn', itemId: String(i), itemType: 'tool', origin: 'engine', title: 'Bash', input: { command: 'echo fixture' } } as any);
                await nudge.observe({ type: 'item.completed', provider: 'claude', createdAt: '2026-11-01T00:00:00Z', eventId: 'done-' + i, threadId: 'boundary-loop', turnId: 'turn', itemId: String(i), itemType: 'tool', ok: false, detail: poison } as any);
            }
            expect(sent.length).toBeGreaterThan(0);
            output(sent);
        }
        finally {
            fixture.close();
        }
    },
    'server/index.ts': async () => {
        const file = source('server/index.ts');
        const functions = nodes(file, node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildNotification');
        expect(functions).toHaveLength(1);
        const { buildNotification: buildRawNotification } = await import('../notify.ts');
        const result = execute(functions[0].getText(file) + ';return buildNotification("turn-failed",bot,"fixture",detail,{messageId:"message"});', { ...redact, ...transcript, buildRawNotification, bot: { id: 'fixture', name: 'Fixture' }, detail: poison });
        expect(result).toMatchObject({threadId:'fixture',messageId:'message'});
        output(result);
        const {channelReplyText} = await import('../draft-only.ts');
        const channels = nodes(file, node => ts.isReturnStatement(node) && Boolean(node.expression?.getText(file).startsWith('run ? { status: run.status, output: channelReplyText')));
        expect(channels).toHaveLength(5);
        for(const node of channels){
            const run = {status:'completed',botId:'fixture',output:poison,error:poison};
            const bytes = execute('return '+(node as ts.ReturnStatement).expression!.getText(file)+';', {...redact,...transcript,run,store:{bot:()=>({id:'fixture',name:'Fixture'})},channelReplyText,channelLimitNotice:()=>undefined,appToken:'fixture',botToken:'fixture'});
            expect(bytes.status).toBe('completed');output(bytes);expect(run.output).toBe(poison);
        }
        for(const marker of ['turn.retrying thread=','runtime.error thread=','[output-publication]',"[routines] a run's result",'could not get ready in','back after a failed setup','[setup-brief]']){
            const call = nodes(file, node => ts.isCallExpression(node) && /^console\.(info|warn|error)$/.test(node.expression.getText(file)) && node.getText(file).includes(marker));
            expect(call).toHaveLength(1);
            const logs:unknown[][]=[];
            const node=call[0], block=marker==='runtime.error thread='&&ts.isBlock(node.parent.parent)?node.parent.parent:node;
            execute(block.getText(file),{...redact,...transcript,console:{info:(...args:unknown[])=>logs.push(args),warn:(...args:unknown[])=>logs.push(args),error:(...args:unknown[])=>logs.push(args)},event:{threadId:'fixture',attempt:0,delayMs:10,reason:poison},audienceMasked:false,bot:{id:'fixture'},threadId:'fixture',raw:poison,error:new Error(poison),releaseError:new Error(poison),providerError:{engine:'fixture',kind:'limit',httpStatus:429,providerSaid:poison,providerTeam:'fixture'}});
            expect(logs).toHaveLength(1);output(logs);
        }
    }

};
