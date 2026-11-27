<!-- Copyright 2026 Ferrox Labs; SPDX-License-Identifier: AGPL-3.0-or-later -->

# ACP recovery, steering and schema-budget English inventory

Owner: up21-engines owns the MCP schema guard and this inventory.

| Source | Surface | Exact English string |
| --- | --- | --- |
| `server/mcp-tool-schema.ts` | Refused tool call on an omitted Kimi MCP server | This server was left out because its tool schemas exceed Kimi’s size limit. |
| `server/mcp-tool-schema.ts` | Engine diagnostic explaining the omitted server | Murage left out one MCP server: its tool schemas exceed Kimi’s size limit. |

The guard forwards bounded, redacted child diagnostics with the internal `MCP:`
prefix. Its stream and catalog bounds report internal failure reasons rather
than new action labels. ACP steering consumes the peer's acknowledgements; they
are not added to the owner's transcript.
