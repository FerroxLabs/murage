# Project audience English inventory

Audience producer and consumer owner: r2-owner-limit-projects.
Proposal fixture owner: r2-owner-limit-projects, succeeding new3-g2 for this fix.

| Literal | Audience and meaning |
| --- | --- |
| `stream budget` | Internal collector exhaustion diagnostic at the existing stream limit. |
| `MCP process exited before replying` | Test fixture rejection when the MCP child exits with an outstanding request. |
| `Your verdict on card … is already in.` | Reviewer tool refusal when the same review already recorded its verdict. |

The integration-base transcript projector also supplies `display widget field
budget`, an internal diagnostic for bounded widget projection. The existing
`mcp ${method} timed out` fixture diagnostic retains its original timeout.

The duplicate-verdict refusal is shown to the reviewer. Existing speaker-removal
and other refusal messages are reused; there are no new action labels or locale keys.
