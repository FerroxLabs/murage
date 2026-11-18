// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable evidence producer owner: c3-askapi. Observed-handle adapter/consumer owner: c4-misc-a.
import { DatabaseSync } from 'node:sqlite';
import { expect } from 'vitest';
import { questionsForCard } from '../../shared/questions.ts';

// Consumer-side action routing owner: c4-misc-c3; durable projection owner: c3-askapi.
const executionThreads = new WeakMap<object, string>();

/** Read execution evidence only for rows the isolated server actually displayed.
 * Display handles are asserted independently; execution ids never come from HTTP.
 * MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 3ad2b8f428: display copies omit native ids.
 */
export function fixtureMessageEvidence(path: string, displayed: any[]): any[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const read = db.prepare('SELECT thread_id,json FROM messages WHERE id=?');
    return displayed.map(display => {
      const row = read.get(display.id);
      if (!row) throw new Error('fixture displayed message has no durable row');
      const stored = JSON.parse(String(row.json));
      if (typeof row.thread_id === 'string') executionThreads.set(stored, row.thread_id);
      if (stored.card?.kind === 'own-write') {
        expect(display.card?.kind).toBe('own-write');
        expect(display.card?.requestId).toBe(stored.card.requestId);
        expect(display.card?.requestHandle).toBeUndefined();
      } else if (stored.card?.requestId) {
        expect(display.card?.requestId).toBeUndefined();
        // the public projection offers a question's own controls only for a stored `questions` list; a legacy shape stays an approval
        const questions = Array.isArray(stored.card.questions) ? questionsForCard(stored.card) : [];
        expect(display.card?.requestHandle).toBe(`${questions.length ? 'q' : 'p'}.${stored.id}`);
        if (questions.length) assertDisplayedQuestions(display.card?.questions, questions);
      }
      return stored;
    });
  } finally { db.close(); }
}

/** Each actionable HTTP control must agree with its displayed ordinal. Keep
 * the received bytes as the action source after checking the wire contract.
 */
function assertDisplayedQuestions(shown: any, questions: ReturnType<typeof questionsForCard>) {
  expect(Array.isArray(shown)).toBe(true);
  expect(shown.length).toBe(questions.length);
  questions.forEach((question, q) => {
    expect(shown[q].id).toBe(`q.${q}`);
    expect(shown[q].handle).toBe(`q.${q}`);
    expect(shown[q].questionHandle).toBe(`q.${q}`);
    expect(Array.isArray(shown[q].options)).toBe(true);
    expect(shown[q].options.length).toBe(question.options.length);
    question.options.forEach((_option, o) => expect(shown[q].options[o].handle).toBe(`o.${q}.${o}`));
  });
}

type ObservedCard = { stored: any; display: any };

/** Submit the same opaque action as the renderer, retaining native ids only in
 * the fixture's durable-evidence assertions. Invalid inputs remain invalid.
 */
export function fixtureDisplayReply(path: string, body: any, observed?: ObservedCard): any {
  if (!body?.requestId) return body;
  // Legacy direct callers still read durable evidence. The HTTP adapter passes
  // its observed presentation and identity snapshot, so submission never
  // invents controls from a later database read.
  const db = observed ? undefined : new DatabaseSync(path, { readOnly: true });
  try {
    const row = db?.prepare("SELECT json FROM messages WHERE json_extract(json,'$.card.requestId')=? ORDER BY rowid DESC LIMIT 1").get(body.requestId);
    if (!observed && !row) return body;
    const stored = observed?.stored ?? JSON.parse(String(row!.json)), questions = Array.isArray(stored.card.questions) ? questionsForCard(stored.card) : [];
    const { requestId: _id, behavior, answers, taskAllowKey: _key, ...transport } = body;
    if (!questions.length) return { requestHandle: observed?.display.requestHandle ?? `p.${stored.id}`, action: behavior, ...transport };
    return { requestHandle: observed?.display.requestHandle ?? `q.${stored.id}`, action: behavior === 'deny' ? 'skip' : behavior,
      ...(answers ? { answers: answers.map((answer: any) => {
        const index = questions.findIndex(question => question.id === answer.id);
        const shown = observed?.display.questions?.[index];
        return { questionHandle: observed ? (shown?.questionHandle ?? '') : `q.${index}`, optionHandles: (answer.selected ?? []).map((label: string) => {
          const option = questions[index]?.options.findIndex(option => option.label === label) ?? -1;
          return observed ? (shown?.options?.[option]?.handle ?? '') : `o.${index}.${option}`;
        }),
          ...(answer.other !== undefined ? { other: answer.other } : {}) };
      }) } : {}), ...transport };
  } finally { db?.close(); }
}

const executionRows = new WeakMap<object, any>();
/** Explicit durable plane for storage assertions on an actually displayed row.
 * It never promotes an unseen database row or changes the public view.
 */
