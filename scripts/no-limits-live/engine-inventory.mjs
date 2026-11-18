// Read the candidate registry, without loading drivers or probing real accounts.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function discoverDrivers(root = ROOT) {
  const registry = readFileSync(resolve(root, 'server/drivers/builtIn.ts'), 'utf8');
  const imports = [...registry.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*["'](\.\/[^"']+)["']/g)];
  const list = registry.slice(registry.indexOf('= [') + 3).replace(/\/\/[^\n]*/g, '');
  return imports.filter(([, symbol]) => new RegExp(`\\b${symbol}\\b`).test(list)).map(([, symbol, path]) => {
    const source = `server/drivers/${path.slice(2)}`;
    const text = readFileSync(resolve(root, source), 'utf8');
    const driver = /driverKind:\s*["']([^"']+)/.exec(text)?.[1]
      ?? /(?:export\s+)?const DRIVER_KIND\s*=\s*["']([^"']+)/.exec(text)?.[1];
    if (!driver) throw Error(`Cannot inventory registered driver ${symbol}`);
    return { driver, source, symbol };
  });
}
const known = {
  claudeAgent: ['claude', 'claude'], codex: ['codex', 'codex'], fuigoAgent: ['fuigo', 'fuigo'],
  geminiAgent: ['gemini', 'gemini'], museCode: ['muse', 'muse'], openclawAgent: ['openclaw', 'openclaw'],
  antigravityAgent: ['antigravity', 'agy'], piAgent: ['pi', 'pi'], grokAgent: ['grok-build', 'grok'],
  grok: ['grok-api', null], 'openai-compat': ['openai-chat', null], minimax: ['minimax', null],
  copilotAgent: ['copilot', 'copilot'], qwenAgent: ['qwen', 'qwen'], kimiAgent: ['kimi', 'kimi'],
  droidAgent: ['droid', 'droid'], cursorAgent: ['cursor', 'agent'], clineAgent: ['cline', 'cline'],
  hermesAgent: ['hermes', 'hermes'], opencodeGo: ['opencode', 'opencode'], customAcp: ['custom-acp', null],
  boxAgent: ['box-agent', null],
};
export function shippedEngineSpecs(root = ROOT) {
  return [...discoverDrivers(root).map(item => {
    const [id, cli] = known[item.driver] ?? [item.driver, null];
    return { ...item, id, cli };
  }), { id: 'gpt-sol', cli: 'codex', driver: 'codex', source: 'server/drivers/codex.ts', sol: true }];
}
