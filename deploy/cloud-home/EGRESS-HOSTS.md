# Per-engine egress hosts (egress-allow.json)

Rules: exact hosts only, no wildcards (one approved exception: codex `*.oaiusercontent.com`, Codex image downloads, approved by Sean 2026-10-10), no telemetry/updater/registry/GitHub/CDN hosts. Guesses are never added to the JSON. `extra` stays empty. Researched 2026-10-03.

| Engine | Vendor CLI | Hosts | Source | Confidence |
|---|---|---|---|---|
| claudeAgent | Claude Code | api.anthropic.com, claude.ai, claude.com, platform.claude.com | https://code.claude.com/docs/en/network-config | documented |
| codex | OpenAI Codex CLI | *.oaiusercontent.com, api.openai.com, auth.openai.com, chatgpt.com | auth.openai.com: server/cloud-home/model-signin-device.ts:13 (device sign-in). OpenAI's agent-approvals-security page lists only api.openai.com, as a config example, not a requirement list | api.openai.com and auth.openai.com: from repo / partial; chatgpt.com: guess kept from existing entry (no citation found), confirm on a real VM |
| cursorAgent | Cursor CLI (cursor-agent) | api2.cursor.sh, api5.cursor.sh, agent/agentn.api5.cursor.sh, agent/agentn.us.api5.cursor.sh, agent/agentn.global.api5.cursor.sh, authenticate.cursor.sh, authentication.cursor.sh, prod.authentication.cursor.sh | https://cursor.com/docs/enterprise/network-configuration (API, agent, auth issuer hosts). Left out: Tab/codebase-search hosts, marketplace, cdn, downloads, authenticator (fallback UI), accounts.x.ai | documented host list; which subset the CLI needs is not stated, so this is the agent plus auth set |
| geminiAgent | Gemini CLI | cloudcode-pa.googleapis.com | https://docs.cloud.google.com/gemini/docs/codeassist/network-access (Code Assist endpoint, OAuth login path) | documented for API; sign-in token refresh (oauth2.googleapis.com) and API-key mode (generativelanguage.googleapis.com) are not in vendor docs, so NOT added: Gemini sessions may fail at token refresh until confirmed on a real VM |
| grokAgent | xAI Grok Build CLI | cli-chat-proxy.grok.com, auth.x.ai | xAI Enterprise Deployments doc (https://docs.x.ai/build/enterprise.md, seen via search snippet, direct fetch 404/timeout); auth.x.ai also server/cloud-home/model-signin-device.ts:13 | documented. api.x.ai is needed only for API-key auth (server/drivers/grok.ts:9) and is NOT added |
| kimiAgent | Kimi Code CLI | api.kimi.com, auth.kimi.ai, api.kimi.ai | https://www.kimi.com/en/help/kimi-code/cli-getting-started (base URL api.kimi.com/coding/v1); auth.kimi.ai OBSERVED 2026-10-15 on a staging rig (image b291c02b3): global `kimi login` OAuth device_authorization refused without it; api.kimi.ai per the CLI's global coding base (MurageMain source read), not yet exercised | measured; the device link the member opens is www.kimi.ai (browser side, not needed on the home) |
| opencodeGo | OpenCode (Go plan) | opencode.ai, models.opencode.ai | https://docs.opencode.ai/docs/go (base https://opencode.ai/zen/go/v1, API key from opencode.ai/auth); models.opencode.ai OBSERVED 2026-10-15 on a staging rig (image b291c02b3): refused at turn start (model catalogue fetch) | measured; key-authenticated call host to be re-measured after the OpenCode config fix |
| fuigoAgent | Fuigo (our router) | api.fluxrouter.ai | server/flux-routing.ts:25 | from repo |
| antigravity | Google Antigravity CLI | (none) | Google publishes no egress allowlist (antigravity.google/docs/enterprise) | no source, left empty |
| droidAgent | Factory Droid | (none) | docs.factory.com/cli/account/security lists no hosts; api.factory.ai would be a guess | guess, left empty |
| hermesAgent | Nous Hermes Agent | (none) | multi-provider; Nous Portal hosts not confirmed | guess, left empty |
| pi | Pi coding agent | (none) | multi-provider, host depends on chosen provider | left empty |
| qwenAgent | Qwen Code | (none) | only third-party sources for chat.qwen.ai/portal.qwen.ai/dashscope | guess, left empty |
| customAcp | user-defined | (none) | by design | n/a |

B2 note (2026-10-06): Claude Code also calls a Datadog intake (http-intake.logs.us5.datadoghq.com). It is deliberately NOT allowed; turns set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, DISABLE_TELEMETRY and DISABLE_ERROR_REPORTING so the refusal never stalls a turn. Proven on a fresh home by tools/b2/e2e-egress.py (lane dir).
