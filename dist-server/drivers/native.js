// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: every provider-native message is
// written verbatim next to the canonical stream, so protocol drift can be
// diagnosed by diffing the two.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_DIR } from "../config.js";
import { redactSecrets } from "../redact.js";
export function appendNative(threadId, entry) {
    try {
        // The session-setup messages carry the credentials the agent is handed —
        // the box and comms tokens ride inside session/new's mcpServers env, and
        // an MCP header can carry a Composio key. These files are ordinary
        // 0644 files people paste into bug reports, so values are masked while
        // the shape stays intact.
        appendFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), JSON.stringify({ at: new Date().toISOString(), ...entry, msg: redactSecrets(entry.msg) }) + "\n", { mode: 0o600 });
    }
    catch {
        /* never let logging break a run */
    }
}
