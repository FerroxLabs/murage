// Grok Build harness support — the official `grok` CLI over ACP stdio
// (`grok … agent stdio`), on the grok.com subscription login
// (~/.grok/auth.json), NOT the xAI API key (that driver is drivers/grok.ts).
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against grok 1.0.0.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAcpDriver } from "./core.js";
const support = {
    driverKind: "grokAgent",
    displayName: "Grok",
    // The CLI catalog is account-driven (`grok models` reports one today);
    // eventually read from the initialize result's _meta.modelState.
    models: { default: "grok-4.5", options: [{ id: "grok-4.5", label: "Grok 4.5" }] },
    defaultCli: "grok",
    nativeSource: "grok.acp",
    loginNote: "Grok CLI is not signed in — run `grok login` in a terminal",
    // --permission-mode must always be explicit: ~/.grok/config.toml may set
    // permission_mode = "always-approve", which would silently make every
    // session yolo and never fire session/request_permission.
    spawnArgs: (config, turn) => [
        "--permission-mode",
        config.fullAuto ? "bypassPermissions" : "default",
        ...(turn.model ? ["-m", turn.model] : []),
        "agent",
        "stdio",
    ],
    // The CLI owns its own grok.com login; a leaked API key silently flips
    // billing from the subscription to pay-as-you-go.
    transformEnv: (env) => {
        delete env.XAI_API_KEY;
    },
    // Bind the grok.com subscription login. No API-key fallback by design —
    // an unauthenticated CLI is a user action, not something to paper over.
    pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
    authFailure: "fail",
    isAuthenticated: () => existsSync(join(homedir(), ".grok", "auth.json")),
    // `--append-system-prompt`/`--rules` are accepted by the CLI but do NOT
    // reach the agent-stdio system prompt (verified against 1.0.0), so the
    // persona is prepended codex-style.
    buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};
export const GrokAgentDriver = createAcpDriver(support);
