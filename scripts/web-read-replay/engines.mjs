// Every shipped driver has an explicit lane. API-only/gateway lanes require
// gate configuration and stay UNVERIFIED; a missing binary never yields PASS.
export const engineSpecs = [
  ['claude', 'claudeAgent', 'claude'], ['codex', 'codex', 'codex'],
  ['sol-codex', 'codex', 'codex', true], ['sol-droid', 'droidAgent', 'droid', true],
  ['droid', 'droidAgent', 'droid'], ['fuigo', 'fuigoAgent', 'fuigo'],
  ['gemini', 'geminiAgent', 'gemini'], ['qwen', 'qwenAgent', 'qwen'],
  ['copilot', 'copilotAgent', 'copilot'], ['opencode', 'opencodeGo', 'opencode'],
  ['kimi', 'kimiAgent', 'kimi'], ['grok-agent', 'grokAgent', 'grok'],
  ['hermes', 'hermesAgent', 'hermes'], ['cursor', 'cursorAgent', 'cursor-agent'],
  ['cline', 'clineAgent', 'cline'], ['openclaw', 'openclawAgent', 'openclaw'],
  ['muse', 'museCode', 'muse'], ['pi', 'piAgent', 'pi'],
  ['antigravity', 'antigravityAgent', 'agy'], ['custom', 'customAcp', null],
  ['grok-chat', 'grok', null], ['openai-chat', 'openai-compat', null],
  ['minimax', 'minimax', null], ['box', 'boxAgent', null],
].map(([id, driver, cli, sol]) => ({ id, driver, cli, sol }));
