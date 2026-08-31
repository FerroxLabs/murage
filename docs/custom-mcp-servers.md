# Bring your own MCP servers

Give every capable engine extra tools by listing MCP servers in
`~/.openmausbot/config.json` — the same shape Claude Code and friends use:

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "@example/notes-mcp"],
      "env": { "NOTES_TOKEN": "…" }
    }
  }
}
```

Restart the app after editing. Every bot whose engine can mount MCP servers
(Claude, Codex, and all ACP engines — Grok, Gemini, Kimi, Droid, Cursor,
opencode, Qwen, Hermes, and `customAcp`) gets the tools on its next turn.

## Rules that keep this safe

- **Permission cards by default.** Custom servers are never pre-approved:
  on Claude their tools route through the permission broker into Allow/Deny
  cards; on Codex they keep the on-request approval policy; ACP engines
  relay the agent's own permission asks. Built-ins stay pre-quieted — only
  *your* servers ask.
- **Reserved names are refused** (`computer`, `agents`, `composio`,
  `browser`, `phone`, `dweb`, `ogb`, …) so a custom entry can never shadow
  a built-in tool surface. Names are lowercase letters/digits/`_`/`-`, max
  32 chars, starting with a letter.
- **One bad entry never takes the fleet down.** Invalid entries are skipped
  with a logged reason; the rest still mount.
- **Credentials stay off argv.** `env` values travel in the child
  environment (Codex argv carries env *names* only; Claude uses the private
  0600 mcp-config file; ACP passes them in the session payload with the
  wire log redacted). They do persist as plaintext in the 0600 config file —
  prefer tokens scoped to the one server.
- `"enabled": false` parks an entry without deleting it.
- Stdio servers only for now — `url` transports are a planned follow-up and
  are skipped with a note.
