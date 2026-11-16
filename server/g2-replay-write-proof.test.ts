// SPDX-License-Identifier: AGPL-3.0-or-later
// Provider-write caller and replay-proof owner: tri3-g2. Accepted-write helper owner: tri3-g7.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { source, wiring } from './decision-wiring/fixture.ts';
import { captureSendReplayProof, assertSendReplayProof } from './memory/replay-lineage.ts';
import { updateReceiptReplayProof } from './memory/receipt-replay-proof.ts';
import { SEND_ATTEMPT_SCHEMA_SQL, SendAttemptStore } from './send-attempt-state.ts';
import ts from 'typescript';
import vm from 'node:vm';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE messages(thread_id TEXT,id TEXT,json TEXT,PRIMARY KEY(thread_id,id));
    INSERT INTO messages VALUES('thread','replayed','{}'),('thread','current','{}'),('thread','copied','{}');`);
  db.exec(SEND_ATTEMPT_SCHEMA_SQL);
  const attempts = new SendAttemptStore(db);
  const attempt = attempts.create({ ownerId: 'owner', botId: 'bot', threadId: 'thread', sendId: 'send', fingerprint: 'fixture' });
  const prepared = captureSendReplayProof('thread', ['replayed'], new Map(), db);
  const state = { proof: captureSendReplayProof('thread', ['replayed'], new Map(), db) };
  // MAIN RULING INT-CONFLICT-DEFAULT 916dc0e974 / 1cda27c601c: the reviewed
  // owner credits the exact receipt write inside its real transaction adapter.
  attempts.transaction(() => updateReceiptReplayProof(db, state, ['current'], () => attempts.link(attempt.attemptId, 'current')));
  const { refreshPreparedReplayProof } = wiring(['refreshPreparedReplayProof'], {
    assertSendReplayProof: (proof: any) => assertSendReplayProof(proof, db),
    captureSendReplayProof: (thread: string, ids: string[], roots: any) => captureSendReplayProof(thread, ids, roots, db),
  });
  return { db, prepared, state, refreshPreparedReplayProof };
}

it.each(['new-attempt', 'replayed-line', 'changed-copy'])('rechecks the prepared replay itself at a provider write: %s', mode => {
  const { db, prepared, state, refreshPreparedReplayProof } = fixture();
  try {
    if (mode === 'replayed-line') db.exec("INSERT INTO send_replay_exclusions VALUES('thread','replayed',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='thread'");
    if (mode === 'changed-copy') {
      db.prepare("UPDATE messages SET json=? WHERE id='replayed'").run(JSON.stringify({ copyOf: { threadId: 'thread', messageIds: ['copied'] } }));
      db.exec("UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='thread'");
    }
    // An uncredited alias still refuses the epoch change, including an owned write.
    expect(() => assertSendReplayProof(prepared, db)).toThrow('SEND_REPLAY_CHANGED');
    if (mode === 'new-attempt') {
      const current = refreshPreparedReplayProof(state.proof);
      expect(current.epochs).toEqual([['thread', 1]]);
      expect(current.messageIds).toEqual(['replayed']);
      expect(current.excludedIds.size).toBe(0);
      expect(() => assertSendReplayProof(current, db)).not.toThrow();
    // MAIN RULING INT-CONFLICT-DEFAULT 916dc0e974 / 1cda27c601c: the primitive
    // now reports SEND_REPLAY_CHANGED; the real write callback normalizes it.
    } else expect(() => refreshPreparedReplayProof(state.proof)).toThrow('SEND_REPLAY_CHANGED');
  } finally { db.close(); }
});

it("an unwitnessed epoch bump is never credited as this send's receipt", () => {
  const { db, state, refreshPreparedReplayProof } = fixture();
  try {
    db.exec("INSERT INTO send_replay_exclusions VALUES('thread','unrelated',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='thread'");
    expect(() => refreshPreparedReplayProof(state.proof)).toThrow('SEND_REPLAY_CHANGED');
  } finally { db.close(); }
});

it('the production write callback admits an unchanged replay after the active attempt opens', () => {
  const { db, state, refreshPreparedReplayProof: current } = fixture();
  const replayProof = state.proof;
  try {
    const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let callback: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'submissionBoundary.alsoCheck'
        && node.arguments[0]?.getText(ast).includes('replayProof')) callback = node.arguments[0];
      ts.forEachChild(node, visit);
    };
    visit(ast); expect(callback).toBeDefined();
    const context = vm.createContext({ replayProof, freshReplay: {}, refreshPreparedReplayProof: current,
      assertSendReplayProof: (proof: any) => assertSendReplayProof(proof, db),
      directTurnClaimIsCurrent: () => true, bot: { id: 'bot' }, dispatchClaimId: 'generation', threadId: 'thread',
      directFencePreparing: true, directFencePreflight: false });
    vm.runInContext(ts.transpileModule(`globalThis.check = ${callback!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, context);
    expect(() => context.check()).not.toThrow();
    db.exec("INSERT INTO send_replay_exclusions VALUES('thread','replayed',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='thread'");
    expect(() => context.check()).toThrow('MEMORY_CONTEXT_REVOKED');
  } finally { db.close(); }
});
