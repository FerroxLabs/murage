import { AntigravityDriver } from "./antigravity.js";
import { BoxAgentDriver } from "./boxagent.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { GrokDriver } from "./grok.js";
import { GrokAgentDriver } from "./acp/grok.js";
import { GeminiAgentDriver } from "./acp/gemini.js";
import { KimiAgentDriver } from "./acp/kimi.js";
import { DroidAgentDriver } from "./acp/droid.js";
import { OpenCodeGoDriver } from "./acp/opencode-go.js";
export const BUILT_IN_DRIVERS = [
    GrokDriver,
    GrokAgentDriver,
    GeminiAgentDriver,
    KimiAgentDriver,
    DroidAgentDriver,
    OpenCodeGoDriver,
    ClaudeDriver,
    CodexDriver,
    AntigravityDriver,
    BoxAgentDriver,
];
