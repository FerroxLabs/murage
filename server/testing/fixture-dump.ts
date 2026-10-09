// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
export const fixtureCredentialFingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
/** Explicit driver assertion fields only. Credentials are fingerprints, never values. */
export function fixtureDumpEnvironment(): Record<string, string | undefined> {
  const plain = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_HEADERS", "OPENAI_BASE_URL", "MURAGE_USER_DATA", "MURAGE_BROWSER_CONNECTION", "MURAGE_CONNECTOR_UPSTREAM_URL", "FAKE_CLAUDE_MODE", "MURAGEBOX_BOX_ID", "CUSTOM_REJECTED_MARKER"];
  const credentials = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "BOX_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "FLUX_API_KEY", "MURAGEBOX_BOX_TOKEN", "MURAGE_COMMS_TOKEN", "MURAGE_FLUX_API_KEY", "MURAGE_LOCAL_UNSLOTH_API_KEY", "MURAGE_MCP_TOKEN", "MURAGE_MEMORY_TOKEN", "MURAGE_PROVIDER_API_KEY", "MURAGE_TTS_KEY", "MURAGE_VM_TOKEN", "MY_AGENT_TOKEN", "NOTES_TOKEN", "OPENAI_API_KEY", "OPENCODE_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY"];
  return Object.fromEntries([...plain.map(key => [key, process.env[key]]), ...credentials.map(key => [key, process.env[key] === undefined ? undefined : fixtureCredentialFingerprint(process.env[key]!)])]);
}

type DumpServers = Record<string, { env?: Record<string, string> } & Record<string, any>>;
/** A fake engine's dump with each MCP server's per-turn secrets put back into
 * its env, as the server's proxy resolves them this turn (a client spawned
 * from that env holds this turn's token, not the live file). The driver keeps
 * those tokens out of the mcp config (drivers/turn-credentials.ts) and the
 * fakes record the credential file's content beside it as `credFile`. */
export function withTurnSecrets<T>(dump: T): T {
  const d = dump as { mcpConfig?: { mcpServers?: DumpServers } | null; credFile?: { content?: unknown } | null } | null;
  const servers = d?.mcpConfig?.mcpServers;
  const content = d?.credFile?.content;
  if (!servers || !content || typeof content !== "object") return dump;
  const merged: DumpServers = {};
  for (const [name, server] of Object.entries(servers)) {
    const secrets = (content as Record<string, Record<string, string> | undefined>)[name];
    if (!secrets || !server?.env) { merged[name] = server; continue; }
    // the tokens inline, as a launcher without a credential file hands them
    const { MURAGE_CRED_FILE: _file, MURAGE_CRED_SERVER: _server, ...env } = server.env;
    merged[name] = { ...server, env: { ...env, ...secrets } };
  }
  return { ...d, mcpConfig: { ...d!.mcpConfig, mcpServers: merged } } as T;
}
