// Canonical harness contracts — ported from upstream
// (apps/server/src/provider/ProviderDriver.ts, Services/ProviderAdapter.ts,
// packages/contracts/src/{provider,providerInstance,providerRuntime}.ts),
// de-Effect-ed: Promises instead of Effect, listener callbacks instead of
// Stream. The shapes and names are kept so the two codebases stay mutually
// readable.
export class ProviderError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = "ProviderError";
        this.code = code;
    }
}
/** Reasoning-effort levels, ascending. A union of everything any engine
 * accepts; each driver declares the subset its CLI will take. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];
/** Narrow untrusted API/config input before it becomes a model selection. */
export function isEffortLevel(value) {
    return typeof value === "string" && EFFORT_LEVELS.includes(value);
}
let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();
