// Display producer owner: l5a. Browser fixture consumer owner: c3-browser.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';
import { expect } from 'vitest';
import { questionsForCard } from '../../shared/questions.ts';

/** Read execution evidence only for rows the isolated server actually displayed.
 * Display handles are asserted independently; execution ids never come from HTTP.
 * MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 3ad2b8f428: display copies omit native ids.
 */
export function fixtureMessageEvidence(path: string, displayed: any[]): any[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const read = db.prepare('SELECT json FROM messages WHERE id=?');
    return displayed.map(display => {
      const row = read.get(display.id);
      if (!row) throw new Error('fixture displayed message has no durable row');
      const stored = JSON.parse(String(row.json));
      if (stored.card?.requestId) {
        expect(display.card?.requestId).toBeUndefined();
        expect(display.card?.requestHandle).toBe(`${questionsForCard(stored.card).length ? 'q' : 'p'}.${stored.id}`);
      }
      return stored;
    });
  } finally { db.close(); }
}

/** Submit the same opaque action as the renderer, retaining native ids only in
 * the fixture's durable-evidence assertions. Invalid inputs remain invalid.
 */
export function fixtureDisplayReply(path: string, body: any): any {
  if (!body?.requestId) return body;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT json FROM messages WHERE json_extract(json,'$.card.requestId')=? ORDER BY rowid DESC LIMIT 1").get(body.requestId);
    if (!row) return body;
    const stored = JSON.parse(String(row.json)), questions = questionsForCard(stored.card);
    const { requestId: _id, behavior, answers, taskAllowKey: _key, ...transport } = body;
    if (!questions.length) return { requestHandle: `p.${stored.id}`, action: behavior, ...transport };
    return { requestHandle: `q.${stored.id}`, action: behavior === 'deny' ? 'skip' : behavior,
      ...(answers ? { answers: answers.map((answer: any) => {
        const index = questions.findIndex(question => question.id === answer.id);
        return { questionHandle: `q.${index}`, optionHandles: (answer.selected ?? []).map((label: string) => `o.${index}.${questions[index]?.options.findIndex(option => option.label === label) ?? -1}`),
          ...(answer.other !== undefined ? { other: answer.other } : {}) };
      }) } : {}), ...transport };
  } finally { db.close(); }
}
