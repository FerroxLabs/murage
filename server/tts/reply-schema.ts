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
    CREATE INDEX IF NOT EXISTS speech_session_connection ON speech_sessions(connection_id,state);
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
    CREATE TABLE IF NOT EXISTS speech_commands (
      session_id TEXT NOT NULL, sequence INTEGER NOT NULL, status INTEGER NOT NULL, outcome TEXT NOT NULL,
      attempt_id TEXT, PRIMARY KEY(session_id,sequence)
    );
    CREATE INDEX IF NOT EXISTS speech_commands_pending ON speech_commands(outcome) WHERE outcome='pending';
  `);
}
