// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isAbsolute } from 'node:path';
import { writeFixture } from './fixture.mjs';

// Auth is an in-memory handoff from the gate rig, never a path to a real home.
// Keyring-only engines without an exportable subscription session must SKIP.
const files = {
  claude: ['.claude/.credentials.json'], codex: ['.codex/auth.json'],
  cursor: ['.cursor/auth.json', '.config/cursor/auth.json'],
  grok: ['.grok/auth.json'], fuigo: ['.fuigo/auth.json'],
  opencode: ['.local/share/opencode/auth.json'], antigravity: [],
};
function hasApiCredential(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    /api.?key/i.test(key) && Boolean(item) || key === 'type' && item === 'api' || hasApiCredential(item));
}
export function readGateConfig(raw) {
  if (!raw) return { engines: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.engines || typeof parsed.engines !== 'object' || Array.isArray(parsed.engines)) throw new Error();
    return parsed;
  } catch { throw new Error('INVALID-GATE-CONFIG'); }
}

export function subscriptionAuth(engine, config) {
  const auth = config?.auth;
  if (!auth || auth.source !== 'gate-signed-in-subscription') return null;
  const entries = Object.entries(auth.files ?? {});
  const env = Object.entries(auth.env ?? {});
  if (!entries.length && !env.length) return null;
  if (!files[engine] || entries.some(([name, data]) => !files[engine].includes(name) || typeof data !== 'string' || !data.trim()) ||
    env.some(([name, data]) => engine !== 'claude' || name !== 'CLAUDE_CODE_OAUTH_TOKEN' || typeof data !== 'string' || !data.trim())) throw new Error('INVALID-AUTH-HANDOFF');
  for (const [, data] of entries) {
    let parsed;
    try { parsed = JSON.parse(data); } catch { throw new Error('INVALID-AUTH-HANDOFF'); }
    if (!parsed || typeof parsed !== 'object' || !Object.keys(parsed).length || hasApiCredential(parsed)) throw new Error('INVALID-AUTH-HANDOFF');
    if (engine === 'opencode' && Object.values(parsed).some(provider => provider?.type !== 'oauth')) throw new Error('SUBSCRIPTION-AUTH-ONLY');
  }
  return { files: Object.fromEntries(entries), env: Object.fromEntries(env) };
}

export function installAuth(fixture, auth, env) {
  for (const [name, data] of Object.entries(auth.files)) writeFixture(fixture, `home/${name}`, data);
  Object.assign(env, auth.env);
}

export function binaryConfig(config) {
  // No shell command strings or .cmd shims: use a native executable, or node
  // with the absolute CLI .js as its sole prefix argument on Windows.
  if (!config || typeof config.command !== 'string' || !isAbsolute(config.command) || /\.(cmd|bat|ps1)$/i.test(config.command) ||
    config.args !== undefined && (!Array.isArray(config.args) || config.args.length > 1 || config.args.some(arg => typeof arg !== 'string' || !isAbsolute(arg) || !/\.[cm]?js$/i.test(arg)))) throw new Error('INVALID-ENGINE-BINARY');
  return { command: config.command, args: config.args ?? [] };
}