export function fixtureExecutionMessage(view: object): any {
  const stored = executionRows.get(view);
  if (!stored) throw new Error('fixture row was not observed on HTTP');
  return stored;
}

type FixtureRequest = (method: string, route: string, body?: any, ...extra: any[]) => Promise<{ status: number; body: any }>;

/** Legacy behavioral assertions read durable evidence for actual displayed rows.
 * Public fields keep their projected values; only execution evidence is joined
 * into the legacy fixture view. Actions use a handle observed on HTTP.
 * An unknown or ambiguously reused native id never acquires a fresh handle.
 * MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 3ad2b8f428.
 */
export function fixtureDisplayApi<T extends FixtureRequest>(databasePath: () => string, request: T): T {
  let currentPath = '';
  const handles = new Map<string, Map<string, ObservedCard>>();
  return (async (method: string, route: string, body?: any, ...extra: any[]) => {
    const path = databasePath();
    if (path !== currentPath) { currentPath = path; handles.clear(); }
    let transport = body;
    const target = /^\/api\/threads\/([^/?]+)\/respond(?:\?|$)/.exec(route);
    const thread = target ? decodeURIComponent(target[1]) : undefined;
    const observed = thread && body?.requestId && handles.get(JSON.stringify([thread, body.requestId]));
    // MAIN RULING INT-CONFLICT-DEFAULT: preserve the original forged-key
    // legacy request byte-for-byte; never strip an attack while adapting it.
    const forgedLegacyKey = body && typeof body === 'object' && Object.hasOwn(body, 'taskAllowKey');
    const mixedProtocol = body && typeof body === 'object' && ['requestHandle', 'action'].some(key => Object.hasOwn(body, key));
    if (/\/respond(?:\?|$)/.test(route) && observed?.size === 1 && !forgedLegacyKey && !mixedProtocol) {
      transport = fixtureDisplayReply(path, body, observed.values().next().value);
      if (!observed.has(transport.requestHandle)) throw new Error('fixture response no longer matches its displayed handle');
    }
    const response = await request(method, route, transport, ...extra);
    if (method !== 'GET' || response.status !== 200 || !response.body || typeof response.body !== 'object') return response;
    const rows = (displayed: any[]) => {
      const stored = fixtureMessageEvidence(path, displayed);
      displayed.forEach((display, index) => {
        const native = stored[index].card?.kind === 'own-write' ? undefined : stored[index].card?.requestId;
        if (native && typeof display.card?.requestHandle === 'string') {
          const thread = executionThreads.get(stored[index]);
          expect(typeof thread, 'an observed action retains its durable thread').toBe('string');
          const key = JSON.stringify([thread, native]);
          const known = handles.get(key) ?? new Map<string, ObservedCard>();
          known.set(display.card.requestHandle, { stored: stored[index], display: structuredClone(display.card) });
          handles.set(key, known);
        }
      });
      return displayed.map((display, index) => {
        const native = stored[index].card;
        if (!native?.requestId || native.kind === 'own-write') { executionRows.set(display, stored[index]); return display; }
        const card = { ...display.card };
        for (const key of ['requestId', 'allowKey', 'allowKeys', 'exactAllowKey', 'taskAllowKey', 'routineAllowKey', 'riskReason']) {
          if (Object.hasOwn(native, key)) card[key] = native[key];
        }
        if (Array.isArray(native.questions) && native.questions.length) {
          const shown = display.card?.questions;
          expect(Array.isArray(shown) && shown.length).toBe(native.questions.length);
          card.questions = shown.map((question: any, q: number) => {
            const view: any = { id: native.questions[q].id };
            for (const key of ['question', 'header', 'multiSelect', 'allowOther', 'secret']) {
              if (Object.hasOwn(question, key)) view[key] = question[key];
            }
            if (Array.isArray(question.options)) view.options = question.options.map((option: any) => {
              const view: any = {};
              for (const key of ['label', 'description']) if (Object.hasOwn(option, key)) view[key] = option[key];
              return view;
            });
            return view;
          });
        }
        const view = { ...display, card };
        executionRows.set(view, stored[index]);
        return view;
      });
    };
    const evidence = (value: any) => ({ ...value,
      ...(Array.isArray(value.messages) ? { messages: rows(value.messages) } : {}),
      ...(Array.isArray(value.openCards) ? { openCards: rows(value.openCards) } : {}),
    });
    return { ...response, body: { ...evidence(response.body),
      ...(response.body.bot ? { bot: evidence(response.body.bot) } : {}),
      ...(Array.isArray(response.body.bots) ? { bots: response.body.bots.map(evidence) } : {}),
      ...(Array.isArray(response.body.groups) ? { groups: response.body.groups.map(evidence) } : {}),
    } };
  }) as T;
}
