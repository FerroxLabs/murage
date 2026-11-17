# Driver cause-group English inventory

Owner: c3-drivers owns the Pi predecessor-closure refusal and this inventory.

| Source | Surface | Exact English string |
| --- | --- | --- |
| `server/drivers/pi.ts` | Retryable send refusal while the previous turn closes | Pi is still closing its last turn. Wait a moment and send again. |

The DeepSeek environment worker adds internal diagnostics `config timeout`,
`config worker exited`, `config probe busy` and `config worker stop unconfirmed`.
Destination resolution catches these and returns
the existing unknown-configuration refusal; they introduce no new UI copy.
