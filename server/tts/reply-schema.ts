/** D24 metadata only. No source text, provider credential, URL, name or audio belongs here. */
import type { DatabaseSync } from "node:sqlite";
export function initializeReplySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS speech_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
    INSERT OR IGNORE INTO speech_clock VALUES(1,0);
    CREATE TABLE IF NOT EXISTS speech_threads (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS speech_prompts (thread_id TEXT NOT NULL, prompt_id TEXT NOT NULL, PRIMARY KEY(thread_id,prompt_id));
    CREATE TABLE IF NOT EXISTS speech_generations (
      generation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, prompt_id TEXT NOT NULL,
      revision INTEGER NOT NULL, boot_id TEXT NOT NULL, provider_turn_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('running','completed','invalid'))
    );
    CREATE INDEX IF NOT EXISTS speech_generation_provider ON speech_generations(thread_id,provider_turn_id,boot_id);
    CREATE INDEX IF NOT EXISTS speech_generation_bot ON speech_generations(bot_id,thread_id);
    CREATE INDEX IF NOT EXISTS speech_generation_bound ON speech_generations(bot_id,thread_id) WHERE provider_turn_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS speech_generation_running ON speech_generations(thread_id,provider_turn_id,boot_id) WHERE state='running';
    CREATE INDEX IF NOT EXISTS speech_generation_identity ON speech_generations(thread_id,provider_turn_id,boot_id,bot_id);
    CREATE INDEX IF NOT EXISTS speech_generation_unbound_done ON speech_generations(bot_id,thread_id) WHERE provider_turn_id IS NULL AND state<>'running';
    CREATE INDEX IF NOT EXISTS speech_generation_bound_done ON speech_generations(bot_id,thread_id) WHERE provider_turn_id IS NOT NULL AND state<>'running';
    CREATE TABLE IF NOT EXISTS speech_settlements (
      settlement_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, boot_id TEXT NOT NULL, settled_at INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome='completed')
    );
    CREATE TABLE IF NOT EXISTS speech_sessions (
      session_id TEXT PRIMARY KEY, principal TEXT NOT NULL, connection_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      boot_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','closed')), last_sequence INTEGER NOT NULL DEFAULT 0,
      active_attempt TEXT
    );
    CREATE INDEX IF NOT EXISTS speech_settlement_time ON speech_settlements(settled_at);
    CREATE INDEX IF NOT EXISTS speech_settlement_thread ON speech_settlements(thread_id,settled_at);
    CREATE INDEX IF NOT EXISTS speech_session_connection ON speech_sessions(connection_id,state);
    CREATE INDEX IF NOT EXISTS speech_session_closed ON speech_sessions(state) WHERE state='closed';
    CREATE INDEX IF NOT EXISTS speech_session_active ON speech_sessions(thread_id) WHERE state='active';
    CREATE TABLE IF NOT EXISTS speech_accounts (
      binding_id TEXT NOT NULL, credential_version TEXT NOT NULL, account_scope_id TEXT NOT NULL UNIQUE,
      plan_version TEXT NOT NULL, hold_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(binding_id,credential_version)
    );
    CREATE TABLE IF NOT EXISTS speech_plans (
      account_scope_id TEXT NOT NULL, fingerprint TEXT NOT NULL, plan_version TEXT NOT NULL UNIQUE,
      PRIMARY KEY(account_scope_id,fingerprint)
    );
    CREATE TABLE IF NOT EXISTS speech_attempts (
      attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, command_sequence INTEGER NOT NULL,
      thread_id TEXT NOT NULL, message_id TEXT NOT NULL, generation_id TEXT,
      mode TEXT NOT NULL CHECK(mode IN ('automatic','manual')), revision INTEGER NOT NULL, boot_id TEXT NOT NULL,
      reserved_at INTEGER NOT NULL, account_scope_id TEXT NOT NULL, plan_version TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','streaming','complete','failed','cancelled','interrupted')),
      outcome TEXT, UNIQUE(session_id,command_sequence)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS speech_automatic_claim ON speech_attempts(message_id) WHERE mode='automatic';
    CREATE INDEX IF NOT EXISTS speech_attempt_rate ON speech_attempts(reserved_at);
    CREATE INDEX IF NOT EXISTS speech_message_rate ON speech_attempts(message_id,reserved_at);
    CREATE INDEX IF NOT EXISTS speech_thread_active ON speech_attempts(thread_id,state);
    CREATE INDEX IF NOT EXISTS speech_attempt_live_session ON speech_attempts(session_id) WHERE state IN ('reserved','streaming');
    CREATE INDEX IF NOT EXISTS speech_attempt_terminal ON speech_attempts(reserved_at) WHERE state IN ('complete','failed','cancelled','interrupted');
    CREATE TABLE IF NOT EXISTS speech_commands (
      session_id TEXT NOT NULL, sequence INTEGER NOT NULL, status INTEGER NOT NULL, outcome TEXT NOT NULL,
      attempt_id TEXT, PRIMARY KEY(session_id,sequence)
    );
    CREATE INDEX IF NOT EXISTS speech_commands_pending ON speech_commands(outcome) WHERE outcome='pending';
    CREATE INDEX IF NOT EXISTS speech_commands_pending_attempt ON speech_commands(attempt_id) WHERE outcome='pending';
  `);
}
/** Removes the speech `send:` markers of owner sends being deleted, in the caller's transaction (design r5.1 P): each marker lives exactly as
 *  long as its owner_sends row. `"thread"` removes every prompt marker of a conversation that is being deleted. A database without the speech
 *  tables (a standalone SendStore) has nothing to remove. */
export function deleteSpeechSendMarkers(db: DatabaseSync, threadId: string, sendIds: ReadonlyArray<string | null | undefined> | "thread"): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='speech_prompts'").get()) return;
  if (sendIds === "thread") { db.prepare("DELETE FROM speech_prompts WHERE thread_id=?").run(threadId); return; }
  const remove = db.prepare("DELETE FROM speech_prompts WHERE thread_id=? AND prompt_id=?");
  for (const id of sendIds) if (id) remove.run(threadId, `send:${id}`);
}
